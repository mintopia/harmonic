import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { createChannelSchema, updateChannelSchema, NOTIFICATION_EVENTS } from '../../notifications/channels.js';
import { CHANNEL_TYPES } from '../../db/schema.js';
import { idParamsSchema, okResponseSchema, errorResponseSchema } from '../schemas.js';

const channelIdParamsSchema = z.object({ id: z.coerce.number().int(), channelId: z.coerce.number().int() });
const channelIdBodySchema = z.object({ channelId: z.number().int().positive() });

/** A notification channel (notifications/channels.ts `Channel`) as the API serves it. */
const channelSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    type: z.enum(CHANNEL_TYPES),
    /** Type-specific delivery config (url/secret/smtp/from/to) — shape depends on `type`. */
    config: z.record(z.string(), z.unknown()),
    events: z.array(z.enum(NOTIFICATION_EVENTS)),
    createdAt: z.number(),
  })
  .meta({ id: 'Channel' });

const channelsListResponseSchema = z.object({ channels: z.array(channelSchema) });
const channelIdsResponseSchema = z.object({ channelIds: z.array(z.number()) });

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
        response: { 201: channelSchema, 400: errorResponseSchema },
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
        response: { 200: channelsListResponseSchema },
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
        response: { 200: channelSchema, 404: errorResponseSchema },
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
        response: { 200: channelSchema, 400: errorResponseSchema, 404: errorResponseSchema },
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
        response: { 200: okResponseSchema, 404: errorResponseSchema },
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
        response: { 200: channelIdsResponseSchema },
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
        response: { 200: channelIdsResponseSchema },
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
        response: { 200: channelIdsResponseSchema },
      },
    },
    async (req) => {
      ctx.tasks.get(req.params.id);
      return { channelIds: ctx.channels.channelIdsForTask(req.params.id) };
    },
  );
}
