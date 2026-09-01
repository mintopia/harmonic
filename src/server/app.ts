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
import { join, dirname, sep } from 'node:path';
import { defaultBranchPostMerge, type PostMergeHook } from '../execution/branch-merge.js';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { openAsyncDb, type AsyncDbHandle } from '../db/async.js';
import { openStatsReader, type StatsReader } from '../db/stats-reader.js';
import type { AppConfig, DeepPartial } from '../config.js';
import { ConfigStore } from './config-store.js';
import { SettingsStore } from './settings-store.js';
import { TaskService } from '../domain/tasks.js';
import { AttemptStore } from '../domain/attempts.js';
import { ConversationStore } from '../domain/conversations.js';
import { WorkspaceService } from '../domain/workspaces.js';
import { PermissionRuleStore } from '../domain/permission-rules.js';
import { EscalationService } from '../domain/escalation.js';
import { AttemptSettleCoordinator } from '../domain/attempt-settle.js';
import { SessionStore } from '../domain/sessions.js';
import { SessionRetirementCoordinator } from '../domain/session-retirement-coordinator.js';
import { dropIndexForPath } from '../execution/code-index.js';
import { WorktreeReconciler } from '../domain/worktree-reconciler.js';
import { FlaggedWorktreeRegistry } from '../domain/flagged-worktrees.js';
import { Git } from '../execution/git.js';
import { GuardrailEventStore } from '../domain/guardrail-events.js';
import { VerificationAttemptStore } from '../domain/verification-attempts.js';
import type { MergeEffectExec } from '../domain/merge.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import { CrashRecoveryCoordinator } from '../domain/crash-recovery.js';
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
import { flaggedWorktreeRoutes } from './routes/flagged-worktrees.js';
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
  /** Test-only Runner cadence overrides (issue #128); absent uses production defaults. */
  runnerTuning?: { spendGuardrail?: { pollMs?: number; graceMs?: number } } | undefined;
  /** Event-loop stall monitor overrides (issue #200). `enabled: false` turns
   * the probe off (tests keep it off to avoid stall-log noise); otherwise
   * production defaults apply (~1s probe, 200ms stall threshold). */
  reliabilityTuning?: { eventLoop?: { enabled?: boolean; probeMs?: number; stallMs?: number } } | undefined;
  /** Test-only agent-critic drive override (issue #164): a fake
   * {@link CriticHarnessDrive} the wired critic uses instead of spawning a real
   * harness, so an end-to-end Runner test can script a critic verdict. Absent →
   * the real `createAcpCriticDrive` (production). */
  criticDrive?: CriticHarnessDrive | undefined;
  /** Test-only Scheduled Job registrations, used to prove the scheduler's end-to-end surface without pre-empting the follow-on Job tickets. */
  scheduledJobRegistrations?: ScheduledJobRegistration[] | undefined;
  /**
   * Registers telemetry's periodic metrics-summary reader as a Scheduler Job
   * (ADR-0010, issue #386) instead of leaving it an invisible `setInterval` —
   * `intervalMs` mirrors the OTLP metric export cadence the caller configured,
   * `flush` is the same `TelemetryController.flushMetricSummary` telemetry
   * itself flushes at shutdown. Undefined when telemetry owns its own timer
   * (e.g. a caller that never wires a Scheduler into this process).
   */
  metricsSummary?: { intervalMs: number; flush: () => Promise<void> } | undefined;
}

/** Paths reachable without authentication. */
const PUBLIC_API_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/me',
  // The OpenAPI spec documents an already-open-source project (ADR-0005).
  '/api/openapi.json',
  '/api/openapi.yaml',
]);

/**
 * What an ephemeral scoped key (a Attempt Key or a Conversation Key) may reach:
 * the agent surface from issue 13 — task CRUD, dependencies, queue/cancel,
 * attempts and events, and MCP (which gates its own tool list). The escalation
 * actions (Accept / Reject with guidance / Close) are always human-only.
 * Everything else — key management, config, channels, Conversations — is
 * operator-only.
 */
function scopedKeyAllowed(path: string): boolean {
  if (path.startsWith('/mcp')) return true;
  // Force-complete is a manual operator override (kills a running agent mid-work,
  // skips verification) with no agent-facing use — agents signal via finish_task.
  if (/^\/api\/tasks\/\d+\/complete$/.test(path)) return false;
  // Steering redirects a running agent — a manual operator override; an agent
  // does not steer itself (it drives its own turn).
  if (/^\/api\/tasks\/\d+\/steer$/.test(path)) return false;
  // The whole-Epic force-integrate (issue #161) is a manual operator override, same
  // footing as complete/steer — an agent never force-integrates an Epic on
  // its own initiative. This path matches no rule below and falls through to
  // the default `false`; this early return exists only to document the
  // decision alongside its siblings.
  if (/^\/api\/workspaces\/\d+\/epics\/\d+\/force-integrate$/.test(path)) return false;
  // The Epic read model (issue #167, ADR-0026) surfaces server-only
  // integration-branch/integrate-coordinator state alongside board data an agent
  // could otherwise infer from its own Task/dependency surface — kept on the
  // same operator-only footing as force-integrate. This path matches no rule below
  // and falls through to the default `false`; this early return exists only
  // to document the decision alongside its siblings.
  if (/^\/api\/workspaces\/\d+\/epics(\/\d+)?$/.test(path)) return false;
  // The escalation actions are human-only, always — never reachable by an attempt-scoped key.
  if (/^\/api\/tasks\/\d+\/(accept|reject|close)$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/channels(\/|$)/.test(path)) return false;
  if (path === '/api/tasks' || path.startsWith('/api/tasks/')) return true;
  if (path.startsWith('/api/attempts')) return true;
  return false;
}

/**
 * What a `read`-scoped key reaches (issue #35): read-only board access for a
 * viz client — GET tasks/attempts/maps, the instance-wide Activity snapshot, and
 * the WS handshake. Every mutation is blocked (GET-only), as is the operator
 * surface (keys, config, channels, Conversations). The per-Task channel
 * overrides are operator config, so they're excluded even though they hang off
 * /api/tasks. /api/activity is in the read set but self-filters to Attempts only
 * (issue #51) — the same rule the firehose applies to Conversation traffic.
 */
function readScopeAllowed(path: string, method: string): boolean {
  if (method !== 'GET') return false;
  if (path === '/api/ws') return true;
  // The Epic read model (issue #167, ADR-0026) is operator-only, same footing
  // as force-integrate — not the viz client's read-only board surface. This path
  // matches no rule below and falls through to the default `false`; this
  // early return exists only to document the decision alongside its siblings.
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

/**
 * Whether a request carries an **operator** credential — a full-scope API key or
 * an authenticated session — resolved in the same bearer → cookie order the
 * auth hook authenticates in. A query token is never an operator credential
 * (it is websocket-only). Ungated mode (no operator password set)
 * treats every caller as an operator, exactly as the auth hook skips entirely in
 * that mode. The `/mcp` handler uses this to gate operator-only tools (issue
 * #125): a Attempt Key is a valid MCP caller but is never an operator. Kept as one
 * function so the operator determination lives in a single place rather than
 * being re-derived per gate.
 */
async function requestIsOperator(req: FastifyRequest, auth: AuthService): Promise<boolean> {
  if (!(await auth.hasPassword())) return true;
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer && (await auth.verifyKey(bearer))?.scope === 'full') return true;
  if (auth.validateSession(req.cookies[SESSION_COOKIE])) return true;
  return false;
}

export interface AppContext {
  asyncDb: AsyncDbHandle;
  statsReader: StatsReader;
  settingsStore: SettingsStore;
  configStore: ConfigStore;
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
  scheduler: Scheduler;
  auth: AuthService;
  channels: ChannelService;
  notifier: Notifier;
  bus: EventBus;
  flaggedWorktrees: FlaggedWorktreeRegistry;
}

/** One Fastify route registration, as captured by the `onRoute` hook below. */
export interface RegisteredRoute {
  method: string;
  url: string;
}

export type App = FastifyInstance & { ctx: AppContext; registeredRoutes: RegisteredRoute[] };

export async function buildApp(opts: AppOptions): Promise<App> {
  // The async libsql facade is the sole DB path (ADR-0029 contract step, #216):
  // it owns boot — migrations, the FK dance, the Default-Workspace backfill — and
  // is the single writer through its queue.
  const asyncDb = await openAsyncDb(opts.dataDir);
  // #257 / ADR-0029 §5: local libsql runs file-backed queries inline. Give the
  // growing Stats range scans a dedicated worker and typed request shape.
  const statsReader = openStatsReader(opts.dataDir);
  const worktreesDir = join(opts.dataDir, 'worktrees');
  const bus = new EventBus();
  const scheduler = new Scheduler(asyncDb, (jobs) => bus.emit('scheduled_jobs', jobs));
  // A real, low-frequency exemplar for the registry itself. It removes durable
  // rows for Jobs no longer registered after a deployment; follow-on tickets
  // register the operational drains and per-Workspace jobs that need this hygiene.
  scheduler.register({
    name: 'Scheduled Job registry cleanup',
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => scheduler.prune(),
  });
  for (const registration of opts.scheduledJobRegistrations ?? []) scheduler.register(registration);
  // ADR-0010's "Metrics summary" reader (issue #386): previously an unmanaged
  // `setInterval` in telemetry.ts with no registry row or API visibility.
  if (opts.metricsSummary) {
    scheduler.register({
      name: 'Metrics summary',
      intervalMs: opts.metricsSummary.intervalMs,
      run: opts.metricsSummary.flush,
    });
  }
  operationRegistry.setBus(bus);
  const settingsStore = await SettingsStore.create(opts.dataDir, opts.configOverrides);
  const configStore = new ConfigStore(settingsStore);
  const workspaces = new WorkspaceService(asyncDb, settingsStore);
  const channels = new ChannelService(asyncDb);
  const notifier = new Notifier(channels, logger.error);
  const tasks = new TaskService(
    asyncDb,
    () => configStore.get(),
    () => workspaces.list(),
    (task) => bus.emit('task_changed', task),
    (event, task) => void notifier.notify(event, task).catch(() => {}),
    (id) => bus.emit('task_removed', { id }),
  );
  const attempts = new AttemptStore(asyncDb);
  const guardrailEvents = new GuardrailEventStore(asyncDb);
  const verificationAttempts = new VerificationAttemptStore(asyncDb);
  const conversations = new ConversationStore(asyncDb, (conversation) => bus.emit('conversation_changed', conversation));
  const permissionRules = new PermissionRuleStore(asyncDb);
  const auth = new AuthService(asyncDb);
  // An explicit empty password clears the gate; undefined leaves it as-is.
  if (opts.password !== undefined) {
    if (opts.password === '') await auth.clearPassword();
    else await auth.setPassword(opts.password);
  }
  const conversationDriver = new ConversationDriver(conversations, () => configStore.get(), {
    events: {
      onEvent: (event) => bus.emit('conversation_event', event),
      onPermissionRequest: (pending) => bus.emit('permission_request', pending),
    },
    rules: permissionRules,
    // A Conversation Key (its lifetime follows the Conversation's) plus the
    // MCP endpoint let the chatting agent drive the fleet (issue 16).
    keys: {
      mint: async (conversationId) =>
        (await auth.createKey(`conversation-${conversationId}`, { scope: 'conversation', conversationId })).token,
      revoke: (conversationId) => auth.deleteKeysForConversation(conversationId),
    },
  });
  // Accepting an escalated worktree-mode task merges the run's branch through
  // the shared settle coordinator, so Accept is race-safe against a concurrent
  // operator cancel (`mergeEffectsFor` below runs the same one merge policy as
  // the automated path, ADR-0001 #383).
  // Session retirement (issue #148, reliability-design Unit C): the sole owner of
  // builder-worktree removal. Its sync settle-hook is injected into every settle
  // coordinator (the operator-side one below and the Runner's own, via options) so
  // every terminal disposition records its Session's retirement intent; its
  // async `drain` performs the actual worktree removal — at boot, and on every
  // `attempt_changed` below (a settle emits one, so an accepted/cancelled Session's
  // worktree is reclaimed promptly).
  const sessionStore = new SessionStore(asyncDb);
  const sessionRetirement = new SessionRetirementCoordinator(
    sessionStore,
    attempts,
    (repoDir, worktreePath) =>
      Git.removeWorktree(repoDir, worktreePath)
        // Reap the worktree's jCodeMunch index once its files are gone (no-op if
        // it was never indexed, e.g. the CLI is absent); `code-index.ts`.
        .then(() => dropIndexForPath(worktreePath)),
  );
  // Boot/periodic worktree reconciliation (ADR-0010, issue #386): Task-owned,
  // not Run/Session-owned — it recreates a live Task's missing worktree and
  // removes only a CLEAN terminal Task's worktree, flagging anything dirty,
  // unreadable, or unrecognized for operator disposition instead of deleting it.
  const flaggedWorktrees = new FlaggedWorktreeRegistry(bus);
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
    flaggedWorktrees,
    dropIndexForPath,
  );
  // Single-flight the retirement drain (issue #219): it is fired on every
  // `attempt_changed`, so a burst of settling Runs would otherwise fan out
  // overlapping drains that each re-observe the same `retiring` Sessions and
  // spawn `git worktree remove` for them in parallel — a subprocess flood on the
  // event loop. Coalescing collapses the burst into one pass plus a trailing
  // rerun that sweeps anything that settled mid-pass.
  const drainRetirement = singleFlight(() => sessionRetirement.drain());
  let runnerRef: Runner | undefined;
  let trackerManagerRef: TrackerPollerManager | undefined;
  const pendingPostMerge: Parameters<PostMergeHook>[0][] = [];
  const postMerge: PostMergeHook = defaultBranchPostMerge(
    async (repoDir, defaultBranch) => {
      try {
      if (!trackerManagerRef) {
        pendingPostMerge.push({ repoDir, baseBranch: defaultBranch });
        return;
      }
      await trackerManagerRef.refreshAfterDefaultBranchAdvance(repoDir, defaultBranch);
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
  // The deterministic post-merge check crash recovery re-runs on a worktree
  // merge that already landed (ADR-0001): the SAME two primitives the live
  // merge policy's `runPostMergeCheck` dep runs (`resolveVerifiers` +
  // `runCommandVerifier`), just invoked for a merge git shows already
  // happened rather than one this process just performed. No critic — the
  // critic already reviewed this diff on the candidate before it merged.
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
      configStore.get(),
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
  // Crash recovery before anything can execute (ADR-0001 "Scope and design
  // ceiling": "Crash recovery may rely on git's own idempotence and on
  // rebuilding in-memory state from the DB at boot"). No journal, no queue: a
  // worktree-mode Run whose branch already landed in its base (per
  // `git merge-base --is-ancestor`) just gets its post-merge check re-run
  // (revert-on-red), and everything still `running` after that is failed
  // "interrupted" — never silently re-run.
  const crashRecovery = new CrashRecoveryCoordinator(attempts, tasks, operatorSettle, {
    runPostMergeCheck: crashRecoveryPostMergeCheck,
    postMerge,
  });
  await crashRecovery.reconcile();
  // A fresh process is executing nothing, so any Task still `working` was
  // orphaned by the restart — hand it back to ready (an interruption is not a
  // failed Attempt, ADR-0041). This is a superset of "re-queue the interrupted
  // runs' tasks": it also catches a mirrored Task that crashed between the
  // ready→working flip (the lock) and its Run being created. No orphaned Run
  // row exists for that one, so the run sweep alone left it stuck `working`
  // while its ticket stayed open — and the poll never rescues it
  // (upsertMirrored refuses to move a Task off `working`). Crash recovery just
  // failed every Run still `running` (there is no resume-re-entry exemption
  // under ADR-0001 — a restart-interrupted Session-bound Run resumes through
  // the ordinary Attempt-continuation decision, ADR-0005, on the Task's next
  // pick), so no `working` Task can have a surviving `running` Run here.
  for (const orphan of await tasks.list({ state: 'working' })) {
    await tasks.setState(orphan.id, 'ready');
  }
  // Attempt Keys of every non-running attempt die here — catches keys orphaned by
  // a crash or restart. Conversation Keys can never survive a restart (their
  // warm process is gone), so every one present at boot is orphaned (issue 16).
  await auth.sweepOrphanedAttemptKeys();
  await auth.sweepOrphanedConversationKeys();
  // A Conversation cannot survive a restart — its warm harness is gone — so
  // any still marked active is ended; its transcript survives read-only (issue 15).
  await conversations.markActiveEnded();
  // Auto-drive mirrored Tasks (issue #33): the Drive Prompt + completion /
  // failure decisions. Its {url} comes from the Task's Workspace poll loop's
  // last scan; the manager is built below, so bind it late through this holder.
  // A Task's Workspace row, resolved for per-Workspace setting overrides
  // (ADR-0012/ADR-0044). Shared by AutoDrive's `drive.*` resolution and the
  // Runner's guardrail/prompt resolution so both read the same source.
  const getWorkspaceRow = async (id: number | null) => {
    if (id == null) return undefined;
    try {
      return await workspaces.get(id);
    } catch {
      return undefined;
    }
  };
  const autoDrive = new AutoDrive(
    () => configStore.get(),
    (task) => trackerManagerRef?.urlFor(task.workspaceId, task.trackerRef) ?? null,
    undefined,
    getWorkspaceRow,
    (workspaceId, ref) => tasks.epicKind(workspaceId, ref),
  );
  // The merging effects an operator Accept applies (issue #115, ADR-0041): a
  // worktree Task's merge, journaled as `target-ref` (idempotency identity is
  // the base/run branch pair — stable for the Run's whole lifetime and known
  // before the merge ever runs, so `recordIntent` doesn't need to wait on a Git
  // call), then a mirrored Task's ticket close (`ticket-close`, idempotent via
  // the closed-state read). Empty for a direct-mode native Task — "no effects
  // -> straight merge". Crash recovery re-applies the same effects.
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
        // Operator Accept runs the same one merge policy as the automated path
        // (ADR-0001, #383): `git merge --no-ff` under the base repo mutex,
        // bounded resolve turns, post-merge check, revert-on-red. A base that
        // moved since verification is reconciled by the merge commit — no
        // rebase mode. Only a genuine conflict or a red post-merge check
        // escalates, mapped here to a failed effect so the ticket comes back to
        // the operator; the coordinator settles the success as `operator-accept`.
        apply: async () => {
          const outcome = await runnerRef!.mergeAcceptedBranch(task, run);
          if (outcome.kind === 'escalated') return { ok: false, detail: outcome.message };
          return { ok: true, observed: { baseBranch, branch, oid: outcome.mergeOid } };
        },
      },
      ...effects,
    ];
  };
  const epicOperations = new EpicOperations();
  // Per-context git circuit breaker (issue #199): shared by the Runner (which
  // records a workspace-prep git fast-fail into it) and the Auto-Runner (which
  // skips a Task whose base repo is in the resulting backoff window), so a
  // doomed context is escalated/backed off instead of being re-spawned forever.
  const gitBreaker = new GitCircuitBreaker();
  const runner = new Runner(tasks, asyncDb, () => configStore.get(), {
    events: {
      onAttemptEvent: (event) => bus.emit('attempt_event', event),
      onAttemptLogEvent: (event) => bus.emitAttemptLog(event),
      onAttemptFinished: (run) => bus.emit('attempt_changed', run),
      onAttemptUsage: (payload) => bus.emit('attempt_usage', payload),
    },
    gitBreaker,
    // Start-funnel gate (issue #159, git ground-truth #231): refuse to spawn a
    // worktree Run for an Epic member whose integration base isn't ready — set to
    // an `epic/<ref>` branch that doesn't currently exist in git, or still
    // unresolved. Routed to the Task's own Workspace coordinator via the forward
    // ref (like the Auto-Runner gate), so a hand-started member is blocked
    // identically to an auto-picked one.
    epicBaseNotReady: (task) => trackerManagerRef?.epicBaseNotReady(task) ?? false,
    postMerge,
    worktreesDir,
    spendGuardrail: opts.runnerTuning?.spendGuardrail,
    criticDrive: opts.criticDrive,
    // The Runner's own settle coordinator drives most terminal dispositions
    // (drive-loop, operator-cancel, auto-accept merge); feed it the same
    // retirement hook so those Sessions retire too (issue #148).
    sessionRetirement,
    keys: {
      mint: async (attemptId) => (await auth.createKey(`attempt-${attemptId}`, { scope: 'attempt', attemptId })).token,
      revoke: (attemptId) => auth.deleteKeysForAttempt(attemptId),
    },
    autoDrive,
    // The critic's `{url}` interpolation token (same resolver AutoDrive uses);
    // independent of autoDrive so native Runs interpolate too.
    urlFor: (task) => trackerManagerRef?.urlFor(task.workspaceId, task.trackerRef) ?? null,
    getWorkspace: getWorkspaceRow,
  });
  // Close the forward reference the tracker manager's epic callbacks hold
  // (`mergeEpicIntegration`, `enqueueEpicRefreshResolution`) — exactly as
  // `trackerManagerRef = trackerManager` does below.
  runnerRef = runner;
  // Heal runs whose usage collection raced the harness's log flush —
  // their session logs are settled on disk by now.
  await runner.backfillUsage();
  const escalation = new EscalationService(attempts, tasks, operatorSettle, mergeEffectsFor, {
    resume: (task, guidance, startNow) => runner.resumeWithGuidance(task, guidance, startNow),
    cleanup: (task, run) => runner.cleanupClosed(task, run),
    candidateHead: (task, run) => runner.candidateHead(task, run),
    verifyCandidate: (task, run, head) => runner.verifyCandidateForAccept(task, run, head),
  });
  // Session-retirement drain at boot (issue #148): reclaim any builder worktree
  // owed removal by a Session left `retiring` (a crash mid-removal) or an `idle`
  // Session whose retention deadline lapsed while the process was down.
  await drainRetirement();
  // Recurring operational drains are Scheduler Jobs so their timing and result
  // facts share one visible, durable surface (issue #305).
  scheduler.register({
    name: 'Session retirement drain',
    intervalMs: 5 * 60_000,
    run: async () => { await drainRetirement(); },
  });
  scheduler.register({
    name: 'Worktree reconciliation',
    intervalMs: 30 * 60 * 1000,
    run: async () => { await worktreeReconciler.reconcile(); },
  });
  // Event-loop stall monitor (issue #200 / ADR-0029 §5): synchronous SQLite
  // shares the loop with every request, so a slow query or a non-yielding loop
  // freezes the whole server. This probes loop delay and logs a stall as a
  // legible event instead of a silent hang. Constructed here but *started* in
  // the onListen hook below, once all synchronous boot work — migrate, reconcile,
  // drain, and the route/OpenAPI schema registration that follows — is done, so
  // startup CPU is never misread as a stall. Off in tests via reliabilityTuning.
  const eventLoopTuning = opts.reliabilityTuning?.eventLoop;
  const loopMonitor =
    eventLoopTuning?.enabled === false
      ? undefined
      : new EventLoopMonitor({ probeMs: eventLoopTuning?.probeMs, stallMs: eventLoopTuning?.stallMs });
  // The advisory-assignment coordinator (issue #32) is per-Workspace (issue
  // #45); the Auto-Runner routes a mirrored Task's advisory claim step to
  // the coordinator of the Task's own Workspace poll loop (undefined ⇒ no live
  // loop ⇒ proceed without a tracker claim).
  const mirror: MirrorClaim = {
    advertiseClaim: async (task) => {
      await trackerManagerRef?.coordinatorFor(task.workspaceId)?.advertiseClaim(task);
    },
  };
  const autoRunner = new AutoRunner(
    tasks,
    attempts,
    runner,
    () => configStore.get(),
    () => workspaces.list(),
    {
      mirror,
      // Parallel-Epic pick gate (issue #159): route to the Task's own Workspace
      // poll loop, which owns its per-Epic integration-branch coordinator. No live
      // loop ⇒ not gated, so a native-only / tracking-off Workspace is unaffected.
      epicBaseNotReady: (task) => trackerManagerRef?.epicBaseNotReady(task) ?? false,
      gitBreaker,
    },
  );
  // One tracker poll loop per tracker-enabled Workspace (issues #30, #45). Polls
  // sync tracker facts only; Auto-Runner scheduling is independent of polling.
  const trackerManager = new TrackerPollerManager(
    tasks,
    () => workspaces.list(),
    undefined,
    undefined,
    // Resolve each Workspace's Verification verifiers for the whole-Epic merge
    // (issue #161): read per poll so a config change follows without a rebuild.
    () => configStore.get(),
    epicOperations,
    scheduler,
    undefined,
    (input) => runnerRef!.mergeEpicIntegration(input),
    (target, detail, escalate, retry) => runnerRef!.enqueueEpicRefreshResolution(target, detail, escalate, retry),
  );
  trackerManagerRef = trackerManager; // late-bind for AutoDrive's {url} resolver + the pick router above
  for (const merged of pendingPostMerge.splice(0)) await postMerge(merged);
  scheduler.register({
    name: 'Epic reconcile',
    intervalMs: 60_000,
    run: () => trackerManager.reconcileEpics(),
  });
  // A settled Run frees a Machine Ceiling slot, so it must immediately refill
  // without waiting for the scheduler interval.
  bus.on('attempt_changed', () => autoRunner.poke());
  // A settle emits `attempt_changed` right after it records a Session's retirement
  // intent (issue #148); drain here so an accepted/cancelled/abandoned Session's
  // builder worktree is reclaimed promptly, and any idle Session past its
  // retention deadline is swept on the next run activity. Best-effort — a drain
  // hiccup must never break the event fan-out.
  bus.on('attempt_changed', () => {
    void drainRetirement().catch(() => {});
  });
  // The boot-time poke happens in the onListen hook below, after the MCP
  // endpoint is known — so even the first auto-started run gets its
  // scoped key + endpoint injected.
  // queue.idle: the last actively-executing run drained and nothing is waiting.
  bus.on('attempt_changed', (run) => {
    if (run.state === 'running') return;
    // Both the ready-Task probe and the running-Run count are async reads now;
    // run them in a fire-and-forget chain so the EventBus listener stays sync.
    void (async () => {
      if ((await tasks.list({ state: 'ready' })).length !== 0) return;
      if ((await attempts.countRunning()) === 0) await notifier.notify('queue.idle');
    })().catch(() => {});
  });

  const ctx: AppContext = { asyncDb, statsReader, settingsStore, configStore, workspaces, tasks, attempts, sessions: sessionStore, runner, conversations, conversationDriver, permissionRules, escalation, autoRunner, guardrailEvents, verificationAttempts, trackerManager, scheduler, auth, channels, notifier, bus, flaggedWorktrees };

  const app = Fastify({ logger: false }) as unknown as App;
  app.decorate('ctx', ctx);
  // Every route registration, method(s) + url, captured as routes are added
  // below — lets tests assert full OpenAPI coverage against the routes
  // Fastify actually serves, instead of a hand-maintained list (ADR-0005).
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
    // `asyncDb` is deliberately NOT closed here: shutdown races best-effort
    // background reads (autoRunner poke, the queue-idle probe below) that a
    // closed client would reject as unhandled `CLIENT_CLOSED`. It is released
    // on process exit.
    await statsReader.close();
  });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  // Every route below declares its request/response shapes as zod schemas
  // (ADR-0005); these compilers make Fastify validate/serialize against
  // them, and @fastify/swagger turns the same schemas into the spec served
  // at /api/openapi.{json,yaml}.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Treat an empty `application/json` body as no body. The optional-body POSTs
  // (cancel/requeue/uncancel — `.nullish()` schemas) are routinely
  // called with a JSON content-type but no bytes; Fastify's default parser
  // throws FST_ERR_CTP_EMPTY_JSON_BODY on that, which the error handler doesn't
  // recognise and turns into a 500. Parse empty (or whitespace-only) as
  // `undefined` so the optional schema accepts it; a non-empty body parses as
  // before (and still surfaces malformed JSON as an error), so `/mcp`'s reliance
  // on the parsed `req.body` is unaffected.
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
  // MCP and the WebSocket are not modeled as OpenAPI paths (neither is a
  // request/response REST endpoint) — they're described here in prose
  // instead (ADR-0005).
  const specDescription = `${pkg.description}

## MCP

\`POST /mcp\` is a stateless streamable-HTTP MCP server (not a REST
endpoint, so it has no entry in this spec's paths). It authenticates the
same way as the REST API — a bearer token, either an operator API key or
the Attempt Key Harmonic injects into a spawned harness — and exposes the
agent task surface as MCP tools (task CRUD, dependencies, queue/cancel,
runs and events). Accept/Reject are human-only and are never exposed as
MCP tools — a verifier's pass is the accept (#140, ADR-0021). A attempt-scoped
Attempt Key may call \`/mcp\` regardless of the REST restrictions noted per
endpoint below. \`force_integrate_epic\` is an operator-only tool, the same
footing as Accept/Reject: a Attempt Key can call \`/mcp\` but gets a \`forbidden\`
error from it specifically — only an operator API key (\`scope: 'full'\`) or
an authenticated session may call it.

## WebSocket

\`GET /api/ws\` is a single firehose WebSocket (also outside this spec's
paths): every run event, run state change, task state change/removal, and
Conversation event/change is broadcast to every connected client as JSON
messages of the form \`{ type: 'attempt_event' | 'attempt_changed' | 'attempt_usage' |
'task_changed' | 'task_removed' | 'conversation_event' | 'conversation_changed' |
'permission_request' | 'scheduled-jobs' | 'operations', ... }\`, using the same Task/Run/Conversation/Scheduled Job/Operation shapes
served over REST. \`attempt_usage\` is a live-usage snapshot for a running Run
(tokens, context fill, derived Cost, current-activity line, and Process
Tree), pushed about once a second while the Run tails its native log.
\`task_removed\` (issue #162) announces a hard-deleted Task's id (\`{ type:
'task_removed', id }\`) — the row is gone, not another state change.
\`scheduled-jobs\` announces the full Scheduled Job registry snapshot, matching
\`GET /api/scheduled-jobs\` (ADR-0038).
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
runs, maps, Operations (\`/api/operations\`), and the instance-wide Activity snapshot (\`/api/activity\`,
filtered to Runs only for a read key), and open the WebSocket (filtered as
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
    // Without this, every `.meta({ id })` schema in schemas.ts still emits a
    // `$ref: '#/components/schemas/X'` at each use site, but nothing ever
    // writes the targets into `components.schemas` — leaving the published
    // spec full of dangling pointers (invalid for codegen, and rendered as a
    // literal `{"$ref": …}` by the API page). transformObject walks zod's
    // global registry and materializes them.
    transformObject: jsonSchemaTransformObject,
  });

  // Every API surface is authenticated: cookie sessions for the SPA,
  // bearer API keys for programmatic access (token also accepted as a
  // query param for WebSocket clients that can't set headers). The MCP
  // endpoint shares the same authorization model.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if ((!path.startsWith('/api') && !path.startsWith('/mcp')) || PUBLIC_API_PATHS.has(path)) return;

    // Open by default: with no operator password set, Harmonic runs ungated —
    // a local single-user tool. Setting a password (once) turns the gate on.
    if (!(await auth.hasPassword())) return;

    const forbidden = () =>
      reply
        .status(403)
        .send({ error: { code: 'forbidden', message: 'this key is scoped to its run and cannot access this endpoint' } });

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

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message } });
    }
    // Schema-validation failures on zod-declared routes (ADR-0005) — same
    // error shape as the ad-hoc `.parse()` calls below, so callers see one
    // validation error contract regardless of which routes have migrated.
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
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'internal server error' } });
  });

  await app.register(taskRoutes, { prefix: '/api' });
  await app.register(mapRoutes, { prefix: '/api' });
  await app.register(workspaceRoutes, { prefix: '/api' });
  await app.register(conversationRoutes, { prefix: '/api' });
  await app.register(permissionRuleRoutes, { prefix: '/api' });
  await app.register(configRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(statsRoutes, { prefix: '/api' });
  await app.register(activityRoutes, { prefix: '/api' });
  await app.register(operationRoutes, { prefix: '/api' });
  await app.register(scheduledJobRoutes, { prefix: '/api' });
  await app.register(flaggedWorktreeRoutes, { prefix: '/api' });
  await app.register(channelRoutes, { prefix: '/api' });
  await app.register(fsRoutes, { prefix: '/api' });
  await app.register(epicRoutes, { prefix: '/api' });
  await app.register(openapiRoutes, { prefix: '/api' });

  // MCP: stateless streamable HTTP. A fresh server+transport per request
  // keeps the tool list in sync with config (agent-review flag). Described
  // in the spec's info.description prose, not as a path (ADR-0005) — hidden
  // here the same way the openapi.json/yaml endpoints hide themselves.
  app.post('/mcp', { schema: { hide: true } }, async (req, reply) => {
    // A Attempt Key is a valid MCP caller (scopedKeyAllowed always admits /mcp) but
    // is never an operator, so operator-only MCP tools stay gated to a
    // full-scope credential or an authenticated session — resolved by the same
    // helper the notion is defined in.
    const operator = await requestIsOperator(req, auth);
    const mcp = buildMcpServer(ctx, { operator });
    // `as any`: the SDK's option/transport types don't satisfy
    // exactOptionalPropertyTypes; sessionIdGenerator: undefined selects
    // stateless mode per its documentation.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as any);
    reply.hijack();
    await mcp.connect(transport as any);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    reply.raw.on('close', () => {
      void transport.close();
      void mcp.close();
    });
  });

  // The runner injects the MCP endpoint into spawned harnesses once the
  // server knows its address.
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
    // Boot is complete and the server is listening — begin stall monitoring now
    // so the first probe measures steady-state loop health, not startup CPU.
    loopMonitor?.start();
  });
  await app.register(wsRoutes, { prefix: '/api' });

  // Serve the embedded SPA when a build exists (dist/web next to dist/server code).
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      // The entry point must never be cached: it's what pins the app to a given
      // set of content-hashed asset filenames. Hashed assets under /assets are
      // immutable by construction (the hash changes when the bytes change), so
      // they can be cached forever. Getting this wrong strands browsers on a
      // stale index.html that points at asset hashes we've already deleted.
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
        // Don't serve the SPA shell in place of a missing asset. A stale
        // index.html requesting a deleted hash must get a clean 404, not
        // HTML-with-200 that the browser then tries to execute as JS/CSS.
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
