import type { AppConfig, Priority } from '../config.js';
import type { TaskService } from '../domain/tasks.js';
import type { RunStore } from '../domain/runs.js';
import type { TaskRow, WorkspaceRow } from '../db/schema.js';
import { resolve, resolveCap } from '../domain/setting-override.js';
import { workContextKey } from '../domain/work-context-key.js';
import { repoKey } from './repo-lock.js';
import type { GitCircuitBreaker } from './git-failure.js';
import type { Runner } from './runner.js';

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

/**
 * The direct-mode Work Context identity a Task would occupy, or `undefined` in
 * worktree mode. Worktree Runs each get a unique per-Run path+branch (their key
 * is distinct by construction), so the "≤1 afk Run per context" House Rule is
 * vacuous there and those Tasks are exempt from the pick predicate (ADR-0022).
 * Direct-mode Tasks share one physical checkout, so their key is derivable from
 * the Task alone — no Run needed — and matches the canonical key the hard lease
 * acquires in `Runner.beginRun` (#118/#119), collapsing trailing-slash/symlink
 * variants of the same directory onto one identity.
 */
function directContextKey(task: TaskRow): string | undefined {
  if (task.isolationMode !== 'direct') return undefined;
  return workContextKey({ isolationMode: 'direct', workingDir: task.workingDir });
}

/**
 * Direct-mode Work Contexts occupied by an afk Run that is mid-flight (`running`)
 * or holding unreviewed work (`awaiting-review`), keyed by context to the Task
 * that holds it — the input to the House Rule pick predicate (ADR-0022, issue
 * #120). hitl Tasks (an operator drives them) and worktree Tasks (unique key per
 * Run) never occupy a context here. First holder found wins the key, so the skip
 * reason names a stable occupant.
 */
function occupiedDirectContexts(tasks: readonly TaskRow[]): Map<string, TaskRow> {
  const occupied = new Map<string, TaskRow>();
  for (const t of tasks) {
    if (t.drive === 'hitl') continue;
    if (t.state !== 'running' && t.state !== 'awaiting-review') continue;
    const key = directContextKey(t);
    if (key && !occupied.has(key)) occupied.set(key, t);
  }
  return occupied;
}

/**
 * The tracker-facing hooks the Auto-Runner consults for mirrored afk Tasks
 * (issue #32); absent on a native-only server, where every ready Task is
 * pick-eligible as before.
 */
export interface MirrorClaim {
  /** Live pick filter: a mirrored Task carrying an assignee Harmonic didn't place is skipped. */
  foreignAssignee(task: TaskRow): boolean;
  /** Pre-spawn: readTicket recheck + advisory claim. 'yield' if a human grabbed it since the last scan. */
  recheckAndClaim(task: TaskRow): Promise<'spawn' | 'yield'>;
}

/**
 * The scheduler. When enabled, fills free run slots with ready tasks —
 * highest priority first, FIFO by creation time within a priority. `poke()`
 * whenever something may have changed (task became ready, run finished, config
 * toggled); it coalesces and never re-enters.
 *
 * Concurrency is two-level (ADR-0012, issue #60): the global **Machine
 * Ceiling** (`config.autoRunner.maxConcurrentRuns`) caps total concurrent Runs
 * across all Workspaces, and each Workspace has its own cap clamped to the
 * ceiling — so per-Workspace caps summing higher than the ceiling still can't
 * breach it. Enable is gated too: a Task runs only if `master ∧ workspace
 * enabled`, where `master` is the global switch and the per-Workspace enable
 * inherits it when unset.
 *
 * A mirrored afk Task's pick is more than a spawn: the predicate is
 * `drive ≠ hitl ∧ deps satisfied (ready) ∧ no foreign assignee`, and the
 * sequence is flip(ready→running) — the lock — then readTicket recheck and
 * advisory claim before spawning (issue #32).
 */
export class AutoRunner {
  private scheduled = false;
  private filling = false;
  private refill = false;
  /**
   * Why a ready Task was passed over on the most recent pick pass, keyed by
   * Task id (ADR-0022, issue #120). Today the only entry is the House Rule
   * skip — a Task whose direct-mode Work Context is held by a running or
   * awaiting-review afk Run. The Task stays `ready` and returns to the frontier
   * next cycle; this map is the legible-skip surface an operator / the queue
   * diagnostics can read to tell a blocked queue apart from a silent stall.
   * Rebuilt each pick pass, so it reflects the current frontier, not history.
   */
  private readonly contextSkipReasons = new Map<number, string>();

  /**
   * Epoch ms a Task first started being House-Rule-skipped on a still-current
   * streak, keyed by Task id (issue #125): the queue-diagnostics half of the
   * lease operator surface reads this (via {@link waitingSince}) to report how
   * long a blocked Task has been waiting on an occupied Work Context. Set the
   * first time a pick pass skips a Task and left alone on every subsequent
   * pass it's still skipped, so the clock reflects when the wait *began*, not
   * the last time it was observed; pruned in the same pass to any Task no
   * longer present in the freshly-rebuilt `contextSkipReasons` — the Task
   * started (or its blocker cleared) and a later wait starts a fresh clock.
   */
  private readonly contextWaitingSince = new Map<number, number>();

  constructor(
    private readonly taskService: TaskService,
    private readonly runStore: RunStore,
    private readonly runner: Runner,
    private readonly getConfig: () => AppConfig,
    private readonly getWorkspaces: () => WorkspaceRow[],
    private readonly mirror?: MirrorClaim,
    /**
     * Pick gate for parallel-Epic members (issue #159): true while a mirrored
     * Task is an Epic member not yet safe to fork a worktree from — its
     * integration-branch base is unresolved (the reconcile hasn't set it), or set
     * to an `epic/<ref>` branch the poll hasn't confirmed live (never cut, or
     * transiently gone after a restart/retire). Skips it — without this, the
     * mirror insert's `ready` poke could spawn the member before its base is
     * resolved, forking it from the working dir's branch instead of `epic/<ref>`,
     * or off a missing integration branch. The same gate the Runner's start funnel
     * consults, so hand-started and auto-picked members are held identically.
     * Absent (native-only server / no live poll loop) ⇒ never gated.
     */
    private readonly epicBaseNotReady?: (task: TaskRow) => boolean,
    /**
     * The per-context git circuit breaker (issue #199), shared with the Runner
     * that records failures into it. A ready Task whose base repo is in a git
     * backoff window is passed over — so a context whose workspace-prep keeps
     * fast-failing isn't re-picked (and re-spawning git) on the next tick.
     * Absent → no git-backoff skip (native-only / test servers).
     */
    private readonly gitBreaker?: GitCircuitBreaker,
  ) {}

  /**
   * The reason a ready Task was skipped on the last pick pass, or `undefined` if
   * it was eligible (or not seen). Naming the occupying Task, this lets the
   * operator surface explain why a `ready` Task hasn't started (issue #120).
   */
  skipReasonFor(taskId: number): string | undefined {
    return this.contextSkipReasons.get(taskId);
  }

  /** When `taskId` started its current House-Rule-blocked streak (issue
   * #125), or `undefined` if it isn't currently blocked (or hasn't been seen).
   * The lease queue-diagnostics surface's "how long has this been waiting"
   * signal. */
  waitingSince(taskId: number): number | undefined {
    return this.contextWaitingSince.get(taskId);
  }

  poke(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.fill();
    });
  }

  private async fill(): Promise<void> {
    // The claim step awaits the tracker, so a poke arriving mid-fill can't just
    // re-enter; mark it and loop once more instead of dropping it.
    if (this.filling) {
      this.refill = true;
      return;
    }
    this.filling = true;
    try {
      do {
        this.refill = false;
        // `enabled` is the fleet-wide master switch; `maxConcurrentRuns` the
        // Machine Ceiling. Master off ⇒ nothing runs, whatever a Workspace enable says.
        const { enabled: master, maxConcurrentRuns: ceiling } = this.getConfig().autoRunner;
        if (!master) return;
        const workspacesById = new Map(this.getWorkspaces().map((w) => [w.id, w]));
        // Tasks parked this cycle (yielded to a human, or un-spawnable) so the
        // slow claim path can't spin re-picking the same one before a re-scan.
        const skip = new Set<number>();
        while (this.runStore.countRunning() < ceiling) {
          // Recomputed each iteration: startPicked adds a running Run, so a
          // Workspace can reach its own cap mid-fill while the ceiling has room.
          const runningByWorkspace = this.runStore.countRunningByWorkspace();
          const next = this.pickNext(skip, workspacesById, runningByWorkspace, ceiling);
          if (!next) break;
          await this.startPicked(next, skip);
        }
      } while (this.refill);
    } catch {
      // Filling is best-effort; the next poke retries.
    } finally {
      this.filling = false;
    }
  }

  /**
   * Start one picked Task. Native: flip + spawn atomically (unchanged). Mirrored
   * afk: flip (the lock) → recheck → advisory claim → spawn, awaited so the run
   * exists before the loop re-checks the slot count.
   */
  private async startPicked(task: TaskRow, skip: Set<number>): Promise<void> {
    if (task.origin !== 'mirrored' || !this.mirror) {
      try {
        this.runner.start(task.id);
      } catch {
        // Work Context busy (or another start failure): leave the Task ready and
        // skip it this cycle; a later poke retries once the occupant settles.
        skip.add(task.id);
      }
      return;
    }
    this.taskService.setState(task.id, 'running'); // the local lock, before any tracker write
    let decision: 'spawn' | 'yield';
    try {
      decision = await this.mirror.recheckAndClaim(this.taskService.get(task.id));
    } catch {
      decision = 'spawn'; // readTicket/claim failed — proceed; reconcile retries the assignment
    }
    if (decision === 'yield') {
      this.taskService.setState(task.id, 'ready'); // a human grabbed it — back to the frontier
      skip.add(task.id);
      return;
    }
    try {
      this.runner.launchClaimed(task.id);
    } catch {
      this.taskService.setState(task.id, 'ready'); // couldn't spawn (e.g. bad harness) — don't strand it running
      skip.add(task.id);
    }
  }

  /**
   * Highest priority first; FIFO (creation time, then id) within. Skips hitl and
   * foreign-claimed mirrored Tasks, and any parked this cycle. Also skips a Task
   * whose Workspace is Auto-Runner-disabled (master is already on here, so an
   * inheriting Workspace counts as enabled) or already at its resolved cap — the
   * per-Workspace half of the two-level limit (ADR-0012, issue #60).
   *
   * Finally, the House Rule (ADR-0022, issue #120): skip a Task whose direct-mode
   * Work Context is already occupied by a running or awaiting-review afk Run, so
   * the Auto-Runner doesn't pick straight into the hard lease rejection from #119
   * (churn) and the blocked Task carries a legible reason. This predicate is
   * advisory — the lease CAS in `Runner.beginRun` stays the authoritative gate —
   * and it reads occupancy from **Task state**, not the lease store: the lease is
   * released the moment a Run settles (seam for #114), so by the time a Task sits
   * in `awaiting-review` the lease is already gone, yet its work still holds the
   * context. Occupancy is recomputed each pass, so a Task started earlier this
   * fill correctly blocks a same-context sibling picked later.
   */
  private pickNext(
    skip: Set<number>,
    workspacesById: Map<number, WorkspaceRow>,
    runningByWorkspace: Map<number, number>,
    ceiling: number,
  ): TaskRow | undefined {
    const all = this.taskService.list();
    const occupied = occupiedDirectContexts(all);
    this.contextSkipReasons.clear();
    const picked = all
      .filter((t) => {
        if (t.state !== 'ready' || t.drive === 'hitl' || skip.has(t.id)) return false;
        if (this.mirror?.foreignAssignee(t)) return false;
        // Parallel-Epic pick gate (issue #159): a ready Epic member isn't
        // spawnable until this poll's reconcile has cut its integration branch
        // (and confirmed it live) and set its base. Transient (the reconcile
        // sets it within the same poll and re-pokes), so it isn't recorded as a
        // wait-clock skip.
        if (this.epicBaseNotReady?.(t)) return false;
        const workspace = t.workspaceId != null ? workspacesById.get(t.workspaceId) : undefined;
        // Master is on (fill returned early otherwise), so an inheriting
        // Workspace (null) is enabled; only an explicit `false` opts out.
        if (!resolve(workspace?.autoRunnerEnabled, true)) return false;
        const cap = resolveCap(workspace?.maxConcurrentRuns, ceiling);
        const running = t.workspaceId != null ? (runningByWorkspace.get(t.workspaceId) ?? 0) : 0;
        if (running >= cap) return false;
        // Git-backoff skip (issue #199): a base repo whose workspace-prep git just
        // fast-failed is in an exponential-backoff window — pass its Tasks over so
        // the scheduler doesn't re-spawn git at fork-rate. Keyed on the base repo,
        // so a direct Run and a worktree Run colliding on the same repo share the
        // window. Recorded on the wait-clock so the block is legible to an operator.
        if (this.gitBreaker && !this.gitBreaker.allows(repoKey(t.workingDir))) {
          this.contextSkipReasons.set(t.id, 'git workspace-prep backoff (repeated failures on this repo)');
          if (!this.contextWaitingSince.has(t.id)) this.contextWaitingSince.set(t.id, Date.now());
          return false;
        }
        const key = directContextKey(t);
        const holder = key ? occupied.get(key) : undefined;
        if (holder) {
          this.contextSkipReasons.set(
            t.id,
            `Work Context held by task ${holder.id} (${holder.state})`,
          );
          if (!this.contextWaitingSince.has(t.id)) this.contextWaitingSince.set(t.id, Date.now());
          return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.priority as Priority] - PRIORITY_RANK[b.priority as Priority] ||
          a.createdAt - b.createdAt ||
          a.id - b.id,
      )[0];
    // A Task no longer House-Rule-skipped this pass — started, or its
    // blocker cleared — resets its wait clock rather than carrying a stale
    // start time into a later, unrelated block.
    for (const taskId of [...this.contextWaitingSince.keys()]) {
      if (!this.contextSkipReasons.has(taskId)) this.contextWaitingSince.delete(taskId);
    }
    return picked;
  }
}
