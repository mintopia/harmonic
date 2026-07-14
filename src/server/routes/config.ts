import type { FastifyInstance } from 'fastify';
import type { App } from '../app.js';

export async function configRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;

  fastify.get('/config', async () => ctx.configStore.get());

  fastify.patch('/config', async (req) => {
    const updated = ctx.configStore.update((req.body ?? {}) as Parameters<typeof ctx.configStore.update>[0]);
    ctx.autoRunner.poke();
    return updated;
  });
}
