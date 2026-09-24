import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskRoutes } from './routes/tasks.js';
import { epicRoutes } from './routes/epics.js';
import { mapRoutes } from './routes/maps.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { conversationRoutes } from './routes/conversations.js';
import { permissionRuleRoutes } from './routes/permission-rules.js';
import { configRoutes } from './routes/config.js';
import { globalPauseRoutes } from './routes/global-pause.js';
import { wsRoutes } from './ws.js';
import { authRoutes } from './routes/auth.js';
import { statsRoutes } from './routes/stats.js';
import { activityRoutes } from './routes/activity.js';
import { timelineRoutes } from './routes/timeline.js';
import { operationRoutes } from './routes/operations.js';
import { channelRoutes } from './routes/channels.js';
import { scheduledJobRoutes } from './routes/scheduled-jobs.js';
import { worktreeRoutes } from './routes/worktrees.js';
import { harnessRoutes } from './routes/harnesses.js';
import { fsRoutes } from './routes/fs.js';
import { openapiRoutes } from './routes/openapi.js';
import { buildMcpServer } from '../mcp/server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { updateRoutes } from './routes/update.js';
import type { App, AppContext, AppContexts } from './app-context.js';

function cacheControlForStaticFile(filePath: string): string | undefined {
  if (filePath.endsWith('index.html')) return 'no-cache';
  if (filePath.includes(`${sep}assets${sep}`)) return 'public, max-age=31536000, immutable';
  return undefined;
}

function isStaticAssetPath(path: string): boolean {
  return path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(path);
}

export async function registerRoutes(app: App, ctx: AppContext, contexts: AppContexts): Promise<void> {
  await app.register((fastify) => taskRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => mapRoutes(fastify, contexts.tracking), { prefix: '/api' });
  await app.register((fastify) => workspaceRoutes(fastify, contexts.tracking), { prefix: '/api' });
  await app.register(conversationRoutes, { prefix: '/api' });
  await app.register((fastify) => permissionRuleRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => configRoutes(fastify, contexts.execution), { prefix: '/api' });
  await app.register((fastify) => globalPauseRoutes(fastify, contexts.execution), { prefix: '/api' });
  await app.register((fastify) => updateRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => authRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => statsRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => activityRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => timelineRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => operationRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => scheduledJobRoutes(fastify, contexts.tracking), { prefix: '/api' });
  await app.register((fastify) => worktreeRoutes(fastify, contexts.execution), { prefix: '/api' });
  await app.register(harnessRoutes, { prefix: '/api' });
  await app.register((fastify) => channelRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => fsRoutes(fastify, contexts.tracking), { prefix: '/api' });
  await app.register((fastify) => epicRoutes(fastify, ctx), { prefix: '/api' });
  await app.register(openapiRoutes, { prefix: '/api' });

  app.post('/mcp', { schema: { hide: true } }, async (req, reply) => {
    const mcp = buildMcpServer(ctx);
    // MCP SDK option/interface types don't satisfy this project's exactOptionalPropertyTypes; both casts erase that mismatch, not our types.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as any);
    reply.hijack();
    await mcp.connect(transport as any);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    reply.raw.on('close', () => {
      void transport.close();
      void mcp.close();
    });
  });

  await app.register((fastify) => wsRoutes(fastify, ctx), { prefix: '/api' });

  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      setHeaders(reply, filePath) {
        const cacheControl = cacheControlForStaticFile(filePath);
        if (cacheControl) reply.header('Cache-Control', cacheControl);
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        const path = req.url.split('?')[0] ?? '';
        if (isStaticAssetPath(path)) {
          return reply.status(404).send({ error: { code: 'not_found', message: 'not found' } });
        }
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'not_found', message: 'not found' } });
    });
  }
}
