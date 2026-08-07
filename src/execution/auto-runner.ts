import type { AppConfig, Priority } from '../config.js';
import type { TaskService } from '../domain/tasks.js';
import type { RunStore } from '../domain/runs.js';
import type { TaskRow } from '../db/schema.js';
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
 * highest priority first, FIFO by creation time within a priority — up
 * to the configured maximum of concurrent runs. `poke()` whenever
 * something may have changed (task became ready, run finished, config
 * toggled); it coalesces and never re-enters.
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
        const { enabled, maxConcurrentRuns } = this.getConfig().autoRunner;
        if (!enabled) return;
        // Tasks parked this cycle (yielded to a human, or un-spawnable) so the
        // slow claim path can't spin re-picking the same one before a re-scan.
        const skip = new Set<number>();
        while (this.runStore.countRunning() < maxConcurrentRuns) {
          const next = this.pickNext(skip);
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
   * foreign-claimed mirrored Tasks, and any parked this cycle.
   */
  private pickNext(skip: Set<number>): TaskRow | undefined {
    return this.taskService
      .list()
      .filter(
        (t) =>
          t.state === 'ready' &&
          t.drive !== 'hitl' &&
          !skip.has(t.id) &&
          !this.mirror?.foreignAssignee(t),
      )
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.priority as Priority] - PRIORITY_RANK[b.priority as Priority] ||
          a.createdAt - b.createdAt ||
          a.id - b.id,
      )[0];
  }
}
