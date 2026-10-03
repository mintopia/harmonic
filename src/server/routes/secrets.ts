import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PersistenceContext } from '../app.js';
import { secretNameSchema, secretValueSchema } from '../../secrets/secret-service.js';
import { idParamsSchema, okResponseSchema, errorResponse } from '../schemas.js';
import { listResponse } from '../pagination.js';

const secretParamsSchema = idParamsSchema.extend({ name: secretNameSchema.meta({ example: 'forgejo-token' }) });

const secretStatusSchema = z
  .object({
    name: z.string().meta({ example: 'forgejo-token' }),
    set: z.literal(true),
    updatedAt: z.number().meta({ example: 1784030400000 }),
  })
  .meta({ id: 'SecretStatus', description: 'A Secret that is set. The value is write-only and never returned.' });

const secretStateSchema = z
  .object({ name: z.string().meta({ example: 'forgejo-token' }), set: z.boolean().meta({ example: true }) })
  .meta({ id: 'SecretState' });

export async function secretRoutes(fastify: FastifyInstance, ctx: Pick<PersistenceContext, 'secrets' | 'workspaces'>): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];

  app.get(
    '/workspaces/:id/secrets',
    {
      schema: {
        tags: ['Secrets'],
        description: 'List the Secrets set for a Workspace, by name only. Values are never returned. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security,
        params: idParamsSchema,
        response: {
          200: listResponse('secrets', secretStatusSchema).describe('The Secrets that are set, by name.'),
          404: errorResponse('No Workspace has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.workspaces.get(req.params.id);
      const rows = await ctx.secrets.list(req.params.id);
      return { secrets: rows.map((row) => ({ ...row, set: true as const })), total: rows.length };
    },
  );

  app.get(
    '/workspaces/:id/secrets/:name',
    {
      schema: {
        tags: ['Secrets'],
        description: 'Whether one Secret is set. The value is never returned. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security,
        params: secretParamsSchema,
        response: {
          200: secretStateSchema.describe('The Secret name and whether it is set.'),
          404: errorResponse('No Workspace has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.workspaces.get(req.params.id);
      return { name: req.params.name, set: await ctx.secrets.has(req.params.id, req.params.name) };
    },
  );

  app.put(
    '/workspaces/:id/secrets/:name',
    {
      schema: {
        tags: ['Secrets'],
        description: 'Set or replace a Secret. The value is write-only. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security,
        params: secretParamsSchema,
        body: z.object({ value: secretValueSchema.meta({ example: 'f0rg3jo-t0ken' }) }),
        response: {
          200: okResponseSchema.describe('The Secret is stored.'),
          400: errorResponse('The name or value failed validation.'),
          404: errorResponse('No Workspace has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.workspaces.get(req.params.id);
      await ctx.secrets.set(req.params.id, req.params.name, req.body.value);
      return { ok: true as const };
    },
  );

  app.delete(
    '/workspaces/:id/secrets/:name',
    {
      schema: {
        tags: ['Secrets'],
        description: 'Clear a Secret; clearing one that is not set succeeds. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security,
        params: secretParamsSchema,
        response: {
          200: okResponseSchema.describe('The Secret is not set.'),
          404: errorResponse('No Workspace has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.workspaces.get(req.params.id);
      await ctx.secrets.clear(req.params.id, req.params.name);
      return { ok: true as const };
    },
  );
}
