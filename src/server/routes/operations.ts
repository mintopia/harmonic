import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { operationRegistry } from '../../telemetry/operations.js';
import { operationSchema } from '../schemas.js';
import { operationsToApi, recentOperationsToApi } from '../serialize.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';

const operationsResponseSchema = listResponse('operations', operationSchema).extend({
  recent: z.array(operationSchema),
});

/** Process-local trace operations. History is intentionally bounded and non-durable. */
export async function operationRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get('/operations', {
    schema: {
      tags: ['Operations'],
      description: 'Current open Operation tree plus a bounded, in-memory history of recently completed root Operations.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      querystring: paginationQuerySchema,
      response: { 200: operationsResponseSchema.describe('The current Operation forest and recent completed root Operations.') },
    },
  }, async (req) => {
    const { limit, offset } = req.query;
    const { items, total } = paginate(operationsToApi(operationRegistry.list()), { limit, offset });
    return {
      operations: items,
      total,
      recent: recentOperationsToApi(operationRegistry.recentRoots()),
    };
  });
}
