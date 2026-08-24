import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { operationRegistry } from '../../telemetry/operations.js';
import { operationSchema } from '../schemas.js';
import { operationsToApi, recentOperationsToApi } from '../serialize.js';

const operationsResponseSchema = z.object({ operations: z.array(operationSchema), recent: z.array(operationSchema) });

/** Process-local trace operations. History is intentionally bounded and non-durable. */
export async function operationRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get('/operations', {
    schema: {
      tags: ['Operations'],
      description: 'Current open Operation tree plus a bounded, in-memory history of recently completed root Operations.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      response: { 200: operationsResponseSchema.describe('The current Operation forest and recent completed root Operations.') },
    },
  }, async () => ({
    operations: operationsToApi(operationRegistry.list()),
    recent: recentOperationsToApi(operationRegistry.recentRoots()),
  }));
}
