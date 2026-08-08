import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { createWorkspaceInputSchema, updateWorkspaceInputSchema } from '../../domain/workspaces.js';
import { idParamsSchema, errorResponse } from '../schemas.js';

/** A Workspace (ADR-0008) as the API serves it (domain/workspaces.ts `WorkspaceRow`). */
const workspaceSchema = z
  .object({
    id: z.number().meta({ example: 1 }),
    name: z.string().meta({ example: 'Harmonic' }),
    workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
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
    async (req, reply) => reply.status(201).send(ctx.workspaces.create(req.body)),
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
    async (req) => ctx.workspaces.update(req.params.id, req.body),
  );
}
