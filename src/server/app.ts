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

export interface AppOptions {
  dataDir: string;
  configOverrides?: DeepPartial<AppConfig> | undefined;
  /** Set (or update) the operator password at boot — CLI/config first-run setup. */
  password?: string | undefined;
}

/** Paths reachable without authentication. */
const PUBLIC_API_PATHS = new Set(['/api/auth/login', '/api/auth/me']);

export interface AppContext {
  db: Db;
  configStore: ConfigStore;
  tasks: TaskService;
  runs: RunStore;
  runner: Runner;
  review: ReviewService;
  autoRunner: AutoRunner;
  auth: AuthService;
  bus: EventBus;
}

export type App = FastifyInstance & { ctx: AppContext };

export async function buildApp(opts: AppOptions): Promise<App> {
  const db = openDb(opts.dataDir);
  const bus = new EventBus();
  const configStore = new ConfigStore(db, opts.configOverrides);
  const tasks = new TaskService(db, () => configStore.get(), (task) => bus.emit('task_changed', task));
  const runs = new RunStore(db);
  // Crash recovery before anything can execute: orphaned runs are failed
  // as "interrupted", never silently re-run.
  runs.markInterrupted();
  const runner = new Runner(runs, tasks, () => configStore.get(), {
    events: {
      onRunEvent: (event) => bus.emit('run_event', event),
      onRunFinished: (run) => bus.emit('run_changed', run),
    },
    worktreesDir: join(opts.dataDir, 'worktrees'),
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
  autoRunner.poke();

  const auth = new AuthService(db);
  if (opts.password) auth.setPassword(opts.password);

  const ctx: AppContext = { db, configStore, tasks, runs, runner, review, autoRunner, auth, bus };

  const app = Fastify({ logger: false }) as unknown as App;
  app.decorate('ctx', ctx);
  app.addHook('onClose', async () => runner.shutdown());
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  // Every API surface is authenticated: cookie sessions for the SPA,
  // bearer API keys for programmatic access (token also accepted as a
  // query param for WebSocket clients that can't set headers).
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (!path.startsWith('/api') || PUBLIC_API_PATHS.has(path)) return;

    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer && auth.verifyKey(bearer)) return;
    if (auth.validateSession(req.cookies[SESSION_COOKIE])) return;
    const queryToken = (req.query as Record<string, string | undefined>)?.token;
    if (queryToken && (auth.verifyKey(queryToken) || auth.validateSession(queryToken))) return;

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
