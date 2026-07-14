import type { FastifyInstance } from 'fastify';
import type { App } from '../app.js';

export async function configRepoRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;

  fastify.get('/config-repo', async () => ctx.configRepo.status());

  fastify.post('/config-repo/pull', async () => {
    const file = await ctx.configRepo.pull();
    return { ok: true, imported: Object.keys(file) };
  });

  fastify.post('/config-repo/export', async () => {
    const { path, file } = ctx.configRepo.export();
    return { ok: true, path, file };
  });
}
