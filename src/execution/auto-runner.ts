import type { AppConfig, Priority } from '../config.js';
import type { TaskService } from '../domain/tasks.js';
import type { RunStore } from '../domain/runs.js';
import type { Runner } from './runner.js';

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

/**
 * The scheduler. When enabled, fills free run slots with ready tasks —
 * highest priority first, FIFO by creation time within a priority — up
 * to the configured maximum of concurrent runs. `poke()` whenever
 * something may have changed (task became ready, run finished, config
 * toggled); it coalesces and never re-enters.
 */
export class AutoRunner {
  private scheduled = false;

  constructor(
    private readonly taskService: TaskService,
    private readonly runStore: RunStore,
    private readonly runner: Runner,
    private readonly getConfig: () => AppConfig,
  ) {}

  poke(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      try {
        this.fill();
      } catch {
        // Filling is best-effort; the next poke retries.
      }
    });
  }

  private fill(): void {
    const { enabled, maxConcurrentRuns } = this.getConfig().autoRunner;
    if (!enabled) return;
    while (this.runStore.countRunning() < maxConcurrentRuns) {
      const next = this.pickNext();
      if (!next) return;
      this.runner.start(next);
    }
  }

  /** Highest priority first; FIFO (creation time, then id) within. */
  private pickNext(): number | undefined {
    const ready = this.taskService
      .list()
      .filter((t) => t.state === 'ready')
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.priority as Priority] - PRIORITY_RANK[b.priority as Priority] ||
          a.createdAt - b.createdAt ||
          a.id - b.id,
      );
    return ready[0]?.id;
  }
}
