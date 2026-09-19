import { logger } from '../logger.js';
import { fireAndForget } from '../error-handling.js';
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
}): void {
  bus.on('attempt_changed', () => deps.autoRunner.poke());
  bus.on('attempt_changed', () => { void deps.upgrade.reconcile().catch((error: unknown) => logger.error(`upgrade reconciliation failed: ${String(error)}`)); });
  bus.on('operations', () => { void deps.upgrade.reconcile().catch((error: unknown) => logger.error(`upgrade reconciliation failed: ${String(error)}`)); });
  bus.on('task_changed', () => {
    void deps.publishWorktrees().catch((error: unknown) => logger.debug(`worktree inventory refresh failed: ${String(error)}`));
  });
  bus.on('task_removed', () => {
    void deps.publishWorktrees().catch((error: unknown) => logger.debug(`worktree inventory refresh failed: ${String(error)}`));
  });
  bus.on('attempt_changed', () => {
    fireAndForget(() => deps.drainRetirement(), { op: 'sessionRetirement.drain', level: 'warn' });
  });
  bus.on('attempt_changed', (run) => {
    if (run.state === 'running') return;
    fireAndForget(
      async () => {
        if ((await deps.tasks.list({ state: 'ready' })).length !== 0) return;
        if ((await deps.attempts.countRunning()) === 0) await deps.notifier.notify('queue.idle');
      },
      { op: 'notifier.queueIdle', level: 'warn', context: { attemptId: run.id } },
    );
  });
}
