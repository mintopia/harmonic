import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { createChannelSchema, updateChannelSchema, NOTIFICATION_EVENTS } from '../../notifications/channels.js';
import { CHANNEL_TYPES } from '../../db/schema.js';
import { idParamsSchema, okResponseSchema, errorResponse } from '../schemas.js';

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
    /** Subscribed event types; defaults to the review-gate and failure moments (DEFAULT_EVENTS). */
    events: z.array(z.enum(NOTIFICATION_EVENTS)).meta({ example: ['task.awaiting-review', 'task.failed'] }),
    createdAt: z.number().meta({ example: 1784030400000 }),
  })
  .meta({ id: 'Channel' });

const channelsListResponseSchema = z.object({ channels: z.array(channelSchema) });
const channelIdsResponseSchema = z.object({ channelIds: z.array(z.number()).meta({ example: [3702] }) });

export async function channelRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/channels',
    {
      schema: {
        tags: ['Channels'],
        description:
          'Create a notification channel. Operator only; not reachable with a run-scoped Run Key.',
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
    async (req, reply) => reply.status(201).send(ctx.channels.create(req.body)),
  );

  app.get(
    '/channels',
    {
      schema: {
        tags: ['Channels'],
        description: 'List notification channels. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: { 200: channelsListResponseSchema.describe('Every configured notification channel.') },
      },
    },
    async () => ({ channels: ctx.channels.list() }),
  );

  app.get(
    '/channels/:id',
    {
      schema: {
        tags: ['Channels'],
        description: 'Get one notification channel. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: channelSchema.describe('The channel, with its delivery config and subscriptions.'),
          404: errorResponse('No channel has that id.'),
        },
      },
    },
    async (req) => ctx.channels.get(req.params.id),
  );

  app.patch(
    '/channels/:id',
    {
      schema: {
        tags: ['Channels'],
        description: 'Edit a notification channel. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        body: updateChannelSchema,
        response: {
          200: channelSchema.describe('The updated channel.'),
          // A channel's type is fixed, so a replacement config is validated
          // against the type it already has.
          400: errorResponse(
            "The payload failed validation, or the config does not match the shape the channel's existing type requires.",
          ),
          404: errorResponse('No channel has that id.'),
        },
      },
    },
    async (req) => ctx.channels.update(req.params.id, req.body),
  );

  app.delete(
    '/channels/:id',
    {
      schema: {
        tags: ['Channels'],
        description: 'Delete a notification channel. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: okResponseSchema.describe('The channel was deleted, along with every per-task override pointing at it.'),
          404: errorResponse('No channel has that id.'),
        },
      },
    },
    async (req) => {
      ctx.channels.delete(req.params.id);
      return { ok: true } as const;
    },
  );

  // Per-task overrides: this task announces itself to this channel. These
  // live under /tasks/:id/channels but are operator-only (runScopedKeyAllowed
  // in app.ts denies the whole /tasks/:id/channels subtree).
  app.post(
    '/tasks/:id/channels',
    {
      schema: {
        tags: ['Channels'],
        description:
          'Add a per-task channel override: this task announces its events to this channel in addition to the channel\'s own subscriptions. Operator only; not reachable with a run-scoped Run Key.',
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
      ctx.tasks.get(req.params.id);
      ctx.channels.addOverride(req.params.id, req.body.channelId);
      return { channelIds: ctx.channels.channelIdsForTask(req.params.id) };
    },
  );

  app.delete(
    '/tasks/:id/channels/:channelId',
    {
      schema: {
        tags: ['Channels'],
        description: 'Remove a per-task channel override. Operator only; not reachable with a run-scoped Run Key.',
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
      ctx.channels.removeOverride(req.params.id, req.params.channelId);
      return { channelIds: ctx.channels.channelIdsForTask(req.params.id) };
    },
  );

  app.get(
    '/tasks/:id/channels',
    {
      schema: {
        tags: ['Channels'],
        description:
          "List a task's per-task channel overrides. Operator only; not reachable with a run-scoped Run Key.",
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: channelIdsResponseSchema.describe(
            "The channel ids overridden for the task, empty when it relies solely on the channels' own subscriptions.",
          ),
        },
      },
    },
    async (req) => {
      ctx.tasks.get(req.params.id);
      return { channelIds: ctx.channels.channelIdsForTask(req.params.id) };
    },
  );
}
