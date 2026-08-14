import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { createWorkspaceInputSchema, updateWorkspaceInputSchema } from '../../domain/workspaces.js';
import { DomainError } from '../../domain/errors.js';
import { idParamsSchema, errorResponse } from '../schemas.js';

/** A Workspace (ADR-0008) as the API serves it (domain/workspaces.ts `WorkspaceRow`). */
const workspaceSchema = z
  .object({
    id: z.number().meta({ example: 1 }),
    name: z.string().meta({ example: 'Harmonic' }),
    workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
    trackerEnabled: z.boolean().meta({ example: false }),
    trackerPollIntervalSeconds: z.number().meta({ example: 60 }),
    // Per-workspace setting overrides (ADR-0012): null ⇒ inherit the global
    // default, a value overrides it. Resolved at read time (issue #60).
    harness: z.string().nullable().meta({ example: null }),
    model: z.string().nullable().meta({ example: null }),
    isolationMode: z.string().nullable().meta({ example: null }),
    priority: z.string().nullable().meta({ example: null }),
    maxConcurrentRuns: z.number().nullable().meta({ example: null }),
    autoRunnerEnabled: z.boolean().nullable().meta({ example: null }),
    createdAt: z.number().meta({ example: 1784030400000 }),
    updatedAt: z.number().meta({ example: 1784032260000 }),
  })
  .meta({ id: 'Workspace' });

const workspacesListResponseSchema = z.object({ workspaces: z.array(workspaceSchema) });

export async function workspaceRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/workspaces',
    {
      schema: {
        tags: ['Workspaces'],
        description: 'List Workspaces. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: { 200: workspacesListResponseSchema.describe('Every Workspace, oldest first.') },
      },
    },
    async () => ({ workspaces: ctx.workspaces.list() }),
  );

  app.post(
    '/workspaces',
    {
      schema: {
        tags: ['Workspaces'],
        description:
          'Create a Workspace: a named Working Directory, unique by absolute path. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: createWorkspaceInputSchema,
        response: {
          201: workspaceSchema.describe('The created Workspace.'),
          400: errorResponse('The payload failed validation, or the working directory does not exist.'),
          409: errorResponse('Another Workspace already uses that absolute path.'),
        },
      },
    },
    async (req, reply) => {
      const workspace = ctx.workspaces.create(req.body);
      ctx.trackerManager.sync(); // created with tracker on ⇒ start its poll loop now
      return reply.status(201).send(workspace);
    },
  );

  app.get(
    '/workspaces/:id',
    {
      schema: {
        tags: ['Workspaces'],
        description: 'Get one Workspace. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: workspaceSchema.describe('The Workspace.'),
          404: errorResponse('No Workspace has that id.'),
        },
      },
    },
    async (req) => ctx.workspaces.get(req.params.id),
  );

  app.patch(
    '/workspaces/:id',
    {
      schema: {
        tags: ['Workspaces'],
        description:
          'Rename a Workspace or repoint its Working Directory. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        body: updateWorkspaceInputSchema,
        response: {
          200: workspaceSchema.describe('The updated Workspace.'),
          400: errorResponse('The payload failed validation, or the working directory does not exist.'),
          404: errorResponse('No Workspace has that id.'),
          409: errorResponse('Another Workspace already uses that absolute path.'),
        },
      },
    },
    async (req) => {
      const workspace = ctx.workspaces.update(req.params.id, req.body);
      ctx.trackerManager.sync(); // toggling tracker / repointing the repo / changing the interval takes effect now
      return workspace;
    },
  );

  app.delete(
    '/workspaces/:id',
    {
      schema: {
        tags: ['Workspaces'],
        description:
          'Delete a Workspace and everything on its board, stopping its tracker poll loop. Refuses a Workspace with a running Task; deleting the last Workspace is allowed. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          204: z.null().describe('The Workspace and its board were deleted.'),
          404: errorResponse('No Workspace has that id.'),
          409: errorResponse('It has a running Task.'),
        },
      },
    },
    async (req, reply) => {
      ctx.workspaces.delete(req.params.id);
      ctx.trackerManager.sync(); // the deleted Workspace's poll loop stops here
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/workspaces/:id/tracker/refresh',
    {
      schema: {
        tags: ['Workspaces'],
        description:
          'Force an immediate tracker poll for a Workspace — rescan its Working Directory and mirror any ticket changes onto the board now, instead of waiting for the next interval. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: z.object({ ok: z.literal(true) }).describe('The tracker was re-polled.'),
          404: errorResponse('No Workspace has that id.'),
          409: errorResponse('Tracking is not enabled for this Workspace.'),
          500: errorResponse('The tracker scan failed (e.g. an unreadable ticket directory).'),
        },
      },
    },
    async (req) => {
      const ws = ctx.workspaces.get(req.params.id); // 404 if missing
      if (!ws.trackerEnabled) throw new DomainError('conflict', `tracking is not enabled for workspace ${ws.id}`);
      await ctx.trackerManager.pollNow(ws.id);
      return { ok: true as const };
    },
  );
}
