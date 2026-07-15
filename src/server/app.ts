import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
import fastifySwagger from '@fastify/swagger';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Git } from '../execution/git.js';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { openDb, type Db } from '../db/index.js';
import type { AppConfig, DeepPartial } from '../config.js';
import { ConfigStore } from './config-store.js';
import { TaskService } from '../domain/tasks.js';
import { RunStore } from '../domain/runs.js';
import { ConversationStore } from '../domain/conversations.js';
import { PermissionRuleStore } from '../domain/permission-rules.js';
import { ReviewService } from '../domain/review.js';
import { Runner } from '../execution/runner.js';
import { ConversationDriver } from '../execution/conversation-driver.js';
import { AutoRunner } from '../execution/auto-runner.js';
import { DomainError } from '../domain/errors.js';
import { taskRoutes } from './routes/tasks.js';
import { conversationRoutes } from './routes/conversations.js';
import { permissionRuleRoutes } from './routes/permission-rules.js';
import { configRoutes } from './routes/config.js';
import { wsRoutes } from './ws.js';
import { EventBus } from './bus.js';
import { AuthService } from './auth.js';
import { authRoutes, SESSION_COOKIE } from './routes/auth.js';
import { statsRoutes } from './routes/stats.js';
import { channelRoutes } from './routes/channels.js';
import { openapiRoutes, readPackageManifest } from './routes/openapi.js';
import { ChannelService } from '../notifications/channels.js';
import { Notifier } from '../notifications/notifier.js';
import { buildMcpServer } from '../mcp/server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface AppOptions {
  dataDir: string;
  configOverrides?: DeepPartial<AppConfig> | undefined;
  /** Set (or update) the operator password at boot — CLI/config first-run setup. */
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
  if (/^\/api\/tasks\/\d+\/(accept|reject)$/.test(path)) return agentReview;
  if (/^\/api\/tasks\/\d+\/channels(\/|$)/.test(path)) return false;
  if (path === '/api/tasks' || path.startsWith('/api/tasks/')) return true;
  if (path.startsWith('/api/runs')) return true;
  return false;
}

export interface AppContext {
  db: Db;
  configStore: ConfigStore;
  tasks: TaskService;
  runs: RunStore;
  runner: Runner;
  conversations: ConversationStore;
  conversationDriver: ConversationDriver;
  permissionRules: PermissionRuleStore;
  review: ReviewService;
  autoRunner: AutoRunner;
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
  const channels = new ChannelService(db);
  const notifier = new Notifier(channels, (msg) => console.error(msg));
  const tasks = new TaskService(
    db,
    () => configStore.get(),
    (task) => bus.emit('task_changed', task),
    (event, task) => notifier.notify(event, task),
  );
  const runs = new RunStore(db);
  const conversations = new ConversationStore(db, (conversation) => bus.emit('conversation_changed', conversation));
  const permissionRules = new PermissionRuleStore(db);
  const auth = new AuthService(db);
  if (opts.password) auth.setPassword(opts.password);
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
  // as "interrupted" (never silently re-run), and their tasks fail loudly.
  for (const orphan of runs.markInterrupted()) {
    tasks.setState(orphan.taskId, 'failed');
  }
  // Run Keys of every non-running run die here — catches keys orphaned by
  // a crash or restart. Conversation Keys can never survive a restart (their
  // warm process is gone), so every one present at boot is orphaned (issue 16).
  auth.sweepOrphanedRunKeys();
  auth.sweepOrphanedConversationKeys();
  const runner = new Runner(runs, tasks, () => configStore.get(), {
    events: {
      onRunEvent: (event) => bus.emit('run_event', event),
      onRunFinished: (run) => bus.emit('run_changed', run),
    },
    worktreesDir: join(opts.dataDir, 'worktrees'),
    keys: {
      mint: (runId) => auth.createKey(`run-${runId}`, { scope: 'run', runId }).token,
      revoke: (runId) => auth.deleteKeysForRun(runId),
    },
  });
  // Heal runs whose usage collection raced the harness's log flush —
  // their session logs are settled on disk by now.
  runner.backfillUsage();
  // Accepting a worktree-mode task merges the run's branch (ADR-0002).
  const review = new ReviewService(runs, tasks, async (task, run) => {
    if (task.isolationMode !== 'worktree' || !run.branch || !run.baseBranch) return { ok: true };
    return Git.merge(task.workingDir, run.baseBranch, run.branch);
  });
  const autoRunner = new AutoRunner(tasks, runs, runner, () => configStore.get());
  bus.on('task_changed', (task) => {
    if (task.state === 'ready') autoRunner.poke();
  });
  bus.on('run_changed', () => autoRunner.poke());
  // The boot-time poke happens in the onListen hook below, after the MCP
  // endpoint is known — so even the first auto-started run gets its
  // scoped key + endpoint injected.
  // queue.idle: the last active run drained and nothing is waiting.
  bus.on('run_changed', (run) => {
    if (
      run.state !== 'running' &&
      runs.countRunning() === 0 &&
      tasks.list({ state: 'ready' }).length === 0
    ) {
      notifier.notify('queue.idle');
    }
  });

  const ctx: AppContext = { db, configStore, tasks, runs, runner, conversations, conversationDriver, permissionRules, review, autoRunner, auth, channels, notifier, bus };

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
messages of the form \`{ type: 'run_event' | 'run_changed' |
'task_changed' | 'conversation_event' | 'conversation_changed' |
'permission_request', ... }\`, using the same Task/Run/Conversation shapes
served over REST. \`permission_request\` announces a Harness blocked on an
operator permission decision in a Conversation (ADR-0007), answered via
\`POST /conversations/:id/permissions/:reqId\`. Authenticate by passing the
session token or an API key as \`?token=\` (WebSocket clients cannot set an
Authorization header).`;
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
  });

  // Every API surface is authenticated: cookie sessions for the SPA,
  // bearer API keys for programmatic access (token also accepted as a
  // query param for WebSocket clients that can't set headers). The MCP
  // endpoint shares the same authorization model.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if ((!path.startsWith('/api') && !path.startsWith('/mcp')) || PUBLIC_API_PATHS.has(path)) return;

    const forbidden = () =>
      reply
        .status(403)
        .send({ error: { code: 'forbidden', message: 'this key is scoped to its run and cannot access this endpoint' } });

    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
      const key = auth.verifyKey(bearer);
      if (key) {
        if (key.scope !== 'full' && !scopedKeyAllowed(path, configStore.get().agentReview)) {
          return forbidden();
        }
        return;
      }
    }
    if (auth.validateSession(req.cookies[SESSION_COOKIE])) return;
    const queryToken = (req.query as Record<string, string | undefined>)?.token;
    if (queryToken) {
      if (auth.validateSession(queryToken)) return;
      const key = auth.verifyKey(queryToken);
      if (key) {
        if (key.scope !== 'full' && !scopedKeyAllowed(path, configStore.get().agentReview)) {
          return forbidden();
        }
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
  await app.register(conversationRoutes, { prefix: '/api' });
  await app.register(permissionRuleRoutes, { prefix: '/api' });
  await app.register(configRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(statsRoutes, { prefix: '/api' });
  await app.register(channelRoutes, { prefix: '/api' });
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
  });
  await app.register(wsRoutes, { prefix: '/api' });

  // Serve the embedded SPA when a build exists (dist/web next to dist/server code).
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'not_found', message: 'not found' } });
    });
  }

  return app;
}
