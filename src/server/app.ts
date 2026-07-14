import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
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
import { ReviewService } from '../domain/review.js';
import { Runner } from '../execution/runner.js';
import { AutoRunner } from '../execution/auto-runner.js';
import { DomainError } from '../domain/errors.js';
import { taskRoutes } from './routes/tasks.js';
import { configRoutes } from './routes/config.js';
import { wsRoutes } from './ws.js';
import { EventBus } from './bus.js';
import { AuthService } from './auth.js';
import { authRoutes, SESSION_COOKIE } from './routes/auth.js';
import { statsRoutes } from './routes/stats.js';
import { channelRoutes } from './routes/channels.js';
import { ChannelService } from '../notifications/channels.js';
import { Notifier } from '../notifications/notifier.js';
import { buildMcpServer } from '../mcp/server.js';
import { ConfigRepoService } from '../config-repo.js';
import { configRepoRoutes } from './routes/config-repo.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface AppOptions {
  dataDir: string;
  configOverrides?: DeepPartial<AppConfig> | undefined;
  /** Set (or update) the operator password at boot — CLI/config first-run setup. */
  password?: string | undefined;
  /** Operator username (default "operator"); applied with `password`. */
  username?: string | undefined;
}

/** Paths reachable without authentication. */
const PUBLIC_API_PATHS = new Set(['/api/auth/login', '/api/auth/me']);

/**
 * What a per-run scoped key may reach: the agent surface from issue 13 —
 * task CRUD, dependencies, queue/cancel, runs and events, and MCP (which
 * gates its own tool list). Accept/Reject stay human unless the
 * agent-review flag is on (ADR-0002). Everything else — key management,
 * config, channels, config repo — is operator-only.
 */
function runScopedKeyAllowed(path: string, agentReview: boolean): boolean {
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
  review: ReviewService;
  autoRunner: AutoRunner;
  auth: AuthService;
  channels: ChannelService;
  notifier: Notifier;
  configRepo: ConfigRepoService;
  bus: EventBus;
}

export type App = FastifyInstance & { ctx: AppContext };

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
  const auth = new AuthService(db);
  if (opts.password) auth.setPassword(opts.password, opts.username);
  // Crash recovery before anything can execute: orphaned runs are failed
  // as "interrupted" (never silently re-run), and their tasks fail loudly.
  for (const orphan of runs.markInterrupted()) {
    tasks.setState(orphan.taskId, 'failed');
  }
  // Run Keys of every non-running run die here — catches keys orphaned by
  // a crash or restart.
  auth.sweepOrphanedRunKeys();
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

  const configRepo = new ConfigRepoService({ db, dataDir: opts.dataDir, configStore, auth, channels });

  const ctx: AppContext = { db, configStore, tasks, runs, runner, review, autoRunner, auth, channels, notifier, configRepo, bus };

  const app = Fastify({ logger: false }) as unknown as App;
  app.decorate('ctx', ctx);
  app.addHook('onClose', async () => runner.shutdown());
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

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
        if (key.scope === 'run' && !runScopedKeyAllowed(path, configStore.get().agentReview)) {
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
        if (key.scope === 'run' && !runScopedKeyAllowed(path, configStore.get().agentReview)) {
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
  await app.register(configRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(statsRoutes, { prefix: '/api' });
  await app.register(channelRoutes, { prefix: '/api' });
  await app.register(configRepoRoutes, { prefix: '/api' });

  // MCP: stateless streamable HTTP. A fresh server+transport per request
  // keeps the tool list in sync with config (agent-review flag).
  app.post('/mcp', async (req, reply) => {
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
      runner.mcpUrl = `http://${host}:${address.port}/mcp`;
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
