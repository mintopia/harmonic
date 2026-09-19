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
