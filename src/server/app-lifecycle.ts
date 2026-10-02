import type { Scheduler } from '../scheduler/scheduler.js';
import type { Runner } from '../execution/runner.js';
import type { AutoRunner } from '../execution/auto-runner.js';
import type { ConversationDriver } from '../execution/conversation-driver.js';
import type { EventLoopMonitor } from '../reliability/event-loop-monitor.js';
import type { HostLoadSampler } from '../host-load.js';
import type { WorkspaceWatcher } from '../domain/workspace-watcher.js';
import type { WorkspaceService } from '../domain/workspaces.js';
import type { TrackerPollerManager } from '../tracker/manager.js';
import type { UpgradeCoordinator } from '../upgrade/upgrade-coordinator.js';
import type { StatsWorkerClient } from '../db/stats-reader.js';
import type { AsyncDbHandle } from '../db/async.js';
import { detachProcessGroupJournal, type ProcessGroupJournal } from '../execution/process-groups.js';
import type { TranscriptCapture } from '../execution/transcript-capture.js';
import type { App } from './app-context.js';
import { sweepStaleMergeWorktrees } from '../execution/ephemeral-merge-worktree.js';
import { forEachYielding } from '../reliability/yield.js';
import { logger } from '../logger.js';
import { drainFireAndForget, errorMessage } from '../error-handling.js';
import { startOperation } from '../telemetry/operations.js';

const SHUTDOWN_DRAIN_MS = 5_000;

/** Stop every source of work, wait (bounded) for in-flight work and its final writes, then close the DB last. */
export function registerShutdown(app: App, deps: {
  trackerManager: Pick<TrackerPollerManager, 'stopAll'>;
  scheduler: Pick<Scheduler, 'stop'>;
  autoRunner: Pick<AutoRunner, 'close'>;
  upgrade: Pick<UpgradeCoordinator, 'close'>;
  runner: Pick<Runner, 'shutdown'>;
  conversationDriver: Pick<ConversationDriver, 'shutdown'>;
  loopMonitor: Pick<EventLoopMonitor, 'stop'> | undefined;
  hostLoad: Pick<HostLoadSampler, 'stop'>;
  workspaceWatcher: Pick<WorkspaceWatcher, 'stopAll'>;
  statsReader: Pick<StatsWorkerClient, 'close'>;
  processGroups?: ProcessGroupJournal;
  transcripts?: Pick<TranscriptCapture, 'close'>;
  asyncDb: Pick<AsyncDbHandle, 'close'>;
  drainTimeoutMs?: number;
}): void {
  app.addHook('onClose', async () => {
    deps.transcripts?.close();
    const drained = Promise.allSettled([
      deps.autoRunner.close(),
      deps.scheduler.stop(),
      deps.trackerManager.stopAll(),
      deps.upgrade.close(),
      deps.runner.shutdown(),
      deps.conversationDriver.shutdown(),
    ]).then(async (results) => {
      for (const result of results) {
        if (result.status === 'rejected') logger.warn('shutdown: a component failed to stop', { error: errorMessage(result.reason) });
      }
      await drainFireAndForget();
    });
    deps.loopMonitor?.stop();
    deps.hostLoad.stop();
    await deps.workspaceWatcher.stopAll();
    const timeoutMs = deps.drainTimeoutMs ?? SHUTDOWN_DRAIN_MS;
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      drained.then(() => 'drained' as const),
      new Promise<'timed-out'>((resolve) => { timer = setTimeout(() => resolve('timed-out'), timeoutMs); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
    if (outcome === 'timed-out') logger.warn('shutdown: in-flight work still running after the drain bound; closing the database anyway', { timeoutMs });
    await deps.statsReader.close();
    if (deps.processGroups) detachProcessGroupJournal(deps.processGroups);
    await deps.asyncDb.close();
  });
}

export function registerStartup(app: App, deps: {
  runner: Runner;
  conversationDriver: ConversationDriver;
  autoRunner: AutoRunner;
  scheduler: Scheduler;
  trackerManager: TrackerPollerManager;
  workspaceWatcher: WorkspaceWatcher;
  workspaces: WorkspaceService;
  loopMonitor: EventLoopMonitor | undefined;
  hostLoad: HostLoadSampler;
  upgrade: UpgradeCoordinator;
}): void {
  app.addHook('onListen', async () => {
    const address = app.server.address();
    if (address && typeof address === 'object') {
      const host = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
      const mcpUrl = `http://${host}:${address.port}/mcp`;
      deps.runner.mcpUrl = mcpUrl;
      deps.conversationDriver.mcpUrl = mcpUrl;
    }
    const workspaceList = await deps.workspaces.list();
    await forEachYielding(workspaceList, async (workspace) => {
      const operation = startOperation({ type: 'worktree.merge-sweep', attributes: { 'workspace.id': workspace.id } });
      try {
        const removed = await operation.run(() => sweepStaleMergeWorktrees(workspace.workingDir));
        operation.update({ 'worktree.merge_sweep.removed': removed.length });
        operation.end();
        for (const path of removed) {
          logger.info('startup: removed a merge worktree left by a prior crash', {
            'workspace.id': workspace.id,
            path,
          });
        }
      } catch (error) {
        operation.fail(error);
        logger.warn('startup: sweeping stale merge worktrees failed', {
          'workspace.id': workspace.id,
          error: errorMessage(error),
        });
      }
    });
    deps.autoRunner.start();
    deps.autoRunner.poke();
    deps.scheduler.start();
    await deps.trackerManager.sync();
    await deps.workspaceWatcher.sync(await deps.workspaces.list());
    deps.loopMonitor?.start();
    deps.hostLoad.start();
    await deps.upgrade.reconcile();
  });
}
