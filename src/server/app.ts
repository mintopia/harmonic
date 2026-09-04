import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
import fastifySwagger from '@fastify/swagger';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { defaultBranchPostMerge, type PostMergeHook } from '../execution/branch-merge.js';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { openAsyncDb, type AsyncDbHandle } from '../db/async.js';
import { openStatsReader, type StatsWorkerClient } from '../db/stats-reader.js';
import type { AppConfig, DeepPartial } from '../config.js';
import { SettingsStore } from './settings-store.js';
import { TaskService } from '../domain/tasks.js';
import { AttemptStore } from '../domain/attempts.js';
import { EpicMergeEventStore } from '../domain/epic-merge-events.js';
import { ConversationStore } from '../domain/conversations.js';
import { WorkspaceService } from '../domain/workspaces.js';
import { PermissionRuleStore } from '../domain/permission-rules.js';
import { EscalationService } from '../domain/escalation.js';
import { AttemptSettleCoordinator } from '../domain/attempt-settle.js';
import { SessionStore } from '../domain/sessions.js';
import { SessionRetirementCoordinator } from '../domain/session-retirement-coordinator.js';
import { dropIndexForPath } from '../execution/code-index.js';
import { isInside, WorktreeReconciler } from '../domain/worktree-reconciler.js';
import { worktreeId, WorktreeInventory } from '../domain/worktree-inventory.js';
import { Git } from '../execution/git.js';
import { GuardrailEventStore } from '../domain/guardrail-events.js';
import { VerificationAttemptStore } from '../domain/verification-attempts.js';
import type { MergeEffectExec } from '../domain/merge.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import { CrashRecoveryCoordinator } from '../execution/crash-recovery.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import { runCommandVerifier, commandAttemptToInput } from '../verification/command-verifier.js';
import { Runner } from '../execution/runner.js';
import { EpicOperations } from '../execution/epic-operations.js';
import type { CriticHarnessDrive } from '../verification/critic.js';
import { ConversationDriver } from '../execution/conversation-driver.js';
import { AutoRunner } from '../execution/auto-runner.js';
import { GitCircuitBreaker } from '../execution/git-failure.js';
import { EventLoopMonitor } from '../reliability/event-loop-monitor.js';
import { logger } from '../logger.js';
import { singleFlight } from '../reliability/single-flight.js';
import { Scheduler, type ScheduledJobRegistration } from '../scheduler/scheduler.js';
import { AutoDrive } from '../execution/auto-drive.js';
import { TrackerPollerManager } from '../tracker/manager.js';
import { TrackerEpicService, type EpicService } from '../tracker/epic-service.js';
import type { MirrorClaim } from '../execution/auto-runner.js';
import { DomainError } from '../domain/errors.js';
import { taskRoutes } from './routes/tasks.js';
import { epicRoutes } from './routes/epics.js';
import { mapRoutes } from './routes/maps.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { conversationRoutes } from './routes/conversations.js';
import { permissionRuleRoutes } from './routes/permission-rules.js';
import { configRoutes } from './routes/config.js';
import { wsRoutes } from './ws.js';
import { EventBus } from './bus.js';
import { operationRegistry } from '../telemetry/operations.js';
import { AuthService } from './auth.js';
import { authRoutes, SESSION_COOKIE } from './routes/auth.js';
import { statsRoutes } from './routes/stats.js';
import { activityRoutes } from './routes/activity.js';
import { operationRoutes } from './routes/operations.js';
import { channelRoutes } from './routes/channels.js';
import { scheduledJobRoutes } from './routes/scheduled-jobs.js';
import { worktreeRoutes } from './routes/worktrees.js';
import { harnessRoutes } from './routes/harnesses.js';
import { fsRoutes } from './routes/fs.js';
import { openapiRoutes, readPackageManifest } from './routes/openapi.js';
import { ChannelService } from '../notifications/channels.js';
import { Notifier } from '../notifications/notifier.js';
import { buildMcpServer } from '../mcp/server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface AppOptions {
  dataDir: string;
  configOverrides?: DeepPartial<AppConfig> | undefined;
  /** Set/update the operator password at boot; an empty string clears it (ungated). Undefined leaves it untouched. */
  password?: string | undefined;
  /** Test-only Runner cadence overrides; absent uses production defaults. */
  runnerTuning?: { spendGuardrail?: { pollMs?: number; graceMs?: number } } | undefined;
  /** Event-loop stall monitor overrides; `enabled: false` turns the probe off. */
  reliabilityTuning?: { eventLoop?: { enabled?: boolean; probeMs?: number; stallMs?: number } } | undefined;
  /** Test-only critic drive override; absent uses the real ACP critic drive. */
  criticDrive?: CriticHarnessDrive | undefined;
  /** Test-only Scheduled Job registrations. */
  scheduledJobRegistrations?: ScheduledJobRegistration[] | undefined;
  /** Registers telemetry's metrics-summary flush as a Scheduler Job; undefined when telemetry owns its own timer. */
  metricsSummary?: { intervalMs: number; flush: () => Promise<void> } | undefined;
}

/** Paths reachable without authentication. */
const PUBLIC_API_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/me',
  '/api/openapi.json',
  '/api/openapi.yaml',
]);

function scopedKeyAllowed(path: string): boolean {
  if (path.startsWith('/mcp')) return true;
  if (/^\/api\/tasks\/\d+\/complete$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/steer$/.test(path)) return false;
  if (/^\/api\/workspaces\/\d+\/epics\/\d+\/force-integrate$/.test(path)) return false;
  if (/^\/api\/workspaces\/\d+\/epics(\/\d+)?$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/(accept|reject|close)$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/channels(\/|$)/.test(path)) return false;
  if (path === '/api/tasks' || path.startsWith('/api/tasks/')) return true;
  if (path.startsWith('/api/attempts')) return true;
  return false;
}

function readScopeAllowed(path: string, method: string): boolean {
  if (method !== 'GET') return false;
  if (path === '/api/ws') return true;
  if (/^\/api\/workspaces\/\d+\/epics(\/\d+)?$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/channels(\/|$)/.test(path)) return false;
  if (path === '/api/tasks' || path.startsWith('/api/tasks/')) return true;
  if (path.startsWith('/api/attempts')) return true;
  if (path === '/api/maps' || path.startsWith('/api/maps/')) return true;
  if (path === '/api/activity') return true;
  if (path === '/api/operations') return true;
  if (path === '/api/scheduled-jobs') return true;
  return false;
}

async function requestIsOperator(req: FastifyRequest, auth: AuthService): Promise<boolean> {
  if (!(await auth.hasPassword())) return true;
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer && (await auth.verifyKey(bearer))?.scope === 'full') return true;
  if (auth.validateSession(req.cookies[SESSION_COOKIE])) return true;
  return false;
}

export interface AppContext {
  asyncDb: AsyncDbHandle;
  statsReader: StatsWorkerClient;
  settingsStore: SettingsStore;
  workspaces: WorkspaceService;
  tasks: TaskService;
  attempts: AttemptStore;
  sessions: SessionStore;
  runner: Runner;
  conversations: ConversationStore;
  conversationDriver: ConversationDriver;
  permissionRules: PermissionRuleStore;
  escalation: EscalationService;
  autoRunner: AutoRunner;
  guardrailEvents: GuardrailEventStore;
  verificationAttempts: VerificationAttemptStore;
  trackerManager: TrackerPollerManager;
  epicService: EpicService;
  scheduler: Scheduler;
  auth: AuthService;
  channels: ChannelService;
  notifier: Notifier;
  bus: EventBus;
  worktreeInventory: WorktreeInventory;
  forceCleanupWorktree: (id: string) => Promise<boolean | null>;
  dirtyWorktreeFiles: (id: string) => Promise<string[] | null>;
  reconcileWorktrees: () => ReturnType<WorktreeReconciler['reconcile']>;
  worktreesReconciledAt: () => number | null;
}

export type PersistenceContext = Pick<
  AppContext,
  | 'asyncDb'
  | 'statsReader'
  | 'settingsStore'
  | 'workspaces'
  | 'tasks'
  | 'attempts'
  | 'sessions'
  | 'conversations'
  | 'permissionRules'
  | 'guardrailEvents'
  | 'verificationAttempts'
  | 'auth'
  | 'channels'
>;

export type ExecutionContext = Pick<
  AppContext,
  | 'tasks'
  | 'settingsStore'
  | 'workspaces'
  | 'attempts'
  | 'sessions'
  | 'runner'
  | 'conversations'
  | 'conversationDriver'
  | 'escalation'
  | 'autoRunner'
  | 'guardrailEvents'
  | 'verificationAttempts'
  | 'auth'
  | 'notifier'
  | 'bus'
  | 'worktreeInventory'
  | 'forceCleanupWorktree'
  | 'dirtyWorktreeFiles'
  | 'worktreesReconciledAt'
>;

export type TrackingContext = Pick<AppContext, 'tasks' | 'workspaces' | 'settingsStore' | 'trackerManager' | 'epicService' | 'scheduler' | 'channels' | 'notifier' | 'bus'>;

export interface AppContexts {
  persistence: PersistenceContext;
  execution: ExecutionContext;
  tracking: TrackingContext;
}

export function createPersistenceContext(ctx: AppContext): PersistenceContext {
  const { asyncDb, statsReader, settingsStore, workspaces, tasks, attempts, sessions, conversations, permissionRules, guardrailEvents, verificationAttempts, auth, channels } = ctx;
  return { asyncDb, statsReader, settingsStore, workspaces, tasks, attempts, sessions, conversations, permissionRules, guardrailEvents, verificationAttempts, auth, channels };
}

export function createExecutionContext(ctx: AppContext): ExecutionContext {
  const { tasks, settingsStore, workspaces, attempts, sessions, runner, conversations, conversationDriver, escalation, autoRunner, guardrailEvents, verificationAttempts, auth, notifier, bus, worktreeInventory, forceCleanupWorktree, dirtyWorktreeFiles, worktreesReconciledAt } = ctx;
  return { tasks, settingsStore, workspaces, attempts, sessions, runner, conversations, conversationDriver, escalation, autoRunner, guardrailEvents, verificationAttempts, auth, notifier, bus, worktreeInventory, forceCleanupWorktree, dirtyWorktreeFiles, worktreesReconciledAt };
}

export function createTrackingContext(ctx: AppContext): TrackingContext {
  const { tasks, workspaces, settingsStore, trackerManager, epicService, scheduler, channels, notifier, bus } = ctx;
  return { tasks, workspaces, settingsStore, trackerManager, epicService, scheduler, channels, notifier, bus };
}

export function createAppContexts(ctx: AppContext): AppContexts {
  return {
    persistence: createPersistenceContext(ctx),
    execution: createExecutionContext(ctx),
    tracking: createTrackingContext(ctx),
  };
}

/** One Fastify route registration, as captured by the `onRoute` hook below. */
export interface RegisteredRoute {
  method: string;
  url: string;
}

export type App = FastifyInstance & { ctx: AppContext; registeredRoutes: RegisteredRoute[] };

export async function buildApp(opts: AppOptions): Promise<App> {
  const asyncDb = await openAsyncDb(opts.dataDir);
  const statsReader = openStatsReader(opts.dataDir);
  const worktreesDir = join(opts.dataDir, 'worktrees');
  const bus = new EventBus();
  const scheduler = new Scheduler(asyncDb, (jobs) => bus.emit('scheduled_jobs', jobs));
  scheduler.register({
    name: 'Scheduled Job registry cleanup',
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => scheduler.prune(),
  });
  for (const registration of opts.scheduledJobRegistrations ?? []) scheduler.register(registration);
  if (opts.metricsSummary) {
    scheduler.register({
      name: 'Metrics summary',
      intervalMs: opts.metricsSummary.intervalMs,
      run: opts.metricsSummary.flush,
    });
  }
  operationRegistry.setBus(bus);
  const settingsStore = await SettingsStore.create(opts.dataDir, opts.configOverrides);
  const workspaces = new WorkspaceService(asyncDb, settingsStore);
  const channels = new ChannelService(asyncDb);
  const notifier = new Notifier(channels, logger.error);
  const tasks = new TaskService(
    asyncDb,
    () => settingsStore.getGlobal(),
    () => workspaces.list(),
    (task) => bus.emit('task_changed', task),
    (event, task) => void notifier.notify(event, task).catch(() => {}),
    (id) => bus.emit('task_removed', { id }),
  );
  const attempts = new AttemptStore(asyncDb);
  const epicMergeEvents = new EpicMergeEventStore(asyncDb);
  const guardrailEvents = new GuardrailEventStore(asyncDb);
  const verificationAttempts = new VerificationAttemptStore(asyncDb);
  const conversations = new ConversationStore(asyncDb, (conversation) => bus.emit('conversation_changed', conversation));
  const permissionRules = new PermissionRuleStore(asyncDb);
  const auth = new AuthService(asyncDb);
  if (opts.password !== undefined) {
    if (opts.password === '') await auth.clearPassword();
    else await auth.setPassword(opts.password);
  }
  const conversationDriver = new ConversationDriver(conversations, () => settingsStore.getGlobal(), {
    events: {
      onEvent: (event) => bus.emit('conversation_event', event),
      onPermissionRequest: (pending) => bus.emit('permission_request', pending),
    },
    rules: permissionRules,
    keys: {
      mint: async (conversationId) =>
        (await auth.createKey(`conversation-${conversationId}`, { scope: 'conversation', conversationId })).token,
      revoke: (conversationId) => auth.deleteKeysForConversation(conversationId),
    },
  });
  const sessionStore = new SessionStore(asyncDb);
  /** Record a lifecycle audit event onto an Attempt and push it live, so a
   * disposition the runner does not itself record (a ticket close, a worktree
   * retirement) still lands on the ticket Timeline. Best-effort. */
  const recordAttemptLifecycle = (run: AttemptRow, payload: Record<string, unknown>): void => {
    void (async () => {
      try {
        bus.emit('attempt_event', await attempts.appendEvent(run.id, { type: 'lifecycle', payload }));
      } catch (err) {
        logger.debug(`timeline lifecycle event '${String(payload.event)}' dropped for attempt ${run.id}: ${String(err)}`);
      }
    })();
  };
  const sessionRetirement = new SessionRetirementCoordinator(
    sessionStore,
    attempts,
    (repoDir, worktreePath) =>
      Git.removeWorktree(repoDir, worktreePath)
        .then(() => dropIndexForPath(worktreePath)),
    undefined,
    undefined,
    (run) => recordAttemptLifecycle(run, { event: 'retired' }),
  );
  const worktreeInventory = new WorktreeInventory(
    () => workspaces.list(),
    () => tasks.list(),
    Git,
    worktreesDir,
  );
  const worktreeReconciler = new WorktreeReconciler(
    async () => {
      const openTasks = await tasks.list({ state: 'open' });
      return openTasks
        .filter((task): task is TaskRow & { workspaceId: number } => task.workspaceId != null)
        .map((task) => ({ id: task.id, workspaceId: task.workspaceId }));
    },
    () => workspaces.list(),
    Git,
    worktreesDir,
    dropIndexForPath,
  );
  const drainRetirement = singleFlight(() => sessionRetirement.drain());
  const publishWorktrees = async (): Promise<void> => {
    bus.emit('worktrees', await worktreeInventory.snapshot());
  };
  const managedWorktreesRoot = resolve(worktreesDir);
  const forceCleanupWorktree = async (id: string): Promise<boolean | null> => {
    const entry = (await worktreeInventory.snapshot()).find(
      (candidate) => worktreeId(candidate) === id,
    );
    if (!entry) return null;

    const worktreePath = resolve(entry.path);
    if (!isInside(managedWorktreesRoot, worktreePath)) {
      throw new DomainError('forbidden', 'worktree is outside Harmonic’s managed worktree root');
    }
    const workspace = await workspaces.get(entry.workspaceId);
    if (!workspace) return false;

    const removed = await Git.removeWorktreeAndDeleteBranch(
      workspace.workingDir,
      worktreePath,
      entry.branch,
      async () => isInside(managedWorktreesRoot, resolve(worktreePath)),
    );
    if (removed) {
      await dropIndexForPath(worktreePath);
      await publishWorktrees();
    }
    return removed;
  };
  const dirtyWorktreeFiles = async (id: string): Promise<string[] | null> => {
    const entry = (await worktreeInventory.snapshot()).find(
      (candidate) => worktreeId(candidate) === id,
    );
    if (!entry) return null;

    const worktreePath = resolve(entry.path);
    if (!isInside(managedWorktreesRoot, worktreePath)) {
      throw new DomainError('forbidden', 'worktree is outside Harmonic’s managed worktree root');
    }
    return entry.dirty ? Git.dirtyFiles(worktreePath) : [];
  };
  const reconcileWorktrees = singleFlight(async () => {
    const result = await worktreeReconciler.reconcile();
    await publishWorktrees();
    return result;
  });
  let runnerRef: Runner | undefined;
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
  );
  const crashRecoveryPostMergeCheck = async ({
    task,
    run,
    mergeOid,
    baseDir,
  }: {
    task: TaskRow;
    run: AttemptRow;
    mergeOid: string;
    baseDir: string;
  }) => {
    const ws = task.workspaceId == null ? undefined : await workspaces.get(task.workspaceId).catch(() => undefined);
    const { commands } = resolveVerifiers(
      ws ?? { verificationCommand: null, reviewEnabled: null, reviewPrompt: null, reviewModel: null, reviewHarness: null },
      settingsStore.getGlobal(),
    );
    if (commands.length === 0) return { pass: true, output: '' };
    mkdirSync(worktreesDir, { recursive: true });
    for (const command of commands) {
      const cmdAttempt = await runCommandVerifier({
        repoDir: baseDir,
        verifiedHeadOid: mergeOid,
        worktreePath: join(worktreesDir, `crash-recovery-postmerge-${run.id}`),
        command,
        attributes: { 'task.id': task.id, 'attempt.id': run.id },
      });
      await verificationAttempts.append(run.id, commandAttemptToInput(cmdAttempt));
      if (cmdAttempt.verdict !== 'pass') return { pass: false, output: cmdAttempt.output };
    }
    return { pass: true, output: '' };
  };
  const crashRecovery = new CrashRecoveryCoordinator(attempts, tasks, operatorSettle, {
    runPostMergeCheck: crashRecoveryPostMergeCheck,
    postMerge,
  });
  await crashRecovery.reconcile();
  for (const orphan of await tasks.list({ state: 'working' })) {
    await tasks.setState(orphan.id, 'ready');
  }
  await auth.sweepOrphanedAttemptKeys();
  await auth.sweepOrphanedConversationKeys();
  await conversations.markActiveEnded();
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
    (task) => {
      void (async () => {
        const run = (await attempts.listForTask(task.id)).at(-1);
        if (run) recordAttemptLifecycle(run, { event: 'ticket-closed', trackerRef: task.trackerRef != null ? String(task.trackerRef) : null });
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
    events: {
      onAttemptEvent: (event) => bus.emit('attempt_event', event),
      onAttemptLogEvent: (event) => bus.emitAttemptLog(event),
      onCriticLogEvent: (event) => bus.emitCriticLog(event),
      onAttemptFinished: (run) => bus.emit('attempt_changed', run),
      onAttemptUsage: (payload) => bus.emit('attempt_usage', payload),
      onStepChanged: (taskId) => bus.emit('step_changed', { taskId }),
      onEpicMergeStep: (payload) => bus.emit('epic_changed', payload),
    },
    gitBreaker,
    epicBaseNotReady: (task) => epicServiceRef?.epicBaseNotReady(task) ?? false,
    postMerge,
    worktreesDir,
    spendGuardrail: opts.runnerTuning?.spendGuardrail,
    criticDrive: opts.criticDrive,
    sessionRetirement,
    keys: {
      mint: async (attemptId) => (await auth.createKey(`attempt-${attemptId}`, { scope: 'attempt', attemptId })).token,
      revoke: (attemptId) => auth.deleteKeysForAttempt(attemptId),
    },
    autoDrive,
    urlFor: (task) => trackerManagerRef?.urlFor(task.workspaceId, task.trackerRef) ?? null,
    getWorkspace: getWorkspaceRow,
  });
  runnerRef = runner;
  await runner.backfillUsage();
  const escalation = new EscalationService(attempts, tasks, operatorSettle, mergeEffectsFor, {
    resume: (task, guidance, startNow) => runner.resumeWithGuidance(task, guidance, startNow),
    cleanup: (task, run) => runner.cleanupClosed(task, run),
    candidateHead: (task, run) => runner.candidateHead(task, run),
    verifyCandidate: (task, run, head) => runner.verifyCandidateForAccept(task, run, head),
  });
  await drainRetirement();
  scheduler.register({
    name: 'Session retirement drain',
    intervalMs: 5 * 60_000,
    run: async () => { await drainRetirement(); },
  });
  scheduler.register({
    name: 'Worktree reconciliation',
    intervalMs: 30 * 60 * 1000,
    run: async () => { await reconcileWorktrees(); },
  });
  const eventLoopTuning = opts.reliabilityTuning?.eventLoop;
  const loopMonitor =
    eventLoopTuning?.enabled === false
      ? undefined
      : new EventLoopMonitor({ probeMs: eventLoopTuning?.probeMs, stallMs: eventLoopTuning?.stallMs });
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
  const epicService = new TrackerEpicService(
    tasks,
    () => workspaces.list(),
    undefined,
    undefined,
    () => settingsStore.getGlobal(),
    epicOperations,
    (input) => runnerRef!.mergeEpicIntegration(input),
    (target, detail, escalate, retry) => runnerRef!.enqueueEpicRefreshResolution(target, detail, escalate, retry),
    epicMergeEvents,
  );
  epicServiceRef = epicService;
  const trackerManager = new TrackerPollerManager(tasks, () => workspaces.list(), epicService, undefined, undefined, scheduler);
  trackerManagerRef = trackerManager;
  for (const merged of pendingPostMerge.splice(0)) await postMerge(merged);
  scheduler.register({
    name: 'Epic reconcile',
    intervalMs: 60_000,
    run: () => trackerManager.reconcileEpics(),
  });
  bus.on('attempt_changed', () => autoRunner.poke());
  bus.on('task_changed', () => {
    void publishWorktrees().catch((error: unknown) => logger.debug(`worktree inventory refresh failed: ${String(error)}`));
  });
  bus.on('task_removed', () => {
    void publishWorktrees().catch((error: unknown) => logger.debug(`worktree inventory refresh failed: ${String(error)}`));
  });
  bus.on('attempt_changed', () => {
    void drainRetirement().catch(() => {});
  });
  bus.on('attempt_changed', (run) => {
    if (run.state === 'running') return;
    void (async () => {
      if ((await tasks.list({ state: 'ready' })).length !== 0) return;
      if ((await attempts.countRunning()) === 0) await notifier.notify('queue.idle');
    })().catch(() => {});
  });

  const ctx: AppContext = { asyncDb, statsReader, settingsStore, workspaces, tasks, attempts, sessions: sessionStore, runner, conversations, conversationDriver, permissionRules, escalation, autoRunner, guardrailEvents, verificationAttempts, trackerManager, epicService, scheduler, auth, channels, notifier, bus, worktreeInventory, forceCleanupWorktree, dirtyWorktreeFiles, reconcileWorktrees, worktreesReconciledAt: () => worktreeReconciler.reconciledAt };
  const contexts = createAppContexts(ctx);

  const app = Fastify({ logger: false }) as unknown as App;
  app.decorate('ctx', ctx);
  const registeredRoutes: RegisteredRoute[] = [];
  app.decorate('registeredRoutes', registeredRoutes);
  app.addHook('onRoute', (opts) => {
    for (const method of Array.isArray(opts.method) ? opts.method : [opts.method]) {
      registeredRoutes.push({ method, url: opts.url });
    }
  });
  app.addHook('onClose', async () => {
    trackerManager.stopAll();
    scheduler.stop();
    autoRunner.stop();
    runner.shutdown();
    conversationDriver.shutdown();
    loopMonitor?.stop();
    // asyncDb stays open: libsql rejects in-flight background reads with an unhandled CLIENT_CLOSED once closed.
    await statsReader.close();
  });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Fastify's default JSON parser throws FST_ERR_CTP_EMPTY_JSON_BODY on an empty body; optional-body POSTs send exactly that.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  const pkg = readPackageManifest();
  const specDescription = `${pkg.description}

## MCP

\`POST /mcp\` is a stateless streamable-HTTP MCP server (not a REST
endpoint, so it has no entry in this spec's paths). It authenticates the
same way as the REST API — a bearer token, either an operator API key or
the Attempt Key Harmonic injects into a spawned harness — and exposes the
agent task surface as MCP tools (task CRUD, dependencies, queue/cancel,
attempts and events). Accept/Reject are human-only and are never exposed as
MCP tools — a verifier's pass is the accept (#140, ADR-0021). An attempt-scoped
Attempt Key may call \`/mcp\` regardless of the REST restrictions noted per
endpoint below. \`force_integrate_epic\` is an operator-only tool, the same
footing as Accept/Reject: an Attempt Key can call \`/mcp\` but gets a \`forbidden\`
error from it specifically — only an operator API key (\`scope: 'full'\`) or
an authenticated session may call it.

## WebSocket

\`GET /api/ws\` is a single firehose WebSocket (also outside this spec's
paths): every attempt event, attempt state change, task state change/removal, and
Conversation event/change is broadcast to every connected client as JSON
messages of the form \`{ type: 'attempt_event' | 'attempt_changed' | 'attempt_usage' |
'task_changed' | 'task_removed' | 'conversation_event' | 'conversation_changed' |
'permission_request' | 'scheduled-jobs' | 'operations', ... }\`, using the same Task/Attempt/Conversation/Scheduled Job/Operation shapes
served over REST. \`attempt_usage\` is a live-usage snapshot for a running Attempt
(tokens, context fill, derived Cost, current-activity line, and Process
Tree), pushed about once a second while the Attempt tails its native log.
\`task_removed\` (issue #162) announces a hard-deleted Task's id (\`{ type:
'task_removed', id }\`) — the row is gone, not another state change.
\`scheduled-jobs\` announces the full Scheduled Job registry snapshot, matching
\`GET /api/scheduled-jobs\`.
\`operations\` announces an Operation lifecycle event, matching the operation shape
served by \`GET /api/operations\`.
\`permission_request\` announces a Harness blocked on an
operator permission decision in a Conversation (ADR-0007), answered via
\`POST /conversations/:id/permissions/:reqId\`. Authenticate by passing the
session token or an API key as \`?token=\` (WebSocket clients cannot set an
Authorization header). A \`read\`-scoped key gets a filtered firehose — only
\`task_changed\`, \`task_removed\`, \`attempt_changed\`, \`attempt_event\`, \`attempt_usage\`, and
\`operations\` — with the Conversation and permission traffic dropped.

## Read scope

A \`read\`-scoped API key (created via \`POST /api/keys\` with
\`{ "scope": "read" }\`) is a viz-client credential: it may \`GET\` tasks,
attempts, maps, Operations (\`/api/operations\`), and the instance-wide Activity snapshot (\`/api/activity\`,
filtered to Attempts only for a read key), and open the WebSocket (filtered as
above). Every mutation and the whole operator surface (keys, config,
channels, Conversations) is blocked. There is no \`map_changed\` event — a
client re-fetches \`/maps\` on reconnect or when it sees a \`mapRef\` it has
not resolved yet.`;
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: pkg.name, version: pkg.version, description: specDescription },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'A key created via POST /api/keys, sent as `Authorization: Bearer <token>`.',
          },
          sessionCookie: {
            type: 'apiKey',
            in: 'cookie',
            name: SESSION_COOKIE,
            description: 'The session cookie set by POST /api/auth/login.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    // Without transformObject, fastify-type-provider-zod emits `$ref`s for `.meta({ id })` schemas but never writes them into components.schemas.
    transformObject: jsonSchemaTransformObject,
  });

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if ((!path.startsWith('/api') && !path.startsWith('/mcp')) || PUBLIC_API_PATHS.has(path)) return;

    if (!(await auth.hasPassword())) return;

    const forbidden = () =>
      reply
        .status(403)
        .send({ error: { code: 'forbidden', message: 'this key is scoped to its attempt and cannot access this endpoint' } });

    const scopeAllows = (scope: string): boolean =>
      scope === 'full' ||
      (scope === 'read'
        ? readScopeAllowed(path, req.method)
        : scopedKeyAllowed(path));

    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    let scopedKeyRejected = false;
    if (bearer) {
      const key = await auth.verifyKey(bearer);
      if (key) {
        if (scopeAllows(key.scope)) return;
        scopedKeyRejected = true;
      }
    }
    if (auth.validateSession(req.cookies[SESSION_COOKIE])) return;
    if (path === '/api/ws') {
      const queryToken = (req.query as Record<string, string | undefined>)?.token;
      if (queryToken) {
        if (auth.validateSession(queryToken)) return;
        const key = await auth.verifyKey(queryToken);
        if (key) {
          if (scopeAllows(key.scope)) return;
          scopedKeyRejected = true;
        }
      }
    }

    if (scopedKeyRejected) return forbidden();
    return reply.status(401).send({ error: { code: 'unauthenticated', message: 'authentication required' } });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: {
          code: 'validation',
          message: err.validation
            .map((i) => `${i.instancePath.slice(1).replace(/\//g, '.')}: ${i.message}`)
            .join('; '),
        },
      });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'validation', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
      });
    }
    const cause = err instanceof Error ? err : undefined;
    logger.error(`unhandled error serving ${req.method} ${req.url}: ${cause?.message ?? String(err)}`, {
      method: req.method,
      url: req.url,
      error: cause?.message ?? String(err),
      ...(cause?.stack ? { stack: cause.stack } : {}),
    });
    return reply.status(500).send({ error: { code: 'internal', message: 'internal server error' } });
  });

  await app.register((fastify) => taskRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => mapRoutes(fastify, contexts.tracking), { prefix: '/api' });
  await app.register((fastify) => workspaceRoutes(fastify, contexts.tracking), { prefix: '/api' });
  await app.register(conversationRoutes, { prefix: '/api' });
  await app.register((fastify) => permissionRuleRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => configRoutes(fastify, contexts.execution), { prefix: '/api' });
  await app.register((fastify) => authRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => statsRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => activityRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => operationRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => scheduledJobRoutes(fastify, contexts.tracking), { prefix: '/api' });
  await app.register((fastify) => worktreeRoutes(fastify, contexts.execution), { prefix: '/api' });
  await app.register(harnessRoutes, { prefix: '/api' });
  await app.register((fastify) => channelRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register(fsRoutes, { prefix: '/api' });
  await app.register((fastify) => epicRoutes(fastify, contexts.tracking), { prefix: '/api' });
  await app.register(openapiRoutes, { prefix: '/api' });

  app.post('/mcp', { schema: { hide: true } }, async (req, reply) => {
    const operator = await requestIsOperator(req, auth);
    const mcp = buildMcpServer(ctx, { operator });
    // sessionIdGenerator: undefined selects the MCP SDK's stateless mode; its option types don't satisfy exactOptionalPropertyTypes.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as any);
    reply.hijack();
    await mcp.connect(transport as any);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    reply.raw.on('close', () => {
      void transport.close();
      void mcp.close();
    });
  });

  app.addHook('onListen', async () => {
    const address = app.server.address();
    if (address && typeof address === 'object') {
      const host = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
      const mcpUrl = `http://${host}:${address.port}/mcp`;
      runner.mcpUrl = mcpUrl;
      conversationDriver.mcpUrl = mcpUrl;
    }
    autoRunner.start();
    autoRunner.poke();
    scheduler.start();
    await trackerManager.sync();
    loopMonitor?.start();
  });
  await app.register((fastify) => wsRoutes(fastify, ctx), { prefix: '/api' });

  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      // index.html must never be cached (it pins the content-hashed asset names); hashed assets are immutable.
      setHeaders(reply, filePath) {
        if (filePath.endsWith('index.html')) {
          reply.header('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${sep}assets${sep}`)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        // A missing asset must 404, not return index.html with 200 that the browser executes as JS/CSS.
        const path = req.url.split('?')[0] ?? '';
        if (path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(path)) {
          return reply.status(404).send({ error: { code: 'not_found', message: 'not found' } });
        }
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'not_found', message: 'not found' } });
    });
  }

  return app;
}
