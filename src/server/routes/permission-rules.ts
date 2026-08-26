import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { idParamsSchema, okResponseSchema, errorResponse } from '../schemas.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';

/** A persistent Permission Rule as the API serves it (ADR-0007). */
const permissionRuleSchema = z
  .object({
    id: z.number().meta({ example: 1150 }),
    /** ACP tool kind (read / edit / execute / fetch). */
    kind: z.string().meta({ example: 'edit' }),
    workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
    createdAt: z.number().meta({ example: 1784030400000 }),
  })
  .meta({ id: 'PermissionRule' });

const permissionRulesListResponseSchema = listResponse('rules', permissionRuleSchema);

export async function permissionRuleRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/permission-rules',
    {
      schema: {
        tags: ['Conversations'],
        description:
          'List persistent Permission Rules (auto-approve a tool kind in a Working Directory across Conversations). Operator only; not reachable with a run-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        querystring: paginationQuerySchema,
        response: { 200: permissionRulesListResponseSchema.describe('Every Permission Rule in force, newest first.') },
      },
    },
    async (req) => {
      const { limit, offset } = req.query;
      const { items, total } = paginate(await ctx.permissionRules.list(), { limit, offset });
      return { rules: items, total };
    },
  );

  app.delete(
    '/permission-rules/:id',
    {
      schema: {
        tags: ['Conversations'],
        description:
          'Revoke a Permission Rule; matching requests prompt again afterwards. Operator only; not reachable with a run-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: okResponseSchema.describe('The rule was revoked; requests it used to auto-approve prompt again.'),
          404: errorResponse('No Permission Rule has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.permissionRules.delete(req.params.id);
      return { ok: true } as const;
    },
  );
}
