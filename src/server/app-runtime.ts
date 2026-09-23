import { defaultBranchPostMerge, type PostMergeHook } from '../execution/branch-merge.js';
import type { AsyncDbHandle } from '../db/async.js';
import { dropIndexForPath } from '../execution/code-index.js';
import { Git } from '../execution/git.js';
import { BranchRetirementCoordinator } from '../execution/branch-retirement.js';
import type { MergeEffectExec } from '../domain/merge.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import { CrashRecoveryCoordinator } from '../execution/crash-recovery.js';
import { Runner } from '../execution/runner.js';
import { EpicOperations } from '../execution/epic-operations.js';
import { ConversationDriver } from '../execution/conversation-driver.js';
import { AutoRunner } from '../execution/auto-runner.js';
import { GlobalPause } from '../execution/global-pause.js';
import { GitCircuitBreaker } from '../execution/git-failure.js';
import { EventLoopMonitor } from '../reliability/event-loop-monitor.js';
import { HostLoadSampler } from '../host-load.js';
import { WorkspaceWatcher } from '../domain/workspace-watcher.js';
import { logger } from '../logger.js';
import { errorMessage, fireAndForget } from '../error-handling.js';
import { singleFlight } from '../reliability/single-flight.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { AutoDrive } from '../execution/auto-drive.js';
import { TrackerPollerManager } from '../tracker/manager.js';
import { TrackerEpicService, type EpicService } from '../tracker/epic-service.js';
import type { MirrorClaim } from '../execution/auto-runner.js';
import { operationRegistry, startOperation } from '../telemetry/operations.js';
import { EventBus } from './bus.js';
import { SettingsUpdateAvailabilityStore } from '../upgrade/update-check.js';
import { UpgradeCoordinator, type UpgradeCancellation, type UpgradeIdleHandoffOutcome } from '../upgrade/upgrade-coordinator.js';
import { AttemptSettleCoordinator } from '../domain/attempt-settle.js';
import { SessionRetirementCoordinator } from '../domain/session-retirement-coordinator.js';
import { EscalationService } from '../domain/escalation.js';
import type { AppOptions } from './app-context.js';
import type { Stores } from './app-stores.js';
import type { WorktreeServices } from './app-worktrees.js';
import { createPostMergeCheck } from '../verification/post-merge-check.js';
import type { DistributionMode } from '../distribution-mode.js';

function createLifecycleTracking(
  bus: EventBus,
  attempts: Stores['attempts'],
  taskEvents: Stores['taskEvents'],
  tasks: Stores['tasks'],
  sessionStore: Stores['sessions'],
): {
  recordAttemptLifecycleBestEffort: (run: Pick<AttemptRow, 'id'>, payload: Record<string, unknown>) => void;
  recordTaskEventBestEffort: (task: Pick<TaskRow, 'id'>, payload: Record<string, unknown>) => void;
  sessionRetirement: SessionRetirementCoordinator;
  drainRetirement: () => Promise<number>;
  branchRetirement: BranchRetirementCoordinator;
} {
  const recordAttemptLifecycleBestEffort = (run: Pick<AttemptRow, 'id'>, payload: Record<string, unknown>): void => {
    fireAndForget(async () => bus.emit('attempt_event', await attempts.appendEvent(run.id, { type: 'lifecycle', payload })), {
      op: 'app.recordAttemptLifecycle',
      level: 'debug',
      context: { attemptId: run.id, event: String(payload.event) },
    });
  };
  const recordTaskEventBestEffort = (task: Pick<TaskRow, 'id'>, payload: Record<string, unknown>): void => {
    fireAndForget(
      async () => {
        await taskEvents.appendEvent(task.id, payload);
        bus.emit('step_changed', { taskId: task.id });
      },
      { op: 'app.recordTaskEvent', level: 'debug', context: { taskId: task.id, event: String(payload.event) } },
    );
  };
  const sessionRetirement = new SessionRetirementCoordinator(
    sessionStore,
    attempts,
    (repoDir, worktreePath) =>
      Git.removeWorktree(repoDir, worktreePath)
        .then(() => dropIndexForPath(worktreePath)),
    undefined,
    undefined,
    (run, info) => recordAttemptLifecycleBestEffort(run, { event: 'retired', worktree: info.worktree, ...(info.error !== undefined ? { error: info.error } : {}) }),
  );
  const drainRetirement = singleFlight(() => sessionRetirement.drain());
  const branchRetirement = new BranchRetirementCoordinator(attempts, tasks, Git, logger.error, (attemptId, payload) =>
    recordAttemptLifecycleBestEffort({ id: attemptId }, payload),
  );
  return { recordAttemptLifecycleBestEffort, recordTaskEventBestEffort, sessionRetirement, drainRetirement, branchRetirement };
}

/** Reconcile crash-interrupted Attempts, requeue orphaned working Tasks, and sweep dangling keys. */
async function runStartupRecovery(deps: {
  attempts: Stores['attempts'];
  tasks: Stores['tasks'];
  auth: Stores['auth'];
  operatorSettle: AttemptSettleCoordinator;
  postMergeCheck: ReturnType<typeof createPostMergeCheck>;
  postMerge: PostMergeHook;
  bus: EventBus;
}): Promise<void> {
  const { attempts, tasks, auth, operatorSettle, postMergeCheck, postMerge, bus } = deps;
  const crashRecovery = new CrashRecoveryCoordinator(attempts, tasks, operatorSettle, {
    runPostMergeCheck: postMergeCheck,
    postMerge,
    onEpicAttemptInterrupted: (attempt) => { bus.emit('attempt_changed', attempt); },
  });
  await crashRecovery.reconcile();
  for (const orphan of await tasks.list({ state: 'working' })) {
    await tasks.setState(orphan.id, 'ready');
  }
  await auth.sweepOrphanedAttemptKeys();
  await auth.sweepOrphanedConversationKeys();
}

function createObservability(
  opts: AppOptions,
  bus: EventBus,
  settingsStore: Stores['settingsStore'],
): { loopMonitor: EventLoopMonitor | undefined; hostLoad: HostLoadSampler; workspaceWatcher: WorkspaceWatcher } {
  const eventLoopTuning = opts.reliabilityTuning?.eventLoop;
  const loopMonitor =
    eventLoopTuning?.enabled === false
      ? undefined
      : new EventLoopMonitor({ probeMs: eventLoopTuning?.probeMs, stallMs: eventLoopTuning?.stallMs });
  const hostLoad = new HostLoadSampler(bus);
  const workspaceWatcher = new WorkspaceWatcher(
    () => settingsStore.getGlobal().fileWatcherDebounceMs,
    {
      fsChanged: (workspaceId) => bus.emit('fs_changed', { workspaceId }),
      gitStatus: (workspaceId, entries) => bus.emit('git_status', { workspaceId, entries }),
    },
  );
  return { loopMonitor, hostLoad, workspaceWatcher };
}

function createUpgrade(deps: {
  opts: AppOptions;
  runningVersion: string;
  asyncDb: AsyncDbHandle;
  settingsStore: Stores['settingsStore'];
  attempts: Stores['attempts'];
  conversationDriver: ConversationDriver;
  notifier: Stores['notifier'];
}): UpgradeCoordinator {
  const { opts, runningVersion, asyncDb, settingsStore, attempts, conversationDriver, notifier } = deps;
  const externalInstall = opts.installMode?.kind === 'external';
  const onUpgradeIdle = opts.onUpgradeIdle === undefined
    ? undefined
    : async (version: string, cancellation: UpgradeCancellation): Promise<UpgradeIdleHandoffOutcome | void> => {
      try {
        return await opts.onUpgradeIdle?.(version, cancellation);
      } catch (error) {
        const abort = startOperation({ type: 'upgrade.abort', attributes: { 'upgrade.version': version } });
        try {
          logger.error(`upgrade to ${version} aborted: ${String(error)}`, { version });
          await notifier.notify('update.failed');
          abort.end();
        } catch (abortError) {
          abort.fail(abortError);
          throw abortError;
        }
        throw error;
      }
    };
  return new UpgradeCoordinator({
    version: runningVersion,
    store: new SettingsUpdateAvailabilityStore(asyncDb),
    settings: settingsStore,
    attempts,
    operations: () => operationRegistry.list(),
    conversations: conversationDriver,
    ...(opts.migrationRequired === undefined ? {} : { migrationRequired: opts.migrationRequired }),
    ...(externalInstall ? { externalInstall: true } : {}),
    ...(onUpgradeIdle === undefined ? {} : { onIdle: onUpgradeIdle }),
    ...(opts.readRollback === undefined ? {} : { readRollback: opts.readRollback }),
    ...(opts.clearRollback === undefined ? {} : { clearRollback: opts.clearRollback }),
  });
}

export interface Runtime {
  conversationDriver: ConversationDriver;
  sessionRetirement: SessionRetirementCoordinator;
  drainRetirement: () => Promise<number>;
  runner: Runner;
  globalPause: GlobalPause;
  escalation: EscalationService;
  autoDrive: AutoDrive;
  autoRunner: AutoRunner;
  upgrade: UpgradeCoordinator;
  epicService: EpicService;
  trackerManager: TrackerPollerManager;
  hostLoad: HostLoadSampler;
  workspaceWatcher: WorkspaceWatcher;
  loopMonitor: EventLoopMonitor | undefined;
}

export async function createRuntime(deps: {
  opts: AppOptions;
  stores: Stores;
  worktrees: WorktreeServices;
  bus: EventBus;
  scheduler: Scheduler;
  asyncDb: AsyncDbHandle;
  worktreesDir: string;
  managedWorktreesRoot: string;
  distributionMode: DistributionMode;
  runningVersion: string;
}): Promise<Runtime> {
  const { opts, bus, scheduler, asyncDb, worktreesDir, managedWorktreesRoot, distributionMode, runningVersion } = deps;
  const { tasks, attempts, taskEvents, settingsStore, workspaces, conversations, permissionRules, auth, notifier, epicMergeEvents, verificationAttempts, sessions: sessionStore } = deps.stores;

  let upgradeRef: UpgradeCoordinator | undefined;
  const conversationDriver = new ConversationDriver(conversations, () => settingsStore.getGlobal(), {
    events: {
      onEvent: (event) => bus.emit('conversation_event', event),
      onPermissionRequest: (pending) => bus.emit('permission_request', pending),
      onElicitationRequest: (pending) => bus.emit('elicitation_request', pending),
      onCommandsUpdate: (payload) => bus.emit('conversation_commands', payload),
    },
    rules: permissionRules,
    keys: {
      mint: async (conversationId) =>
        (await auth.createKey(`conversation-${conversationId}`, { scope: 'conversation', conversationId })).token,
      revoke: (conversationId) => auth.deleteKeysForConversation(conversationId),
    },
    onTurnSettled: () => { void upgradeRef?.reconcile().catch((error: unknown) => logger.error(`upgrade reconciliation failed: ${String(error)}`)); },
    allowedRoots: async () => [...(await workspaces.list()).map((w) => w.workingDir), managedWorktreesRoot],
  });
  const { recordAttemptLifecycleBestEffort, recordTaskEventBestEffort, sessionRetirement, drainRetirement, branchRetirement } = createLifecycleTracking(bus, attempts, taskEvents, tasks, sessionStore);
  let runnerRef: Runner | undefined;
  let globalPauseRef: GlobalPause | undefined;
  let trackerManagerRef: TrackerPollerManager | undefined;
  let epicServiceRef: EpicService | undefined;
  const pendingPostMerge: Parameters<PostMergeHook>[0][] = [];
  const postMerge: PostMergeHook = defaultBranchPostMerge(
    async (repoDir, defaultBranch) => {
      try {
      if (!trackerManagerRef) {
        pendingPostMerge.push({ repoDir, baseBranch: defaultBranch });
        return;
      }
      await epicServiceRef?.refreshAfterDefaultBranchAdvance(repoDir, defaultBranch);
      } catch (err) {
        logger.error(`post-merge Epic refresh failed: ${String(err)}`);
      }
    },
  );
  const operatorSettle = new AttemptSettleCoordinator(
    tasks,
    attempts,
    (run) => {
      void runnerRef?.finishRunOperation(run.id);
      bus.emit('attempt_changed', run);
    },
    sessionRetirement,
    branchRetirement,
  );
  const postMergeCheck = createPostMergeCheck({
    workspaces,
    settingsStore,
    verificationAttempts,
    criticDrive: opts.criticDrive,
  });
  await runStartupRecovery({ attempts, tasks, auth, operatorSettle, postMergeCheck, postMerge, bus });
  const getWorkspaceRow = async (id: number | null) => {
    if (id == null) return undefined;
    try {
      return await workspaces.get(id);
    } catch {
      return undefined;
    }
  };
  const autoDrive = new AutoDrive(
    () => settingsStore.getGlobal(),
    (task) => trackerManagerRef?.urlFor(task.workspaceId, task.trackerRef) ?? null,
    undefined,
    getWorkspaceRow,
    (workspaceId, ref) => tasks.epicKind(workspaceId, ref),
    (task, commit) => {
      void (async () => {
        const payload = {
          event: 'ticket-closed',
          trackerRef: task.trackerRef != null ? String(task.trackerRef) : null,
          ...(commit ? { commitOid: commit.oid, paths: commit.paths } : {}),
        };
        const run = (await attempts.listForTask(task.id)).at(-1);
        if (run) recordAttemptLifecycleBestEffort(run, payload);
        else recordTaskEventBestEffort(task, payload);
      })();
    },
    (task, error) => {
      void (async () => {
        const payload = {
          event: 'ticket-close-failed',
          trackerRef: task.trackerRef != null ? String(task.trackerRef) : null,
          error: errorMessage(error),
        };
        const run = (await attempts.listForTask(task.id)).at(-1);
        if (run) recordAttemptLifecycleBestEffort(run, payload);
        else recordTaskEventBestEffort(task, payload);
      })();
    },
  );
  const mergeEffectsFor = (task: TaskRow, run: AttemptRow): MergeEffectExec[] => {
    const effects: MergeEffectExec[] = [];
    if (task.trackerRef != null) {
      effects.push({
        effect: 'ticket-close',
        idempotencyKey: `ticket-${task.trackerRef}`,
        expected: { trackerRef: task.trackerRef },
        apply: async () =>
          (await autoDrive.closeCompleted(task))
            ? { ok: true, observed: { trackerRef: task.trackerRef } }
            : { ok: false, detail: `ticket #${task.trackerRef} could not be closed` },
      });
    }
    if (task.isolationMode !== 'worktree') return effects;
    if (!run.branch || !run.baseBranch || !run.verifiedHeadOid) return effects;
    const baseBranch = run.baseBranch;
    const branch = run.branch;
    return [
      {
        effect: 'target-ref',
        idempotencyKey: `${baseBranch}<-${branch}`,
        expected: { baseBranch, branch },
        apply: async () => {
          const outcome = await runnerRef!.mergeAcceptedBranch(task, run);
          if (outcome.kind === 'escalated') return { ok: false, detail: outcome.message, observed: { reason: outcome.reason } };
          return { ok: true, observed: { baseBranch, branch, oid: outcome.mergeOid } };
        },
      },
      ...effects,
    ];
  };
  const epicOperations = new EpicOperations();
  const gitBreaker = new GitCircuitBreaker();
  const runner = new Runner(tasks, asyncDb, () => settingsStore.getGlobal(), {
    isGloballyPaused: () => globalPauseRef?.isLatched ?? false,
    onGloballyPaused: async (taskId) => { await globalPauseRef?.track(taskId); },
    events: {
      onAttemptEvent: (event) => bus.emit('attempt_event', event),
      onAttemptLogEvent: (event) => bus.emitAttemptLog(event),
      onCriticLogEvent: (event) => bus.emitCriticLog(event),
      onAttemptFinished: (run) => bus.emit('attempt_changed', run),
      onAttemptUsage: (payload) => bus.emit('attempt_usage', payload),
      onStepChanged: (taskId) => bus.emit('step_changed', { taskId }),
      onEpicMergeStep: (payload) => bus.emit('epic_changed', payload),
      onTaskEvent: (taskId) => bus.emit('step_changed', { taskId }),
    },
    gitBreaker,
    epicBaseNotReady: (task) => epicServiceRef?.epicBaseNotReady(task) ?? false,
    postMerge,
    worktreesDir,
    spendGuardrail: opts.runnerTuning?.spendGuardrail,
    criticDrive: opts.criticDrive,
    sessionRetirement,
    taskEvents,
    keys: {
      mint: async (attemptId) => (await auth.createKey(`attempt-${attemptId}`, { scope: 'attempt', attemptId })).token,
      revoke: (attemptId) => auth.deleteKeysForAttempt(attemptId),
    },
    autoDrive,
    urlFor: (task) => trackerManagerRef?.urlFor(task.workspaceId, task.trackerRef) ?? null,
    getWorkspace: getWorkspaceRow,
  });
  runnerRef = runner;
  const globalPause = new GlobalPause(tasks, runner, asyncDb);
  globalPauseRef = globalPause;
  await globalPause.rebuild();
  await runner.backfillUsage();
  const escalation = new EscalationService(attempts, tasks, operatorSettle, mergeEffectsFor, {
    resume: (task, guidance, startNow) => runner.resumeWithGuidance(task, guidance, startNow),
    cleanup: (task, run) => runner.cleanupClosed(task, run),
    candidateHead: (task, run) => runner.candidateHead(task, run),
    advance: (task, run, failedStep) => runner.advanceAccepted(task, run, failedStep),
  });
  await drainRetirement();
  const { loopMonitor, hostLoad, workspaceWatcher } = createObservability(opts, bus, settingsStore);
  const mirror: MirrorClaim = {
    advertiseClaim: async (task) => {
      await trackerManagerRef?.coordinatorFor(task.workspaceId)?.advertiseClaim(task);
    },
  };
  const autoRunner = new AutoRunner(
    tasks,
    attempts,
    runner,
    () => settingsStore.getGlobal(),
    () => workspaces.list(),
    {
      mirror,
      epicBaseNotReady: (task) => epicServiceRef?.epicBaseNotReady(task) ?? false,
      gitBreaker,
    },
  );
  const upgrade = createUpgrade({ opts, runningVersion, asyncDb, settingsStore, attempts, conversationDriver, notifier });
  upgradeRef = upgrade;
  if (distributionMode === 'packaged') {
    await upgrade.settleOnBoot();
  }
  const epicService = new TrackerEpicService(
    tasks,
    () => workspaces.list(),
    {
      getConfig: () => settingsStore.getGlobal(),
      operations: epicOperations,
      mergeEpicIntegration: (input) => runnerRef!.mergeEpicIntegration(input),
      dispatchRefreshResolution: (target, detail, escalate, retry) => runnerRef!.enqueueEpicRefreshResolution(target, detail, escalate, retry),
      epicMergeEvents,
      epicAttempts: attempts,
      dispatchEpicResolution: (input) => runnerRef!.resolveEpicVerification(input),
      worktreesDir,
      onEpicAttemptChanged: (attempt) => bus.emit('attempt_changed', attempt),
      onEpicMergeStep: (payload) => bus.emit('epic_changed', payload),
      onEpicIntegrated: (payload) => {
        bus.emit('epic_integrated', payload);
        fireAndForget(() => branchRetirement.reconcile(), {
          op: 'app.branchRetirement.reconcileAfterIntegration',
          level: 'error',
          context: payload,
        });
      },
      verificationAttemptStore: verificationAttempts,
      criticDrive: opts.criticDrive,
    },
  );
  epicServiceRef = epicService;
  const trackerManager = new TrackerPollerManager(tasks, () => workspaces.list(), {
    epicService,
    scheduler,
    workStartAllowed: () => upgrade.workStartAllowed(),
  });
  trackerManagerRef = trackerManager;
  for (const merged of pendingPostMerge.splice(0)) await postMerge(merged);

  fireAndForget(() => branchRetirement.reconcile(), { op: 'app.branchRetirement.reconcile', level: 'error' });

  return {
    conversationDriver,
    sessionRetirement,
    drainRetirement,
    runner,
    globalPause,
    escalation,
    autoDrive,
    autoRunner,
    upgrade,
    epicService,
    trackerManager,
    hostLoad,
    workspaceWatcher,
    loopMonitor,
  };
}
