import type { FastifyInstance } from 'fastify';
import type { App } from '../app.js';

export async function configRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;

  fastify.get('/config', async () => ctx.configStore.get());
}
