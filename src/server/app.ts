import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { openDb, type Db } from '../db/index.js';
import type { AppConfig, DeepPartial } from '../config.js';
import { ConfigStore } from './config-store.js';
import { TaskService } from '../domain/tasks.js';
import { RunStore } from '../domain/runs.js';
import { Runner } from '../execution/runner.js';
import { DomainError } from '../domain/errors.js';
import { taskRoutes } from './routes/tasks.js';
import { configRoutes } from './routes/config.js';

export interface AppOptions {
  dataDir: string;
  configOverrides?: DeepPartial<AppConfig> | undefined;
}

export interface AppContext {
  db: Db;
  configStore: ConfigStore;
  tasks: TaskService;
  runs: RunStore;
  runner: Runner;
}

export type App = FastifyInstance & { ctx: AppContext };

export async function buildApp(opts: AppOptions): Promise<App> {
  const db = openDb(opts.dataDir);
  const configStore = new ConfigStore(db, opts.configOverrides);
  const tasks = new TaskService(db, () => configStore.get());
  const runs = new RunStore(db);
  // Crash recovery before anything can execute: orphaned runs are failed
  // as "interrupted", never silently re-run.
  runs.markInterrupted();
  const runner = new Runner(runs, tasks, () => configStore.get());
  const ctx: AppContext = { db, configStore, tasks, runs, runner };

  const app = Fastify({ logger: false }) as unknown as App;
  app.decorate('ctx', ctx);
  app.addHook('onClose', async () => runner.shutdown());

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
