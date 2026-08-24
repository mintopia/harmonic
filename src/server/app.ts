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
import { existsSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { landBranch } from '../execution/branch-landing.js';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { openAsyncDb, type AsyncDbHandle } from '../db/async.js';
import { openStatsReader, type StatsReader } from '../db/stats-reader.js';
import type { AppConfig, DeepPartial } from '../config.js';
import { ConfigStore } from './config-store.js';
import { TaskService } from '../domain/tasks.js';
import { RunStore } from '../domain/runs.js';
import { WorkContextLeaseStore } from '../domain/work-context-leases.js';
import { ConversationStore } from '../domain/conversations.js';
import { WorkspaceService } from '../domain/workspaces.js';
import { PermissionRuleStore } from '../domain/permission-rules.js';
import { ReviewService } from '../domain/review.js';
import { RunSettleCoordinator } from '../domain/run-settle.js';
import { SessionStore } from '../domain/sessions.js';
import { SessionRetirementCoordinator } from '../domain/session-retirement-coordinator.js';
import { Git } from '../execution/git.js';
import { BranchRetirementCoordinator } from '../execution/branch-retirement.js';
import { RunFactStore } from '../domain/run-facts.js';
import { GuardrailEventStore } from '../domain/guardrail-events.js';
import { VerificationAttemptStore } from '../domain/verification-attempts.js';
import { LandingJournalStore } from '../domain/landing-journal.js';
import { LandingCoordinator, type LandingEffectExec } from '../domain/landing-coordinator.js';
import type { TaskRow, RunRow } from '../db/schema.js';
import { TurnQueueStore } from '../domain/turn-queue-store.js';
import { CrashRecoveryCoordinator } from '../domain/crash-recovery.js';
import { BootResumeCoordinator } from '../domain/boot-resume-coordinator.js';
import { adapterVersion } from '../execution/harness/adapter.js';
import { Runner } from '../execution/runner.js';
import { MergeTrainCoordinator } from '../execution/merge-train-coordinator.js';
import type { CriticHarnessDrive } from '../verification/critic.js';
import { ConversationDriver } from '../execution/conversation-driver.js';
import { AutoRunner } from '../execution/auto-runner.js';
import { GitCircuitBreaker } from '../execution/git-failure.js';
import { EventLoopMonitor } from '../reliability/event-loop-monitor.js';
import { singleFlight } from '../reliability/single-flight.js';
import { AutoDrive } from '../execution/auto-drive.js';
import { TrackerPollerManager } from '../tracker/manager.js';
import type { MirrorClaim } from '../execution/auto-runner.js';
import { DomainError } from '../domain/errors.js';
import { taskRoutes } from './routes/tasks.js';
import { leaseRoutes } from './routes/leases.js';
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
import { channelRoutes } from './routes/channels.js';
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
  runnerTuning?: { spendGuardrail?: { pollMs?: number; graceMs?: number } } | undefined;
  leaseTuning?: { heartbeatMs?: number; sweepMs?: number } | undefined;
  reliabilityTuning?: { eventLoop?: { enabled?: boolean; probeMs?: number; stallMs?: number } } | undefined;
  criticDrive?: CriticHarnessDrive | undefined;
}

const PUBLIC_API_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/me',
  // The OpenAPI spec documents an already-open-source project (ADR-0005).
  '/api/openapi.json',
  '/api/openapi.yaml',
]);

function scopedKeyAllowed(path: string): boolean {
  if (path.startsWith('/mcp')) return true;
  if (/^\/api\/tasks\/\d+\/complete$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/steer$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/(accept|reject)$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/channels(\/|$)/.test(path)) return false;
  if (path === '/api/tasks' || path.startsWith('/api/tasks/')) return true;
  if (path.startsWith('/api/runs')) return true;
  return false;
}

function readScopeAllowed(path: string, method: string): boolean {
  if (method !== 'GET') return false;
  if (path === '/api/ws') return true;
  if (/^\/api\/tasks\/\d+\/channels(\/|$)/.test(path)) return false;
  if (path === '/api/tasks' || path.startsWith('/api/tasks/')) return true;
  if (path.startsWith('/api/runs')) return true;
  if (path === '/api/maps' || path.startsWith('/api/maps/')) return true;
  if (path === '/api/activity') return true;
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
  statsReader: StatsReader;
  configStore: ConfigStore;
  workspaces: WorkspaceService;
  tasks: TaskService;
  runs: RunStore;
  sessions: SessionStore;
  leases: WorkContextLeaseStore;
  runner: Runner;
  conversations: ConversationStore;
  conversationDriver: ConversationDriver;
  permissionRules: PermissionRuleStore;
  review: ReviewService;
  autoRunner: AutoRunner;
  guardrailEvents: GuardrailEventStore;
  verificationAttempts: VerificationAttemptStore;
  trackerManager: TrackerPollerManager;
  auth: AuthService;
  channels: ChannelService;
  notifier: Notifier;
  bus: EventBus;
}

export interface RegisteredRoute {
  method: string;
  url: string;
}

export type App = FastifyInstance & { ctx: AppContext; registeredRoutes: RegisteredRoute[] };

export async function buildApp(opts: AppOptions): Promise<App> {
  const asyncDb = await openAsyncDb(opts.dataDir);
  // #257 / ADR-0029 §5: local libsql runs file-backed queries inline. Give the
  // growing Stats range scans a dedicated worker and typed request shape.
  const statsReader = openStatsReader(opts.dataDir);
  const bus = new EventBus();
  operationRegistry.setBus(bus);
  const configStore = await ConfigStore.create(asyncDb, opts.configOverrides);
  const workspaces = new WorkspaceService(asyncDb);
  const channels = new ChannelService(asyncDb);
  const notifier = new Notifier(channels, (msg) => console.error(msg));
  const tasks = new TaskService(
    asyncDb,
    () => configStore.get(),
    () => workspaces.list(),
    (task) => bus.emit('task_changed', task),
    (event, task) => void notifier.notify(event, task).catch(() => {}),
    (id) => bus.emit('task_removed', { id }),
  );
  const runs = new RunStore(asyncDb);
  const guardrailEvents = new GuardrailEventStore(asyncDb);
  const verificationAttempts = new VerificationAttemptStore(asyncDb);
  const leases = new WorkContextLeaseStore(asyncDb);
  const conversations = new ConversationStore(asyncDb, (conversation) => bus.emit('conversation_changed', conversation));
  const permissionRules = new PermissionRuleStore(asyncDb);
  const auth = new AuthService(asyncDb);
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
    keys: {
      mint: async (conversationId) =>
        (await auth.createKey(`conversation-${conversationId}`, { scope: 'conversation', conversationId })).token,
      revoke: (conversationId) => auth.deleteKeysForConversation(conversationId),
    },
  });
  const sessionStore = new SessionStore(asyncDb);
  const sessionRetirement = new SessionRetirementCoordinator(
    sessionStore,
    runs,
    leases,
    (repoDir, worktreePath) => Git.removeWorktree(repoDir, worktreePath).then(() => {}),
  );
  const drainRetirement = singleFlight(() => sessionRetirement.drain());
  const branchRetirement = new BranchRetirementCoordinator(runs, tasks);
  const landingJournal = new LandingJournalStore(asyncDb);
  const reviewSettle = new RunSettleCoordinator(
    runs,
    tasks,
    leases,
    new RunFactStore(asyncDb),
    (run) => bus.emit('run_changed', run),
    landingJournal,
    sessionRetirement,
    branchRetirement,
  );
  const landing = new LandingCoordinator(runs, asyncDb, landingJournal, reviewSettle);
  const crashRecovery = new CrashRecoveryCoordinator(runs, tasks, leases, reviewSettle, landing, landingJournal, new TurnQueueStore(asyncDb));
  await crashRecovery.reconcile();
  await branchRetirement.reconcile();
  for (const orphan of await tasks.list({ state: 'running' })) {
    if ((await runs.listForTask(orphan.id)).some((run) => run.state === 'running')) continue;
    await tasks.setState(orphan.id, 'failed');
  }
  await new BootResumeCoordinator(runs, tasks, sessionStore, new TurnQueueStore(asyncDb), new RunFactStore(asyncDb), (session) => ({
    harness: session.harness,
    adapterVersion: adapterVersion(session.harness),
    model: session.model,
    availablePermissionModes: session.permissionMode ? [session.permissionMode] : [],
  })).resume();
  await auth.sweepOrphanedRunKeys();
  await auth.sweepOrphanedConversationKeys();
  await conversations.markActiveEnded();
  let trackerManagerRef: TrackerPollerManager | undefined;
  const autoDrive = new AutoDrive(
    () => configStore.get(),
    (task) => trackerManagerRef?.urlFor(task.workspaceId, task.trackerRef) ?? null,
  );
  const landingEffectsFor = (task: TaskRow, run: RunRow): LandingEffectExec[] => {
    if (task.isolationMode !== 'worktree' || !run.branch || !run.baseBranch) return [];
    const baseBranch = run.baseBranch;
    const branch = run.branch;
    return [
      {
        effect: 'target-ref',
        idempotencyKey: `${baseBranch}<-${branch}`,
        expected: { baseBranch, branch },
        // Land through the admin-worktree + CAS operation (issue #153), never a
        // base-repo in-place `git merge` that desyncs a live checkout. Harmonic
        // owns the base repo and `Git.ffOnly` serialises via the in-process
        // repo lock (#121), so an exclusive clean lease over the target is held
        // for the checked-out (worktree-mode base) path — `landBranch` still
        // falls back to PR/manual if that checkout has uncommitted operator work.
        apply: async () => {
          const outcome = await landBranch({ repoDir: task.workingDir, baseBranch, branch, leaseHeld: true });
          if (!outcome.ok) return { ok: false, detail: outcome.detail };
          return { ok: true, observed: { baseBranch, branch, oid: outcome.oid, mode: outcome.mode } };
        },
      },
    ];
  };
  let runnerRef: Runner | undefined;
  const mergeTrain = new MergeTrainCoordinator({
    dispatchHeal: (member) => runnerRef!.enqueueReMergeForMember(member),
    escalate: (member, reason) => runnerRef!.settleEscalatedForMember(member, reason),
  });
  const gitBreaker = new GitCircuitBreaker();
  const runner = new Runner(runs, tasks, leases, asyncDb, () => configStore.get(), {
    events: {
      onRunEvent: (event) => bus.emit('run_event', event),
      onRunLogEvent: (event) => bus.emitRunLog(event),
      onRunFinished: (run) => bus.emit('run_changed', run),
      onRunPhaseChanged: (run) => bus.emit('run_changed', run),
      onRunUsage: (payload) => bus.emit('run_usage', payload),
    },
    mergeTrain,
    gitBreaker,
    epicBaseNotReady: (task) => trackerManagerRef?.epicBaseNotReady(task) ?? false,
    worktreesDir: join(opts.dataDir, 'worktrees'),
    spendGuardrail: opts.runnerTuning?.spendGuardrail,
    leaseHeartbeat: opts.leaseTuning?.heartbeatMs != null ? { intervalMs: opts.leaseTuning.heartbeatMs } : undefined,
    criticDrive: opts.criticDrive,
    sessionRetirement,
    keys: {
      mint: async (runId) => (await auth.createKey(`run-${runId}`, { scope: 'run', runId })).token,
      revoke: (runId) => auth.deleteKeysForRun(runId),
    },
    autoDrive,
    urlFor: (task) => trackerManagerRef?.urlFor(task.workspaceId, task.trackerRef) ?? null,
    getWorkspace: async (id) => {
      if (id == null) return undefined;
      try {
        return await workspaces.get(id);
      } catch {
        return undefined;
      }
    },
    autoAcceptLand: async (task, run, patch) =>
      landing.land(
        task,
        run,
        { runState: 'completed', taskAction: 'completed', reason: null },
        landingEffectsFor(task, run),
        patch,
      ),
  });
  runnerRef = runner;
  await runner.backfillUsage();
  const review = new ReviewService(
    runs,
    tasks,
    reviewSettle,
    landing,
    async (task, run) => {
      if (task.isolationMode !== 'worktree' || !run.branch || !run.baseBranch) return { ok: true };
      const outcome = await landBranch({ repoDir: task.workingDir, baseBranch: run.baseBranch, branch: run.branch, leaseHeld: true });
      return outcome.ok ? { ok: true } : { ok: false, detail: outcome.detail };
    },
    landingEffectsFor,
  );
  await review.sweepExpiredReviews();
  await drainRetirement();
  const leaseSweep = setInterval(() => {
    // Fire-and-forget now that sweepExpired is async (ADR-0029): a swallowed
    // rejection keeps a DB hiccup off the loop, and the next tick retries.
    void leases.sweepExpired().catch(() => {});
  }, opts.leaseTuning?.sweepMs ?? 60_000);
  leaseSweep.unref?.();
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
    runs,
    runner,
    () => configStore.get(),
    () => workspaces.list(),
    {
      mirror,
      epicBaseNotReady: (task) => trackerManagerRef?.epicBaseNotReady(task) ?? false,
      gitBreaker,
    },
  );
  const trackerManager = new TrackerPollerManager(
    tasks,
    () => workspaces.list(),
    undefined,
    undefined,
    (taskId) => {
      void runner.reopenClosedMirrored(taskId);
    },
    () => configStore.get(),
  );
  trackerManagerRef = trackerManager;
  bus.on('run_changed', () => autoRunner.poke());
  bus.on('run_changed', () => {
    void drainRetirement().catch(() => {});
  });
  bus.on('run_changed', (run) => {
    if (run.state === 'running' && run.phase !== 'review') return;
    void (async () => {
      if ((await tasks.list({ state: 'ready' })).length !== 0) return;
      if ((await runs.countRunning()) === 0) await notifier.notify('queue.idle');
    })().catch(() => {});
  });

  const ctx: AppContext = { asyncDb, statsReader, configStore, workspaces, tasks, runs, sessions: sessionStore, leases, runner, conversations, conversationDriver, permissionRules, review, autoRunner, guardrailEvents, verificationAttempts, trackerManager, auth, channels, notifier, bus };

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
    autoRunner.stop();
    runner.shutdown();
    conversationDriver.shutdown();
    clearInterval(leaseSweep);
    loopMonitor?.stop();
    await statsReader.close();
  });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const pkg = readPackageManifest();
  const specDescription = `${pkg.description}

## MCP

\`POST /mcp\` is a stateless streamable-HTTP MCP server (not a REST
endpoint, so it has no entry in this spec's paths). It authenticates the
same way as the REST API — a bearer token, either an operator API key or
the Run Key Harmonic injects into a spawned harness — and exposes the
agent task surface as MCP tools (task CRUD, dependencies, queue/cancel,
runs and events). Accept/Reject are human-only and are never exposed as
MCP tools — a verifier's pass is the accept (#140, ADR-0021). A run-scoped
Run Key may call \`/mcp\` regardless of the REST restrictions noted per
endpoint below. Work Context lease diagnostics/supersede/unlock
(\`list_leases\`, \`supersede_lease\`, \`unlock_lease\`, issue #125) are
operator-only tools, the same footing as Accept/Reject: a Run Key can call
\`/mcp\` but gets a \`forbidden\` error from these three specifically — only
an operator API key (\`scope: 'full'\`) or an authenticated session may call
them.

## WebSocket

\`GET /api/ws\` is a single firehose WebSocket (also outside this spec's
paths): every run event, run state change, task state change/removal, and
Conversation event/change is broadcast to every connected client as JSON
messages of the form \`{ type: 'run_event' | 'run_changed' | 'run_usage' |
'task_changed' | 'task_removed' | 'conversation_event' | 'conversation_changed' |
'permission_request', ... }\`, using the same Task/Run/Conversation shapes
served over REST. \`run_usage\` is a live-usage snapshot for a running Run
(tokens, context fill, derived Cost, current-activity line, and Process
Tree), pushed about once a second while the Run tails its native log.
\`task_removed\` (issue #162) announces a hard-deleted Task's id (\`{ type:
'task_removed', id }\`) — the row is gone, not another state change.
\`permission_request\` announces a Harness blocked on an
operator permission decision in a Conversation (ADR-0007), answered via
\`POST /conversations/:id/permissions/:reqId\`. Authenticate by passing the
session token or an API key as \`?token=\` (WebSocket clients cannot set an
Authorization header). A \`read\`-scoped key gets a filtered firehose — only
\`task_changed\`, \`task_removed\`, \`run_changed\`, \`run_event\`, and
\`run_usage\` — with the Conversation and permission traffic dropped.

## Read scope

A \`read\`-scoped API key (created via \`POST /api/keys\` with
\`{ "scope": "read" }\`) is a viz-client credential: it may \`GET\` tasks,
runs, maps, and the instance-wide Activity snapshot (\`/api/activity\`,
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

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if ((!path.startsWith('/api') && !path.startsWith('/mcp')) || PUBLIC_API_PATHS.has(path)) return;

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
    req.log.error({ err }, 'unexpected request error');
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
  await app.register(channelRoutes, { prefix: '/api' });
  await app.register(fsRoutes, { prefix: '/api' });
  await app.register(leaseRoutes, { prefix: '/api' });
  await app.register(epicRoutes, { prefix: '/api' });
  await app.register(openapiRoutes, { prefix: '/api' });

  app.post('/mcp', { schema: { hide: true } }, async (req, reply) => {
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
    await trackerManager.sync();
    loopMonitor?.start();
  });
  await app.register(wsRoutes, { prefix: '/api' });

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
