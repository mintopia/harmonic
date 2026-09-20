import { collectUsage, type AttemptUsage } from './usage.js';
import type { UsageSampler } from './usage-sampler.js';
import type { AppConfig } from '../config.js';
import { isTaskAttempt, type TaskRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { TaskService } from '../domain/tasks.js';
import { pricesForHarness } from '../domain/pricing.js';
import { reportFailure } from '../error-handling.js';

export interface UsageBackfillerDeps {
  attempts: AttemptStore;
  taskService: TaskService;
  getConfig: () => AppConfig;
  usage: UsageSampler;
  worktreePathForTask: (task: TaskRow) => string;
}

export class UsageBackfiller {
  constructor(private readonly deps: UsageBackfillerDeps) {}

  /**
   * Boot-time healing: finished runs whose stored usage has no per-model split
   * get one more read of the (now settled) session log. Stored ACP totals win
   * over re-derived ones.
   */
  async backfillUsage(): Promise<void> {
    const config = this.deps.getConfig();
    for (const run of (await this.deps.attempts.listUsageBackfillCandidates()).filter(isTaskAttempt)) {
      try {
        const task = await this.deps.taskService.get(run.taskId);
        const harness = config.harnesses[task.harness as keyof typeof config.harnesses];
        if (!harness) continue;
        // The worktree may be gone, but the harness's log path derives from the cwd string.
        const cwd = run.branch ? this.deps.worktreePathForTask(task) : task.workingDir;
        const fresh = collectUsage({
          harnessId: task.harness,
          harness,
          cwd,
          sessionId: run.sessionId,
        });
        if (!fresh || Object.keys(fresh.models).length === 0) continue;
        fresh.toolCalls = Object.fromEntries(await this.deps.usage.toolCallsFor(run.id));
        const stored = run.usage ? (JSON.parse(run.usage) as AttemptUsage) : null;
        const healed: AttemptUsage = stored?.totals
          ? { ...fresh, totals: stored.totals, source: 'combined' }
          : fresh;
        await this.deps.attempts.update(run.id, { usage: JSON.stringify(healed) });
      } catch (err) {
        reportFailure(err, {
          op: 'runner.backfillUsage',
          level: 'warn',
          context: { attemptId: run.id, taskId: run.taskId, sessionId: run.sessionId ?? undefined },
        });
      }
    }
    await this.deps.attempts.backfillCosts(async (attempt) => {
      if (!isTaskAttempt(attempt)) return pricesForHarness(config.harnesses.claude);
      const task = await this.deps.taskService.get(attempt.taskId);
      return pricesForHarness(config.harnesses[task.harness as keyof typeof config.harnesses] ?? config.harnesses.claude);
    });
  }
}
