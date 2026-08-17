import Fastify, { type FastifyInstance } from 'fastify';
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
import { Git } from '../execution/git.js';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { openDb, type Db } from '../db/index.js';
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
import { RunFactStore } from '../domain/run-facts.js';
import { Runner } from '../execution/runner.js';
import { ConversationDriver } from '../execution/conversation-driver.js';
import { AutoRunner } from '../execution/auto-runner.js';
import { AutoDrive } from '../execution/auto-drive.js';
import { TrackerPollerManager } from '../tracker/manager.js';
import type { MirrorClaim } from '../execution/auto-runner.js';
import { DomainError } from '../domain/errors.js';
import { taskRoutes } from './routes/tasks.js';
import { mapRoutes } from './routes/maps.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { conversationRoutes } from './routes/conversations.js';
import { permissionRuleRoutes } from './routes/permission-rules.js';
import { configRoutes } from './routes/config.js';
import { wsRoutes } from './ws.js';
import { EventBus } from './bus.js';
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
 * What an ephemeral scoped key (a Run Key or a Conversation Key) may reach:
 * the agent surface from issue 13 — task CRUD, dependencies, queue/cancel,
 * runs and events, and MCP (which gates its own tool list). Accept/Reject
 * stay human unless the agent-review flag is on (ADR-0002). Everything else
 * — key management, config, channels, Conversations — is operator-only.
 */
function scopedKeyAllowed(path: string, agentReview: boolean): boolean {
  if (path.startsWith('/mcp')) return true;
  // Force-complete is a manual operator override (kills a running agent mid-work,
  // skips the review gate) with no agent-facing use — agents signal via finish_task.
  if (/^\/api\/tasks\/\d+\/complete$/.test(path)) return false;
  // Steering redirects a running agent — a manual operator override; an agent
  // does not steer itself (it drives its own turn).
  if (/^\/api\/tasks\/\d+\/steer$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/(accept|reject)$/.test(path)) return agentReview;
  if (/^\/api\/tasks\/\d+\/channels(\/|$)/.test(path)) return false;
  if (path === '/api/tasks' || path.startsWith('/api/tasks/')) return true;
  if (path.startsWith('/api/runs')) return true;
  return false;
}

/**
 * What a `read`-scoped key reaches (issue #35): read-only board access for a
 * viz client — GET tasks/runs/maps, the instance-wide Activity snapshot, and
 * the WS handshake. Every mutation is blocked (GET-only), as is the operator
 * surface (keys, config, channels, Conversations). The per-Task channel
 * overrides are operator config, so they're excluded even though they hang off
 * /api/tasks. /api/activity is in the read set but self-filters to Runs only
 * (issue #51) — the same rule the firehose applies to Conversation traffic.
 */
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

export interface AppContext {
  db: Db;
  configStore: ConfigStore;
  workspaces: WorkspaceService;
  tasks: TaskService;
  runs: RunStore;
  runner: Runner;
  conversations: ConversationStore;
  conversationDriver: ConversationDriver;
  permissionRules: PermissionRuleStore;
  review: ReviewService;
  autoRunner: AutoRunner;
  trackerManager: TrackerPollerManager;
  auth: AuthService;
  channels: ChannelService;
  notifier: Notifier;
  bus: EventBus;
}

/** One Fastify route registration, as captured by the `onRoute` hook below. */
export interface RegisteredRoute {
  method: string;
  url: string;
}

export type App = FastifyInstance & { ctx: AppContext; registeredRoutes: RegisteredRoute[] };

export async function buildApp(opts: AppOptions): Promise<App> {
  const db = openDb(opts.dataDir);
  const bus = new EventBus();
  const configStore = new ConfigStore(db, opts.configOverrides);
  const workspaces = new WorkspaceService(db);
  const channels = new ChannelService(db);
  const notifier = new Notifier(channels, (msg) => console.error(msg));
  const tasks = new TaskService(
    db,
    () => configStore.get(),
    () => workspaces.list(),
    (task) => bus.emit('task_changed', task),
    (event, task) => notifier.notify(event, task),
  );
  const runs = new RunStore(db);
  const leases = new WorkContextLeaseStore(db);
  const conversations = new ConversationStore(db, (conversation) => bus.emit('conversation_changed', conversation));
  const permissionRules = new PermissionRuleStore(db);
  const auth = new AuthService(db);
  // An explicit empty password clears the gate; undefined leaves it as-is.
  if (opts.password !== undefined) {
    if (opts.password === '') auth.clearPassword();
    else auth.setPassword(opts.password);
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
      mint: (conversationId) =>
        auth.createKey(`conversation-${conversationId}`, { scope: 'conversation', conversationId }).token,
      revoke: (conversationId) => auth.deleteKeysForConversation(conversationId),
    },
  });
  // Crash recovery before anything can execute: orphaned runs are failed
  // as "interrupted" (never silently re-run). Each orphan's Work Context
  // lease is released too — a crash can't wedge a context until the boot
  // reconciliation sweep (#123) lands.
  for (const orphan of runs.markInterrupted()) leases.releaseByOwner(orphan.id);
  // A fresh process is executing nothing, so any Task still `running` was
  // orphaned by the restart — fail it loudly (re-queueable, with feedback).
  // This is a superset of "fail the interrupted runs' tasks": it also catches a
  // mirrored afk Task that crashed between the ready→running flip (the lock) and
  // its Run being created. No orphaned Run row exists for that one, so the run
  // sweep alone left it stuck `running` while its ticket stayed open — and the
  // poll never rescues it (upsertMirrored refuses to move a Task off `running`).
  for (const orphan of tasks.list({ state: 'running' })) {
    tasks.setState(orphan.id, 'failed');
  }
  // Run Keys of every non-running run die here — catches keys orphaned by
  // a crash or restart. Conversation Keys can never survive a restart (their
  // warm process is gone), so every one present at boot is orphaned (issue 16).
  auth.sweepOrphanedRunKeys();
  auth.sweepOrphanedConversationKeys();
  // A Conversation cannot survive a restart — its warm harness is gone — so
  // any still marked active is ended; its transcript survives read-only (issue 15).
  conversations.markActiveEnded();
  // Auto-drive afk mirrored Tasks (issue #33): the Drive Prompt + completion /
  // failure decisions. Its {url} comes from the Task's Workspace poll loop's
  // last scan; the manager is built below, so bind it late through this holder.
  let trackerManagerRef: TrackerPollerManager | undefined;
  const autoDrive = new AutoDrive(
    () => configStore.get(),
    (task) => trackerManagerRef?.urlFor(task.workspaceId, task.trackerRef) ?? null,
  );
  const runner = new Runner(runs, tasks, leases, db, () => configStore.get(), {
    events: {
      onRunEvent: (event) => bus.emit('run_event', event),
      onRunFinished: (run) => bus.emit('run_changed', run),
      onRunUsage: (payload) => bus.emit('run_usage', payload),
    },
    worktreesDir: join(opts.dataDir, 'worktrees'),
    keys: {
      mint: (runId) => auth.createKey(`run-${runId}`, { scope: 'run', runId }).token,
      revoke: (runId) => auth.deleteKeysForRun(runId),
    },
    autoDrive,
    getWorkspace: (id) => {
      if (id == null) return undefined;
      try {
        return workspaces.get(id);
      } catch {
        return undefined;
      }
    },
  });
  // Heal runs whose usage collection raced the harness's log flush —
  // their session logs are settled on disk by now.
  runner.backfillUsage();
  // Accepting a worktree-mode task merges the run's branch (ADR-0002). The
  // review gate lands/fails a Run parked in `phase:'review'` through the shared
  // settle coordinator (issue #114), so accept/reject/SLA-expiry are race-safe
  // against a concurrent operator cancel.
  const reviewSettle = new RunSettleCoordinator(runs, tasks, leases, new RunFactStore(db), (run) =>
    bus.emit('run_changed', run),
  );
  const review = new ReviewService(runs, tasks, reviewSettle, async (task, run) => {
    if (task.isolationMode !== 'worktree' || !run.branch || !run.baseBranch) return { ok: true };
    return Git.merge(task.workingDir, run.baseBranch, run.branch);
  });
  // Review-SLA sweep at boot (issue #114): a Run left parked in `review` past its
  // deadline by a previous instance is settled to a terminal disposition now, so
  // an abandoned review never wedges its Work Context lease across a restart.
  review.sweepExpiredReviews();
  // The advisory-assignment coordinator (issue #32) is per-Workspace (issue
  // #45); the Auto-Runner routes a mirrored Task's pick filter + claim step to
  // the coordinator of the Task's own Workspace poll loop (undefined ⇒ no live
  // loop ⇒ don't gate: foreign=false, decision=spawn).
  const mirror: MirrorClaim = {
    foreignAssignee: (task) => trackerManagerRef?.coordinatorFor(task.workspaceId)?.foreignAssignee(task) ?? false,
    recheckAndClaim: async (task) =>
      (await trackerManagerRef?.coordinatorFor(task.workspaceId)?.recheckAndClaim(task)) ?? 'spawn',
  };
  const autoRunner = new AutoRunner(tasks, runs, runner, () => configStore.get(), () => workspaces.list(), mirror);
  // One tracker poll loop per tracker-enabled Workspace (issues #30, #45); each
  // poll pokes the Auto-Runner so a newly-ready mirrored Task gets picked up.
  const trackerManager = new TrackerPollerManager(
    tasks,
    () => workspaces.list(),
    undefined,
    () => autoRunner.poke(),
    undefined,
    // Board-refresh backstop (ADR-0011): a ticket closed while its mirrored Task
    // was still running with a parked agent — stop the agent and settle it done.
    (taskId) => runner.completeClosedMirrored(taskId),
  );
  trackerManagerRef = trackerManager; // late-bind for AutoDrive's {url} resolver + the pick router above
  bus.on('task_changed', (task) => {
    if (task.state === 'ready') autoRunner.poke();
  });
  bus.on('run_changed', () => autoRunner.poke());
  // The boot-time poke happens in the onListen hook below, after the MCP
  // endpoint is known — so even the first auto-started run gets its
  // scoped key + endpoint injected.
  // queue.idle: the last actively-executing run drained and nothing is waiting.
  // A native Run parking in `phase:'review'` (issue #114) is done executing even
  // though it stays `state:'running'`, so that run_changed also counts as a
  // drain — matching the pre-phase-machine behaviour where a native Run left
  // `running` at agent-finish. `countRunning()` already excludes review-parked.
  bus.on('run_changed', (run) => {
    if (
      (run.state !== 'running' || run.phase === 'review') &&
      runs.countRunning() === 0 &&
      tasks.list({ state: 'ready' }).length === 0
    ) {
      notifier.notify('queue.idle');
    }
  });

  const ctx: AppContext = { db, configStore, workspaces, tasks, runs, runner, conversations, conversationDriver, permissionRules, review, autoRunner, trackerManager, auth, channels, notifier, bus };

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
    runner.shutdown();
    conversationDriver.shutdown();
  });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  // Every route below declares its request/response shapes as zod schemas
  // (ADR-0005); these compilers make Fastify validate/serialize against
  // them, and @fastify/swagger turns the same schemas into the spec served
  // at /api/openapi.{json,yaml}.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const pkg = readPackageManifest();
  // MCP and the WebSocket are not modeled as OpenAPI paths (neither is a
  // request/response REST endpoint) — they're described here in prose
  // instead (ADR-0005).
  const specDescription = `${pkg.description}

## MCP

\`POST /mcp\` is a stateless streamable-HTTP MCP server (not a REST
endpoint, so it has no entry in this spec's paths). It authenticates the
same way as the REST API — a bearer token, either an operator API key or
the Run Key Harmonic injects into a spawned harness — and exposes the
agent task surface as MCP tools (task CRUD, dependencies, queue/cancel,
runs and events; Accept/Reject tools appear only when the \`agentReview\`
config flag is on). A run-scoped Run Key may call \`/mcp\` regardless of
the REST restrictions noted per endpoint below.

## WebSocket

\`GET /api/ws\` is a single firehose WebSocket (also outside this spec's
paths): every run event, run state change, task state change, and
Conversation event/change is broadcast to every connected client as JSON
messages of the form \`{ type: 'run_event' | 'run_changed' | 'run_usage' |
'task_changed' | 'conversation_event' | 'conversation_changed' |
'permission_request', ... }\`, using the same Task/Run/Conversation shapes
served over REST. \`run_usage\` is a live-usage snapshot for a running Run
(tokens, context fill, derived Cost, current-activity line, and Process
Tree), pushed about once a second while the Run tails its native log.
\`permission_request\` announces a Harness blocked on an
operator permission decision in a Conversation (ADR-0007), answered via
\`POST /conversations/:id/permissions/:reqId\`. Authenticate by passing the
session token or an API key as \`?token=\` (WebSocket clients cannot set an
Authorization header). A \`read\`-scoped key gets a filtered firehose — only
\`task_changed\`, \`run_changed\`, \`run_event\`, and \`run_usage\` — with the
Conversation and permission traffic dropped.

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

  // Every API surface is authenticated: cookie sessions for the SPA,
  // bearer API keys for programmatic access (token also accepted as a
  // query param for WebSocket clients that can't set headers). The MCP
  // endpoint shares the same authorization model.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if ((!path.startsWith('/api') && !path.startsWith('/mcp')) || PUBLIC_API_PATHS.has(path)) return;

    // Open by default: with no operator password set, Harmonic runs ungated —
    // a local single-user tool. Setting a password (once) turns the gate on.
    if (!auth.hasPassword()) return;

    const forbidden = () =>
      reply
        .status(403)
        .send({ error: { code: 'forbidden', message: 'this key is scoped to its run and cannot access this endpoint' } });

    const scopeAllows = (scope: string): boolean =>
      scope === 'full' ||
      (scope === 'read'
        ? readScopeAllowed(path, req.method)
        : scopedKeyAllowed(path, configStore.get().agentReview));

    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
      const key = auth.verifyKey(bearer);
      if (key) {
        if (!scopeAllows(key.scope)) return forbidden();
        return;
      }
    }
    if (auth.validateSession(req.cookies[SESSION_COOKIE])) return;
    const queryToken = (req.query as Record<string, string | undefined>)?.token;
    if (queryToken) {
      if (auth.validateSession(queryToken)) return;
      const key = auth.verifyKey(queryToken);
      if (key) {
        if (!scopeAllows(key.scope)) return forbidden();
        return;
      }
    }

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
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: { code: 'internal', message } });
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
  await app.register(openapiRoutes, { prefix: '/api' });

  // MCP: stateless streamable HTTP. A fresh server+transport per request
  // keeps the tool list in sync with config (agent-review flag). Described
  // in the spec's info.description prose, not as a path (ADR-0005) — hidden
  // here the same way the openapi.json/yaml endpoints hide themselves.
  app.post('/mcp', { schema: { hide: true } }, async (req, reply) => {
    const mcp = buildMcpServer(ctx);
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
    autoRunner.poke();
    await trackerManager.sync();
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
