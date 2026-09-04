import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adapterFor } from '../../execution/harness/registry.js';

const harnessParamsSchema = z.object({ id: z.string().min(1).meta({ example: 'opencode' }) });
const modelQuerySchema = z.object({ provider: z.string().min(1).meta({ example: 'openai' }) });

const providerSchema = z.object({
  id: z.string(),
  label: z.string(),
  authed: z.boolean(),
});

const modelSchema = z.object({
  id: z.string(),
  label: z.string(),
  price: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
  }).optional(),
  contextWindow: z.number().int().positive().optional(),
});

export async function harnessRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/harnesses/:id/providers', {
    schema: {
      tags: ['Harnesses'],
      description: 'Discover the providers available to a harness. Harnesses without discovery capabilities return an empty list. Operator only; not reachable with an attempt-scoped Attempt Key.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      params: harnessParamsSchema,
      response: { 200: z.object({ providers: z.array(providerSchema) }).describe('The providers dynamically discovered by the harness.') },
    },
  }, async (req) => ({ providers: await adapterFor(req.params.id).capabilities?.selectProvider() ?? [] }));

  app.get('/harnesses/:id/models', {
    schema: {
      tags: ['Harnesses'],
      description: 'Discover the models available from a harness provider. Harnesses without discovery capabilities return an empty list. Operator only; not reachable with an attempt-scoped Attempt Key.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      params: harnessParamsSchema,
      querystring: modelQuerySchema,
      response: { 200: z.object({ models: z.array(modelSchema) }).describe('The models dynamically discovered for the selected provider.') },
    },
  }, async (req) => ({ models: await adapterFor(req.params.id).capabilities?.selectModel(req.query.provider) ?? [] }));
}
