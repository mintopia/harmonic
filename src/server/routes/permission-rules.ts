import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { idParamsSchema, okResponseSchema, errorResponseSchema } from '../schemas.js';

/** A persistent Permission Rule as the API serves it (ADR-0007). */
const permissionRuleSchema = z
  .object({
    id: z.number(),
    /** ACP tool kind (read / edit / execute / fetch). */
    kind: z.string(),
    workingDir: z.string(),
    createdAt: z.number(),
  })
  .meta({ id: 'PermissionRule' });

const permissionRulesListResponseSchema = z.object({ rules: z.array(permissionRuleSchema) });

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
        response: { 200: permissionRulesListResponseSchema },
      },
    },
    async () => ({ rules: ctx.permissionRules.list() }),
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
        response: { 200: okResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req) => {
      ctx.permissionRules.delete(req.params.id);
      return { ok: true } as const;
    },
  );
}
