import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { createChannelSchema, updateChannelSchema } from '../../notifications/channels.js';

export async function channelRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const idOf = (params: unknown): number => Number((params as { id: string }).id);

  fastify.post('/channels', async (req, reply) =>
    reply.status(201).send(ctx.channels.create(createChannelSchema.parse(req.body))),
  );

  fastify.get('/channels', async () => ({ channels: ctx.channels.list() }));

  fastify.get('/channels/:id', async (req) => ctx.channels.get(idOf(req.params)));

  fastify.patch('/channels/:id', async (req) =>
    ctx.channels.update(idOf(req.params), updateChannelSchema.parse(req.body)),
  );

  fastify.delete('/channels/:id', async (req) => {
    ctx.channels.delete(idOf(req.params));
    return { ok: true };
  });

  // Per-task overrides: this task announces itself to this channel.
  fastify.post('/tasks/:id/channels', async (req) => {
    const { channelId } = z.object({ channelId: z.number().int().positive() }).parse(req.body);
    ctx.tasks.get(idOf(req.params));
    ctx.channels.addOverride(idOf(req.params), channelId);
    return { channelIds: ctx.channels.channelIdsForTask(idOf(req.params)) };
  });

  fastify.delete('/tasks/:id/channels/:channelId', async (req) => {
    const channelId = Number((req.params as { channelId: string }).channelId);
    ctx.channels.removeOverride(idOf(req.params), channelId);
    return { channelIds: ctx.channels.channelIdsForTask(idOf(req.params)) };
  });

  fastify.get('/tasks/:id/channels', async (req) => {
    ctx.tasks.get(idOf(req.params));
    return { channelIds: ctx.channels.channelIdsForTask(idOf(req.params)) };
  });
}
