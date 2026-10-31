import { logger } from '../logger.js';
import { errorMessage } from '../error-handling.js';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskRoutes } from './routes/tasks.js';
import { taskExportRoutes } from './routes/task-export.js';
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
import { agentMessageRoutes } from './routes/agent-messages.js';
import { timelineRoutes } from './routes/timeline.js';
import { operationRoutes } from './routes/operations.js';
import { notificationRoutes } from './routes/notifications.js';
import { channelRoutes } from './routes/channels.js';
import { scheduledJobRoutes } from './routes/scheduled-jobs.js';
import { worktreeRoutes } from './routes/worktrees.js';
import { trackerSettingsRoutes } from './routes/tracker-settings.js';
import { secretRoutes } from './routes/secrets.js';
import { executionTargetRoutes } from './routes/execution-targets.js';
import { harnessRoutes } from './routes/harnesses.js';
import { exportRoutes } from './routes/export.js';
import { fsRoutes } from './routes/fs.js';
import { openapiRoutes } from './routes/openapi.js';
import { buildMcpServer } from '../mcp/server.js';
import { resolveMcpCaller } from '../mcp/caller.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { updateRoutes } from './routes/update.js';
import { promptRoutes } from './routes/prompts.js';
import { workflowRoutes, type WorkflowUsage } from './routes/workflows.js';
import { isNotNull, or } from 'drizzle-orm';
import { tasks } from '../db/schema.js';
import type { PromptLibrary } from '../domain/prompt-library-store.js';
import type { App, AppContext, AppContexts } from './app-context.js';

function cacheControlForStaticFile(filePath: string): string | undefined {
  if (filePath.endsWith('index.html')) return 'no-cache';
  if (filePath.includes(`${sep}assets${sep}`)) return 'public, max-age=31536000, immutable';
  return undefined;
}

function isStaticAssetPath(path: string): boolean {
  return path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(path);
}

async function workflowUsage(asyncDb: AppContext['asyncDb']): Promise<Map<string, WorkflowUsage>> {
  const rows = await asyncDb.read((db) =>
    db.select({ ref: tasks.workflowRef, requested: tasks.workflowRequested, workspaceId: tasks.workspaceId }).from(tasks).where(or(isNotNull(tasks.workflowRef), isNotNull(tasks.workflowRequested))).all(),
  );
  const tickets = new Map<string, number>();
  const spaces = new Map<string, Set<number | null>>();
  for (const row of rows) {
    const names = new Set([row.requested, row.ref?.split('@')[0]].filter((n): n is string => !!n));
    for (const name of names) {
      tickets.set(name, (tickets.get(name) ?? 0) + 1);
      spaces.set(name, (spaces.get(name) ?? new Set()).add(row.workspaceId));
    }
  }
  return new Map([...tickets].map(([name, count]) => [name, { tickets: count, workspaces: [...spaces.get(name)!].filter((w) => w !== null).length }]));
}

export async function registerRoutes(app: App, ctx: AppContext, contexts: AppContexts, prompts: PromptLibrary): Promise<void> {
  await app.register((fastify) => taskRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => taskExportRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => mapRoutes(fastify, contexts.tracking), { prefix: '/api' });
  await app.register((fastify) => workspaceRoutes(fastify, { ...contexts.tracking, executionTargets: ctx.executionTargets, auth: ctx.auth, tasks: ctx.tasks, archive: ctx.archive, workflows: ctx.workflows, routeClassifier: ctx.routeClassifier }), { prefix: '/api' });
  await app.register(conversationRoutes, { prefix: '/api' });
  await app.register((fastify) => permissionRuleRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => promptRoutes(fastify, { prompts }), { prefix: '/api' });
  await app.register((fastify) => workflowRoutes(fastify, { workflows: ctx.workflows, usage: () => workflowUsage(ctx.asyncDb) }), { prefix: '/api' });
  await app.register((fastify) => configRoutes(fastify, { ...contexts.execution, prompts, workflows: ctx.workflows, workspaces: ctx.workspaces }), { prefix: '/api' });
  await app.register((fastify) => globalPauseRoutes(fastify, contexts.execution), { prefix: '/api' });
  await app.register((fastify) => updateRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => authRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => statsRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => activityRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => agentMessageRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => timelineRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => operationRoutes(fastify, ctx), { prefix: '/api' });
  await app.register((fastify) => scheduledJobRoutes(fastify, contexts.tracking), { prefix: '/api' });
  await app.register((fastify) => worktreeRoutes(fastify, contexts.execution), { prefix: '/api' });
  await app.register((fastify) => secretRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => executionTargetRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => trackerSettingsRoutes(fastify, contexts.tracking), { prefix: '/api' });
  await app.register(harnessRoutes, { prefix: '/api' });
  await app.register((fastify) => channelRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => notificationRoutes(fastify, contexts.persistence), { prefix: '/api' });
  await app.register((fastify) => fsRoutes(fastify, contexts.tracking), { prefix: '/api' });
  await app.register((fastify) => exportRoutes(fastify, contexts.execution), { prefix: '/api' });
  await app.register((fastify) => epicRoutes(fastify, ctx), { prefix: '/api' });
  await app.register(openapiRoutes, { prefix: '/api' });

  app.post('/mcp', { schema: { hide: true } }, async (req, reply) => {
    const mcp = buildMcpServer(ctx, await resolveMcpCaller(ctx, req));
    // MCP SDK option/interface types don't satisfy this project's exactOptionalPropertyTypes; both casts erase that mismatch, not our types.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as any);
    reply.hijack();
    try {
      await mcp.connect(transport as any);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      logger.error(`mcp request failed: ${errorMessage(err)}`, { errorId: String(req.id), route: '/mcp', url: req.url, ...(err instanceof Error && err.stack ? { stack: err.stack } : {}) });
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(JSON.stringify({ error: { code: 'internal', message: 'internal server error', id: String(req.id) } }));
      } else reply.raw.destroy();
    }
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
      // Release tarballs pin mtimes and index.html keeps its size across versions, so
      // size+mtime validators would 304 an upgraded browser onto the previous bundle.
      etag: false,
      lastModified: false,
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
