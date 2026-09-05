import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ExecutionContext } from '../app.js';

const globalPauseSchema = z.object({ paused: z.boolean() });

export async function globalPauseRoutes(
  app: FastifyInstance,
  ctx: Pick<ExecutionContext, 'globalPause'>,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { sessionCookie: [] }];
  const schema = (responseDescription: string) => ({
    tags: ['Execution'],
    description: 'Get the fleet-wide execution pause state. Operator only.',
    security,
    response: { 200: globalPauseSchema.describe(responseDescription) },
  });

  typed.get('/global-pause', { schema: schema('The current fleet-wide execution pause state.') }, async () => ({ paused: ctx.globalPause.isLatched }));

  typed.post('/global-pause', { schema: { ...schema('The latched fleet-wide execution pause state.'), description: 'Pause all execution and latch new Attempts in paused. Operator only.' } }, async () => {
    await ctx.globalPause.pause();
    return { paused: true };
  });

  typed.delete('/global-pause', { schema: { ...schema('The cleared fleet-wide execution pause state.'), description: 'Clear the fleet-wide execution pause and resume its paused Attempts. Operator only.' } }, async () => {
    await ctx.globalPause.resume();
    return { paused: false };
  });
}
