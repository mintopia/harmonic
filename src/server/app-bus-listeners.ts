import type { FireAndForget } from '../error-handling.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { TaskService } from '../domain/tasks.js';
import type { AutoRunner } from '../execution/auto-runner.js';
import type { UpgradeCoordinator } from '../upgrade/upgrade-coordinator.js';
import type { Notifier } from '../notifications/notifier.js';
import type { EventBus } from './bus.js';

export function registerBusListeners(bus: EventBus, deps: {
  autoRunner: AutoRunner;
  upgrade: UpgradeCoordinator;
  publishWorktrees: () => Promise<void>;
  drainRetirement: () => Promise<number>;
  tasks: TaskService;
  attempts: AttemptStore;
  notifier: Notifier;
  fireAndForget: FireAndForget;
}): void {
  bus.on('attempt_changed', () => deps.autoRunner.poke());
  const reconcileUpgrade = (): void => deps.fireAndForget(() => deps.upgrade.reconcile(), { op: 'upgrade.reconcile', level: 'error' });
  const publishWorktrees = (): void => deps.fireAndForget(() => deps.publishWorktrees(), { op: 'worktrees.publish', level: 'debug' });
  bus.on('attempt_changed', reconcileUpgrade);
  bus.on('operations', reconcileUpgrade);
  bus.on('task_changed', publishWorktrees);
  bus.on('task_removed', publishWorktrees);
  bus.on('attempt_changed', () => {
    deps.fireAndForget(() => deps.drainRetirement(), { op: 'sessionRetirement.drain', level: 'warn' });
  });
  bus.on('attempt_changed', (run) => {
    if (run.state === 'running') return;
    deps.fireAndForget(
      async () => {
        if ((await deps.tasks.list({ state: 'ready' })).length !== 0) return;
        if ((await deps.attempts.countRunning()) === 0) await deps.notifier.notify('queue.idle');
      },
      { op: 'notifier.queueIdle', level: 'warn', context: { attemptId: run.id } },
    );
  });
}
