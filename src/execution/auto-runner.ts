import type { AppConfig, Priority } from '../config.js';
import type { TaskService } from '../domain/tasks.js';
import type { RunStore } from '../domain/runs.js';
import type { TaskRow, WorkspaceRow } from '../db/schema.js';
import { resolve, resolveCap } from '../domain/setting-override.js';
import type { Runner } from './runner.js';

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

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

  constructor(
    private readonly taskService: TaskService,
    private readonly runStore: RunStore,
    private readonly runner: Runner,
    private readonly getConfig: () => AppConfig,
    private readonly getWorkspaces: () => WorkspaceRow[],
    private readonly mirror?: MirrorClaim,
  ) {}

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
      this.runner.start(task.id);
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
   */
  private pickNext(
    skip: Set<number>,
    workspacesById: Map<number, WorkspaceRow>,
    runningByWorkspace: Map<number, number>,
    ceiling: number,
  ): TaskRow | undefined {
    return this.taskService
      .list()
      .filter((t) => {
        if (t.state !== 'ready' || t.drive === 'hitl' || skip.has(t.id)) return false;
        if (this.mirror?.foreignAssignee(t)) return false;
        const workspace = t.workspaceId != null ? workspacesById.get(t.workspaceId) : undefined;
        // Master is on (fill returned early otherwise), so an inheriting
        // Workspace (null) is enabled; only an explicit `false` opts out.
        if (!resolve(workspace?.autoRunnerEnabled, true)) return false;
        const cap = resolveCap(workspace?.maxConcurrentRuns, ceiling);
        const running = t.workspaceId != null ? (runningByWorkspace.get(t.workspaceId) ?? 0) : 0;
        return running < cap;
      })
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.priority as Priority] - PRIORITY_RANK[b.priority as Priority] ||
          a.createdAt - b.createdAt ||
          a.id - b.id,
      )[0];
  }
}
