import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { createChannelSchema, updateChannelSchema, NOTIFICATION_EVENTS } from '../../notifications/channels.js';
import { CHANNEL_TYPES } from '../../db/schema.js';
import { idParamsSchema, okResponseSchema, errorResponse } from '../schemas.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';

const channelIdParamsSchema = z.object({
  id: z.coerce.number().int().meta({ example: 4821 }),
  channelId: z.coerce.number().int().meta({ example: 3702 }),
});
const channelIdBodySchema = z.object({ channelId: z.number().int().positive().meta({ example: 3702 }) });

/** A notification channel (notifications/channels.ts `Channel`) as the API serves it. */
const channelSchema = z
  .object({
    id: z.number().meta({ example: 3702 }),
    name: z.string().meta({ example: 'Review inbox' }),
    type: z.enum(CHANNEL_TYPES).meta({ example: 'discord' }),
    /**
     * Type-specific delivery config (url/secret/smtp/from/to) — shape depends on `type`.
     * The example is a discord channel's; email carries `smtp`/`from`/`to` instead.
     */
    config: z.record(z.string(), z.unknown()).meta({
      example: { url: 'https://discord.com/api/webhooks/000000000000000000/EXAMPLE-WEBHOOK-TOKEN' },
    }),
    /** Subscribed event types; defaults to the escalation moment (DEFAULT_EVENTS). */
    events: z.array(z.enum(NOTIFICATION_EVENTS)).meta({ example: ['task.escalated'] }),
    createdAt: z.number().meta({ example: 1784030400000 }),
  })
  .meta({ id: 'Channel' });

const channelsListResponseSchema = listResponse('channels', channelSchema);
/** The full (unpaginated) channel-id override list a mutation echoes back. */
const channelIdsResponseSchema = z.object({ channelIds: z.array(z.number()).meta({ example: [3702] }) });
const channelIdsListResponseSchema = listResponse('channelIds', z.number());

export async function channelRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/channels',
    {
      schema: {
        tags: ['Channels'],
        description:
          'Create a notification channel. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: createChannelSchema,
        response: {
          201: channelSchema.describe('The created channel; events falls back to the default subscriptions when omitted.'),
          400: errorResponse(
            "The payload failed validation, or the config does not match the shape the channel's type requires.",
          ),
        },
      },
    },
    async (req, reply) => reply.status(201).send(await ctx.channels.create(req.body)),
  );

  app.get(
    '/channels',
    {
      schema: {
        tags: ['Channels'],
        description: 'List notification channels. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        querystring: paginationQuerySchema,
        response: { 200: channelsListResponseSchema.describe('Every configured notification channel.') },
      },
    },
    async (req) => {
      const { limit, offset } = req.query;
      const { items, total } = paginate(await ctx.channels.list(), { limit, offset });
      return { channels: items, total };
    },
  );

  app.get(
    '/channels/:id',
    {
      schema: {
        tags: ['Channels'],
        description: 'Get one notification channel. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: channelSchema.describe('The channel, with its delivery config and subscriptions.'),
          404: errorResponse('No channel has that id.'),
        },
      },
    },
    async (req) => await ctx.channels.get(req.params.id),
  );

  app.patch(
    '/channels/:id',
    {
      schema: {
        tags: ['Channels'],
        description: 'Edit a notification channel. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        body: updateChannelSchema,
        response: {
          200: channelSchema.describe('The updated channel.'),
          400: errorResponse(
            "The payload failed validation, or the config does not match the shape the channel's existing type requires.",
          ),
          404: errorResponse('No channel has that id.'),
        },
      },
    },
    async (req) => await ctx.channels.update(req.params.id, req.body),
  );

  app.delete(
    '/channels/:id',
    {
      schema: {
        tags: ['Channels'],
        description: 'Delete a notification channel. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: okResponseSchema.describe('The channel was deleted, along with every per-task override pointing at it.'),
          404: errorResponse('No channel has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.channels.delete(req.params.id);
      return { ok: true } as const;
    },
  );

  app.post(
    '/tasks/:id/channels',
    {
      schema: {
        tags: ['Channels'],
        description:
          'Add a per-task channel override: this task announces its events to this channel in addition to the channel\'s own subscriptions. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        body: channelIdBodySchema,
        response: {
          200: channelIdsResponseSchema.describe(
            'Every channel id now overridden for the task; adding an override that is already set changes nothing.',
          ),
        },
      },
    },
    async (req) => {
      await ctx.tasks.get(req.params.id);
      await ctx.channels.addOverride(req.params.id, req.body.channelId);
      return { channelIds: await ctx.channels.channelIdsForTask(req.params.id) };
    },
  );

  app.delete(
    '/tasks/:id/channels/:channelId',
    {
      schema: {
        tags: ['Channels'],
        description: 'Remove a per-task channel override. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: channelIdParamsSchema,
        response: {
          200: channelIdsResponseSchema.describe(
            'Every channel id still overridden for the task; removing an override that was not set is a no-op.',
          ),
        },
      },
    },
    async (req) => {
      await ctx.channels.removeOverride(req.params.id, req.params.channelId);
      return { channelIds: await ctx.channels.channelIdsForTask(req.params.id) };
    },
  );

  app.get(
    '/tasks/:id/channels',
    {
      schema: {
        tags: ['Channels'],
        description:
          "List a task's per-task channel overrides. Operator only; not reachable with an attempt-scoped Attempt Key.",
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: channelIdsListResponseSchema.describe(
            "The channel ids overridden for the task, empty when it relies solely on the channels' own subscriptions.",
          ),
        },
      },
    },
    async (req) => {
      await ctx.tasks.get(req.params.id);
      const { limit, offset } = req.query;
      const { items, total } = paginate(await ctx.channels.channelIdsForTask(req.params.id), { limit, offset });
      return { channelIds: items, total };
    },
  );
}
