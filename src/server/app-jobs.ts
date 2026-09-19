import type { Scheduler, ScheduledJobRegistration } from '../scheduler/scheduler.js';
import type { UpdateCheck } from '../upgrade/update-check.js';
import type { DistributionMode } from '../distribution-mode.js';
import type { TrackerPollerManager } from '../tracker/manager.js';
import type { AppOptions } from './app-context.js';

export function registerAppJobs(scheduler: Scheduler, deps: {
  registrations: ScheduledJobRegistration[] | undefined;
  metricsSummary: AppOptions['metricsSummary'];
  distributionMode: DistributionMode;
  updateCheck: UpdateCheck;
  drainRetirement: () => Promise<number>;
  reconcileWorktrees: (workspaceId?: number) => Promise<unknown>;
  trackerManager: TrackerPollerManager;
}): void {
  scheduler.register({
    name: 'Scheduled Job registry cleanup',
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => scheduler.prune(),
  });
  for (const registration of deps.registrations ?? []) scheduler.register(registration);
  if (deps.metricsSummary) {
    scheduler.register({
      name: 'Metrics summary',
      intervalMs: deps.metricsSummary.intervalMs,
      run: deps.metricsSummary.flush,
    });
  }
  if (deps.distributionMode === 'packaged') {
    scheduler.register({
      name: 'Update check',
      intervalMs: 60 * 60_000,
      runOnStart: true,
      run: () => deps.updateCheck.run(),
    });
  }
  scheduler.register({
    name: 'Session retirement drain',
    intervalMs: 5 * 60_000,
    run: async () => { await deps.drainRetirement(); },
  });
  scheduler.register({
    name: 'Worktree reconciliation',
    intervalMs: 30 * 60 * 1000,
    run: async () => { await deps.reconcileWorktrees(); },
  });
  scheduler.register({
    name: 'Epic reconcile',
    intervalMs: 60_000,
    run: () => deps.trackerManager.reconcileEpics(),
  });
}
