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
import { TaskExporter } from '../archive/task-export.js';
import { pruneArchives, type ArchiveRetention } from '../archive/archive-retention.js';
import { workspaceSlug } from '../archive/task-archive.js';
import { resolveExportSettings } from '../archive/export-settings.js';
import type { TaskRow } from '../db/schema.js';
import { epicAttemptTimelineToApi, taskToApi, ticketTimelineToApi } from './serialize.js';
import { fireAndForget, orFallback } from '../error-handling.js';
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
    notifications: stores.notifications,
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
    installMode: opts.installMode ?? { kind: 'systemd' },
    guardMissing: opts.guardMissing ?? false,
    updateCheck,
    upgrade: runtime.upgrade,
    archive: runtime.archive,
    get exporter() {
      return exporter;
    },
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
    notifications: stores.notifications,
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

  const exporter = new TaskExporter({
    dataDir: opts.dataDir,
    archive: runtime.archive,
    version: runningVersion,
    settings: async (task) => {
      const workspace =
        task.workspaceId === null
          ? undefined
          : await stores.workspaces.get(task.workspaceId);
      return resolveExportSettings(stores.settingsStore.getGlobal(), workspace);
    },
    epicSettings: async (workspaceId) =>
      resolveExportSettings(stores.settingsStore.getGlobal(), await stores.workspaces.get(workspaceId)),
    epicSnapshot: async (workspaceId, epicRef) => {
      const [detail, stored, timeline, workspaceTasks] = await Promise.all([
        ctx.trackerManager.epicDetail(workspaceId, epicRef),
        ctx.tasks.listStoredEpics(workspaceId),
        epicAttemptTimelineToApi(ctx, { workspaceId, epicRef }),
        ctx.tasks.list({ workspaceId }),
      ]);
      const row = stored.find((r) => r.trackerRef === epicRef);
      const byRef = new Map<number, TaskRow>();
      for (const t of workspaceTasks) if (t.trackerRef != null) byRef.set(t.trackerRef, t);
      const members = (row?.memberRefs ?? []).map((ref) => ({ ref, task: byRef.get(ref) ?? null }));
      return {
        ticket: detail ?? { ref: epicRef, state: row?.state ?? null, mergeCommit: row?.mergeCommit ?? null },
        timeline: { events: detail?.timelineEvents ?? [], ...timeline },
        attemptCount: timeline.attempts.length,
        members,
      };
    },
    workspaceName: async (workspaceId) =>
      (await orFallback(() => stores.workspaces.get(workspaceId), { op: 'export.workspaceName', context: { workspaceId } }, null))?.name ?? null,
    snapshot: async (task) => {
      const [ticket, timeline, taskAttempts] = await Promise.all([
        taskToApi(ctx, await ctx.tasks.withDeps(task)),
        ticketTimelineToApi(ctx, task.id),
        stores.attempts.listForTask(task.id),
      ]);
      return { ticket, timeline, attemptCount: taskAttempts.length };
    },
    recordFact: async (taskId, payload) => {
      await stores.taskEvents.appendEvent(taskId, payload);
      bus.emit('step_changed', { taskId });
    },
    onFailure: (failure) => {
      const { task, disposition, destination, error, retry, nextRetryAt } = failure;
      bus.emit('export_failed', { taskId: task.id, trackerRef: task.trackerRef, destination, disposition, error, retry, nextRetryAt });
      fireAndForget(
        () => stores.notifier.notify('export.failed', task, { export: { destination, disposition, error, retry, nextRetryAt } }),
        { op: 'export.notifyFailure', level: 'warn', context: { taskId: task.id } },
      );
    },
  });
  scheduler.register({
    name: 'Archive retention',
    intervalMs: 60 * 60_000,
    run: async () => {
      const overrides = new Map<string, ArchiveRetention>();
      for (const ws of await stores.workspaces.list()) {
        overrides.set(workspaceSlug(ws.name, ws.id), { days: ws.archiveRetentionDays, maxTotalMB: ws.archiveRetentionMaxTotalMB });
      }
      await pruneArchives({
        dataDir: opts.dataDir,
        retention: () => stores.settingsStore.getGlobal().archive.retain,
        workspaceRetention: (slug) => overrides.get(slug) ?? null,
        taskTerminalAt: async (taskId) => {
          const task = await orFallback(() => ctx.tasks.get(taskId), { op: 'archive.retention.task', context: { taskId } }, null);
          return task && (task.state === 'done' || task.state === 'cancelled') ? task.updatedAt : null;
        },
      });
    },
  });
  scheduler.register({ name: 'Export retry', intervalMs: 60_000, run: () => exporter.retryDue() });
  stores.tasks.setBeforeDelete((task) => exporter.captureForDelete(task));
  bus.on('task_disposition', ({ task, disposition }) => exporter.trigger(task, disposition));
  bus.on('epic_integrated', ({ workspaceId, epicRef }) => exporter.triggerEpic(workspaceId, epicRef, 'done'));
  fireAndForget(() => exporter.sweepStaging(), { op: 'export.sweepStaging', level: 'warn' });

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
