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
import type { App } from './app-context.js';
import { sweepStaleMergeWorktrees } from '../execution/ephemeral-merge-worktree.js';
import { forEachYielding } from '../reliability/yield.js';
import { logger } from '../logger.js';
import { errorMessage } from '../error-handling.js';

export function registerShutdown(app: App, deps: {
  trackerManager: TrackerPollerManager;
  scheduler: Scheduler;
  autoRunner: AutoRunner;
  runner: Runner;
  conversationDriver: ConversationDriver;
  loopMonitor: EventLoopMonitor | undefined;
  hostLoad: HostLoadSampler;
  workspaceWatcher: WorkspaceWatcher;
  statsReader: StatsWorkerClient;
}): void {
  app.addHook('onClose', async () => {
    deps.trackerManager.stopAll();
    deps.scheduler.stop();
    deps.autoRunner.stop();
    deps.runner.shutdown();
    deps.conversationDriver.shutdown();
    deps.loopMonitor?.stop();
    deps.hostLoad.stop();
    await deps.workspaceWatcher.stopAll();
    // asyncDb stays open: libsql rejects in-flight background reads with an unhandled CLIENT_CLOSED once closed.
    await deps.statsReader.close();
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
      const removed = await sweepStaleMergeWorktrees(workspace.workingDir).catch((error) => {
        logger.warn('startup: sweeping stale merge worktrees failed', {
          'workspace.id': workspace.id,
          error: errorMessage(error),
        });
        return [];
      });
      for (const path of removed) {
        logger.info('startup: removed a merge worktree left by a prior crash', {
          'workspace.id': workspace.id,
          path,
        });
      }
    });
    deps.autoRunner.start();
    deps.autoRunner.poke();
    deps.scheduler.start();
    await deps.trackerManager.sync();
    await deps.workspaceWatcher.sync(workspaceList);
    deps.loopMonitor?.start();
    deps.hostLoad.start();
    await deps.upgrade.reconcile();
  });
}
