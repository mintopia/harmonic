import type { AppConfig } from '../config.js';
import type { OrderedEligibleTask, TaskService } from '../domain/tasks.js';
import type { RunStore } from '../domain/runs.js';
import type { TaskRow, WorkspaceRow } from '../db/schema.js';
import { resolve, resolveCap } from '../domain/setting-override.js';
import { workContextKey } from '../domain/work-context-key.js';
import { repoKey } from './repo-lock.js';
import type { GitCircuitBreaker } from './git-failure.js';
import type { Runner } from './runner.js';
import { forEachYielding } from '../reliability/yield.js';

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

/** An integration base already assigned to an Epic member. If this ref is gone,
 * only the Epic reconcile can restore it; the scheduler gives that one pass,
 * then escalates rather than returning the member to a permanent retry loop. */
function hasAssignedEpicBase(task: TaskRow): boolean {
  return task.baseBranch?.startsWith('epic/') ?? false;
}

/**
 * Direct-mode Work Contexts occupied by an afk Run that is mid-flight (`running`)
 * or holding unreviewed work (`awaiting-review`), keyed by context to the Task
 * that holds it — the input to the House Rule pick predicate (ADR-0022, issue
 * #120). hitl Tasks (an operator drives them) and worktree Tasks (unique key per
 * Run) never occupy a context here. First holder found wins the key, so the skip
 * reason names a stable occupant.
 */
async function occupiedDirectContexts(tasks: readonly TaskRow[]): Promise<Map<string, TaskRow>> {
  const occupied = new Map<string, TaskRow>();
  await forEachYielding(tasks, (t) => {
    if (t.drive === 'hitl') return;
    if (t.state !== 'running' && t.state !== 'awaiting-review') return;
    const key = directContextKey(t);
    if (key && !occupied.has(key)) occupied.set(key, t);
  });
  return occupied;
}

/**
 * The tracker-facing hooks the Auto-Runner consults for mirrored afk Tasks
 * (issue #32); absent on a native-only server, where every ready Task is
 * pick-eligible as before.
 */
export interface MirrorClaim {
  /** Post-lock: advertise Harmonic's local claim without reading tracker ownership. */
  advertiseClaim(task: TaskRow): Promise<void>;
}

type RunLauncher = (taskId: Parameters<Runner['launchClaimed']>[0]) => Promise<unknown>;

export interface AutoRunnerOptions {
  mirror?: MirrorClaim;
  epicBaseNotReady?: (task: TaskRow) => boolean | Promise<boolean>;
  gitBreaker?: GitCircuitBreaker;
  /** Fixed scheduler cadence; tests inject a short interval. */
  intervalMs?: number;
  /** How long a confirmed absent assigned integration branch has to recover
   * through tracker reconciliation before the Task is escalated. */
  missingEpicBaseGraceMs?: number;
  /** Injected for deterministic scheduler-time tests. */
  clock?: () => number;
}

const DEFAULT_MISSING_EPIC_BASE_GRACE_MS = 60_000;

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
 * `drive ≠ hitl ∧ deps satisfied (ready)`, and the sequence is
 * flip(ready→running) — the lock — then best-effort advisory claim before
 * spawning (issues #32, #230, and #232). Assignment is never read as an
 * eligibility or ownership signal (ADR-0030).
 */
export class AutoRunner {
  private timer: NodeJS.Timeout | undefined;
  private scheduled = false;
  private filling = false;
  private refill = false;
  private readonly mirror: MirrorClaim | undefined;
  private readonly epicBaseNotReady: ((task: TaskRow) => boolean | Promise<boolean>) | undefined;
  private readonly gitBreaker: GitCircuitBreaker | undefined;
  private readonly intervalMs: number;
  private readonly missingEpicBaseGraceMs: number;
  private readonly clock: () => number;
  /**
   * Why a Task was not picked on the most recent scheduler pass, keyed by
   * Task id. Rebuilt from the local queue each pass, so the API reports the
   * condition holding now instead of a stale scheduling decision.
   */
  private readonly schedulerSkipReasons = new Map<number, string>();

  /** Assigned Epic bases that were missing on the preceding scheduler pass.
   * A null base is still awaiting its first reconcile and remains transient;
   * an assigned `epic/<ref>` that stays absent has no scheduler-side recovery. */
  private readonly missingEpicBaseSince = new Map<number, number>();

  /**
   * Epoch ms a Task first started being House-Rule-skipped on a still-current
   * streak, keyed by Task id (issue #125): the queue-diagnostics half of the
   * lease operator surface reads this (via {@link waitingSince}) to report how
   * long a blocked Task has been waiting on an occupied Work Context. Set the
   * first time a pick pass skips a Task and left alone on every subsequent
   * pass it's still skipped, so the clock reflects when the wait *began*, not
   * the last time it was observed; pruned in the same pass to any Task no
   * longer present in the freshly-rebuilt `schedulerSkipReasons` — the Task
   * started (or its blocker cleared) and a later wait starts a fresh clock.
   */
  private readonly contextWaitingSince = new Map<number, number>();

  constructor(
    private readonly taskService: TaskService,
    private readonly runStore: Pick<RunStore, 'countRunning' | 'countRunningByWorkspace'>,
    private readonly runner: { launchClaimed: RunLauncher },
    private readonly getConfig: () => AppConfig,
    private readonly getWorkspaces: () => Promise<WorkspaceRow[]>,
    options: AutoRunnerOptions = {},
  ) {
    this.mirror = options.mirror;
    this.epicBaseNotReady = options.epicBaseNotReady;
    this.gitBreaker = options.gitBreaker;
    this.intervalMs = options.intervalMs ?? 1_000;
    this.missingEpicBaseGraceMs = options.missingEpicBaseGraceMs ?? DEFAULT_MISSING_EPIC_BASE_GRACE_MS;
    this.clock = options.clock ?? Date.now;
  }

  /** Begin the DB-backed scheduler interval. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poke(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The latest scheduler reason for `taskId`, if it was not picked. */
  skipReasonFor(taskId: number): string | undefined {
    return this.schedulerSkipReasons.get(taskId);
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
        const workspacesById = new Map((await this.getWorkspaces()).map((w) => [w.id, w]));
        // Refresh before the capacity loop: a full machine never reaches
        // `pickNext`, but its queued Tasks still need to say why they wait.
        await this.refreshSkipReasons({ master, ceiling, workspacesById });
        if (!master) return;
        // Tasks parked this cycle because they are un-spawnable, so the
        // slow claim path can't spin re-picking the same one before a re-scan.
        const skip = new Set<number>();
        while ((await this.runStore.countRunning()) < ceiling) {
          // Recomputed each iteration: startPicked adds a running Run, so a
          // Workspace can reach its own cap mid-fill while the ceiling has room.
          const runningByWorkspace = await this.runStore.countRunningByWorkspace();
          const next = await this.pickNext(skip, workspacesById, runningByWorkspace, ceiling);
          if (!next) break;
          await this.startPicked(next, skip);
        }
        await this.refreshSkipReasons({ master, ceiling, workspacesById });
      } while (this.refill);
    } catch {
      // Filling is best-effort; the next poke retries.
    } finally {
      this.filling = false;
    }
  }

  /**
   * Claim one picked Task, then spawn it. The conditional DB claim is the local
   * ownership lock; only its winner may advertise a mirrored claim or launch.
   */
  private async startPicked(task: TaskRow, skip: Set<number>): Promise<void> {
    const claimed = await this.taskService.claimReady(task.id);
    if (!claimed) {
      skip.add(task.id);
      return;
    }
    this.schedulerSkipReasons.delete(task.id);
    this.contextWaitingSince.delete(task.id);
    this.missingEpicBaseSince.delete(task.id);
    if (claimed.origin === 'mirrored' && this.mirror) {
      try {
        await this.mirror.advertiseClaim(claimed);
      } catch {
        // Advisory claim failed — proceed; reconcile retries the assignment.
      }
    }
    try {
      await this.runner.launchClaimed(task.id);
    } catch {
      await this.taskService.setState(task.id, 'ready'); // couldn't spawn (e.g. bad harness) — don't strand it running
      skip.add(task.id);
    }
  }

  private recordSkipReason(taskId: number, reason: string): void {
    this.schedulerSkipReasons.set(taskId, reason);
  }

  /** The lease diagnostics clock applies only to waits that contend for a
   * Work Context, plus the existing git-workspace backoff. Other scheduler
   * explanations are intentionally current-state only. */
  private recordWaiting(taskId: number): void {
    if (!this.contextWaitingSince.has(taskId)) this.contextWaitingSince.set(taskId, Date.now());
  }

  /**
   * Rebuild the legible scheduler state for every waiting Task. This runs once
   * per scheduler pass, independently of whether the machine has a free slot,
   * so capacity and disabled-workspace waits cannot disappear behind the pick
   * loop's early exit.
   */
  private async refreshSkipReasons({
    master,
    ceiling,
    workspacesById,
  }: {
    master: boolean;
    ceiling: number;
    workspacesById: Map<number, WorkspaceRow>;
  }): Promise<void> {
    const [all, ordered, running, runningByWorkspace] = await Promise.all([
      this.taskService.list(),
      this.taskService.orderedEligibleWork(),
      this.runStore.countRunning(),
      this.runStore.countRunningByWorkspace(),
    ]);
    const orderedById = new Map<number, OrderedEligibleTask>();
    await forEachYielding(ordered, (task) => {
      orderedById.set(task.id, task);
    });
    const occupied = await occupiedDirectContexts(all);
    const missingThisPass = new Map<number, number>();
    this.schedulerSkipReasons.clear();

    await forEachYielding(all, async (task) => {
      if (task.state === 'blocked') {
        const blocker = orderedById.get(task.id)?.blockedBy[0];
        this.recordSkipReason(task.id, blocker === undefined ? 'blocked by a dependency' : `blocked-by #${blocker}`);
        return;
      }
      if (task.state !== 'ready') return;
      if (task.drive === 'hitl') {
        this.recordSkipReason(task.id, task.escalated ? 'hitl, escalated to human' : 'hitl');
        return;
      }
      if (!master) {
        this.recordSkipReason(task.id, 'Auto-Runner disabled');
        return;
      }
      const workspace = task.workspaceId == null ? undefined : workspacesById.get(task.workspaceId);
      if (!resolve(workspace?.autoRunnerEnabled, true)) {
        this.recordSkipReason(task.id, 'workspace disabled');
        return;
      }
      if (running >= ceiling) {
        this.recordSkipReason(task.id, 'at capacity');
        return;
      }
      const cap = resolveCap(workspace?.maxConcurrentRuns, ceiling);
      const workspaceRunning = task.workspaceId == null ? 0 : (runningByWorkspace.get(task.workspaceId) ?? 0);
      if (workspaceRunning >= cap) {
        this.recordSkipReason(task.id, 'at capacity');
        return;
      }
      if (this.gitBreaker && !this.gitBreaker.allows(repoKey(task.workingDir))) {
        this.recordSkipReason(task.id, 'git workspace-prep backoff (repeated failures on this repo)');
        this.recordWaiting(task.id);
        return;
      }
      if (await this.epicBaseNotReady?.(task)) {
        if (hasAssignedEpicBase(task)) {
          const since = this.missingEpicBaseSince.get(task.id) ?? this.clock();
          if (this.clock() - since >= this.missingEpicBaseGraceMs) {
            await this.taskService.escalate(task.id);
            this.recordSkipReason(task.id, 'integration branch missing, escalated to human');
            return;
          }
          missingThisPass.set(task.id, since);
        }
        this.recordSkipReason(task.id, 'integration branch missing');
        return;
      }
      const key = directContextKey(task);
      const holder = key ? occupied.get(key) : undefined;
      if (holder) {
        this.recordSkipReason(task.id, `Work Context held by task ${holder.id} (${holder.state})`);
        this.recordWaiting(task.id);
      }
    });
    this.missingEpicBaseSince.clear();
    await forEachYielding(missingThisPass, ([taskId, since]) => {
      this.missingEpicBaseSince.set(taskId, since);
    });
    await forEachYielding(this.contextWaitingSince.keys(), (taskId) => {
      if (!this.schedulerSkipReasons.has(taskId)) this.contextWaitingSince.delete(taskId);
    });
  }

  /**
   * DB-owned explicit priority, topological rank, then age. Skips hitl
   * Tasks and any parked this cycle. Also skips a Task
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
  private async pickNext(
    skip: Set<number>,
    workspacesById: Map<number, WorkspaceRow>,
    runningByWorkspace: Map<number, number>,
    ceiling: number,
  ): Promise<TaskRow | undefined> {
    const [all, ordered] = await Promise.all([
      this.taskService.list(),
      this.taskService.orderedEligibleWork(),
    ]);
    const occupied = await occupiedDirectContexts(all);
    // Parallel-Epic pick gate (issue #159, git ground-truth #231): a ready Epic
    // member isn't spawnable until its integration branch exists in git and its
    // base is set. The check hits git, so resolve it for the mirrored ready
    // candidates up front and read the verdicts in the sync filter below.
    // Transient (a reconcile cuts the branch and re-pokes), so it isn't recorded
    // as a wait-clock skip.
    const epicGate = new Map<number, boolean>();
    if (this.epicBaseNotReady) {
      const gate = this.epicBaseNotReady;
      await forEachYielding(all, async (t) => {
        // Same cheap exclusions the pick loop below applies, so a task that's
        // skipped or hitl doesn't cost a `branchExists` call.
        if (t.state === 'ready' && t.origin === 'mirrored' && t.drive !== 'hitl' && !skip.has(t.id)) {
          epicGate.set(t.id, await gate(t));
        }
      });
    }
    let picked: TaskRow | undefined;
    await forEachYielding(ordered, (t) => {
      if (picked || t.state !== 'ready' || t.drive === 'hitl' || skip.has(t.id)) return;
      if (epicGate.get(t.id)) return;
      const workspace = t.workspaceId != null ? workspacesById.get(t.workspaceId) : undefined;
      // Master is on (fill returned early otherwise), so an inheriting
      // Workspace (null) is enabled; only an explicit `false` opts out.
      if (!resolve(workspace?.autoRunnerEnabled, true)) return;
      const cap = resolveCap(workspace?.maxConcurrentRuns, ceiling);
      const running = t.workspaceId != null ? (runningByWorkspace.get(t.workspaceId) ?? 0) : 0;
      if (running >= cap) return;
        // Git-backoff skip (issue #199): a base repo whose workspace-prep git just
        // fast-failed is in an exponential-backoff window — pass its Tasks over so
        // the scheduler doesn't re-spawn git at fork-rate. Keyed on the base repo,
        // so a direct Run and a worktree Run colliding on the same repo share the
        // window. Recorded on the wait-clock so the block is legible to an operator.
      if (this.gitBreaker && !this.gitBreaker.allows(repoKey(t.workingDir))) {
        this.recordSkipReason(t.id, 'git workspace-prep backoff (repeated failures on this repo)');
        this.recordWaiting(t.id);
        return;
      }
      const key = directContextKey(t);
      const holder = key ? occupied.get(key) : undefined;
      if (holder) {
        this.recordSkipReason(t.id, `Work Context held by task ${holder.id} (${holder.state})`);
        this.recordWaiting(t.id);
        return;
      }
      picked = t;
    });
    // A Task no longer House-Rule-skipped this pass — started, or its
    // blocker cleared — resets its wait clock rather than carrying a stale
    // start time into a later, unrelated block.
    await forEachYielding(this.contextWaitingSince.keys(), (taskId) => {
      if (!this.schedulerSkipReasons.has(taskId)) this.contextWaitingSince.delete(taskId);
    });
    return picked;
  }
}
