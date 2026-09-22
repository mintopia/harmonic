import Fastify from 'fastify';
import { join, resolve } from 'node:path';
import { openAsyncDb } from '../db/async.js';
import { openStatsReader } from '../db/stats-reader.js';
import { EventBus } from './bus.js';
import { operationRegistry } from '../telemetry/operations.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { detectDistributionMode } from '../distribution-mode.js';
import { fetchLatestVersion, SettingsUpdateAvailabilityStore, UpdateCheck } from '../upgrade/update-check.js';
import { readPackageManifest } from './routes/openapi.js';
import { createStores } from './app-stores.js';
import { createWorktreeServices } from './app-worktrees.js';
import { createRuntime } from './app-runtime.js';
import { registerAppJobs } from './app-jobs.js';
import { registerBusListeners } from './app-bus-listeners.js';
import { registerPlugins } from './app-plugins.js';
import { registerAuthHook } from './app-auth-hook.js';
import { registerRouteRecorder, registerErrorHandler } from './app-hooks.js';
import { registerShutdown, registerStartup } from './app-lifecycle.js';
import { registerRoutes } from './app-routes.js';
import {
  createAppContexts,
  type App,
  type AppContext,
  type AppOptions,
  type RegisteredRoute,
} from './app-context.js';

export type {
  AppOptions,
  AppContext,
  PersistenceContext,
  ExecutionContext,
  TrackingContext,
  AppContexts,
  RegisteredRoute,
  App,
} from './app-context.js';
export { createPersistenceContext, createExecutionContext, createTrackingContext, createAppContexts } from './app-context.js';

export async function buildApp(opts: AppOptions): Promise<App> {
  const distributionMode = opts.distributionMode ?? detectDistributionMode();
  const asyncDb = await openAsyncDb(opts.dataDir);
  const statsReader = openStatsReader(opts.dataDir);
  const worktreesDir = join(opts.dataDir, 'worktrees');
  const managedWorktreesRoot = resolve(worktreesDir);
  const bus = new EventBus();
  const scheduler = new Scheduler(asyncDb, (jobs) => bus.emit('scheduled_jobs', jobs));
  const runningVersion = opts.version ?? readPackageManifest().version;
  const updateCheck = new UpdateCheck({
    version: runningVersion,
    latest: opts.updateCheckLatest ?? fetchLatestVersion,
    store: new SettingsUpdateAvailabilityStore(asyncDb),
  });
  operationRegistry.setBus(bus);

  const stores = await createStores({ opts, asyncDb, bus });
  const worktrees = createWorktreeServices({
    workspaces: stores.workspaces,
    tasks: stores.tasks,
    bus,
    worktreesDir,
    managedWorktreesRoot,
  });
  const runtime = await createRuntime({
    opts,
    stores,
    worktrees,
    bus,
    scheduler,
    asyncDb,
    worktreesDir,
    managedWorktreesRoot,
    distributionMode,
    runningVersion,
  });

  registerAppJobs(scheduler, {
    registrations: opts.scheduledJobRegistrations,
    metricsSummary: opts.metricsSummary,
    distributionMode,
    updateCheck,
    drainRetirement: runtime.drainRetirement,
    reconcileWorktrees: worktrees.reconcileWorktrees,
    trackerManager: runtime.trackerManager,
  });
  registerBusListeners(bus, {
    autoRunner: runtime.autoRunner,
    upgrade: runtime.upgrade,
    publishWorktrees: worktrees.publishWorktrees,
    drainRetirement: runtime.drainRetirement,
    tasks: stores.tasks,
    attempts: stores.attempts,
    notifier: stores.notifier,
  });

  const ctx: AppContext = {
    distributionMode,
    runningVersion,
    updateCheck,
    upgrade: runtime.upgrade,
    asyncDb,
    statsReader,
    settingsStore: stores.settingsStore,
    workspaces: stores.workspaces,
    tasks: stores.tasks,
    attempts: stores.attempts,
    taskEvents: stores.taskEvents,
    sessions: stores.sessions,
    runner: runtime.runner,
    conversations: stores.conversations,
    conversationDriver: runtime.conversationDriver,
    permissionRules: stores.permissionRules,
    escalation: runtime.escalation,
    autoRunner: runtime.autoRunner,
    globalPause: runtime.globalPause,
    guardrailEvents: stores.guardrailEvents,
    verificationAttempts: stores.verificationAttempts,
    trackerManager: runtime.trackerManager,
    epicService: runtime.epicService,
    scheduler,
    auth: stores.auth,
    channels: stores.channels,
    notifier: stores.notifier,
    bus,
    hostLoad: runtime.hostLoad,
    workspaceWatcher: runtime.workspaceWatcher,
    worktreeInventory: worktrees.worktreeInventory,
    forceCleanupWorktree: worktrees.forceCleanupWorktree,
    dirtyWorktreeFiles: worktrees.dirtyWorktreeFiles,
    reconcileWorktrees: worktrees.reconcileWorktrees,
    worktreesReconciledAt: worktrees.worktreesReconciledAt,
  };
  const contexts = createAppContexts(ctx);

  const app = Fastify({ logger: false }) as unknown as App;
  app.decorate('ctx', ctx);
  const registeredRoutes: RegisteredRoute[] = [];
  app.decorate('registeredRoutes', registeredRoutes);
  registerRouteRecorder(app, registeredRoutes);
  registerShutdown(app, {
    trackerManager: runtime.trackerManager,
    scheduler,
    autoRunner: runtime.autoRunner,
    runner: runtime.runner,
    conversationDriver: runtime.conversationDriver,
    loopMonitor: runtime.loopMonitor,
    hostLoad: runtime.hostLoad,
    workspaceWatcher: runtime.workspaceWatcher,
    statsReader,
  });
  await registerPlugins(app);
  registerAuthHook(app, stores.auth);
  registerErrorHandler(app);
  registerStartup(app, {
    runner: runtime.runner,
    conversationDriver: runtime.conversationDriver,
    autoRunner: runtime.autoRunner,
    scheduler,
    trackerManager: runtime.trackerManager,
    workspaceWatcher: runtime.workspaceWatcher,
    workspaces: stores.workspaces,
    loopMonitor: runtime.loopMonitor,
    hostLoad: runtime.hostLoad,
    upgrade: runtime.upgrade,
  });
  await registerRoutes(app, ctx, contexts);
  return app;
}
