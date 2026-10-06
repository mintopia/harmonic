import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PersistenceContext } from '../app.js';
import { NOTIFICATION_SEVERITIES } from '../../db/schema.js';
import { notificationToApi } from '../dto.js';
import { idParamsSchema, errorResponse } from '../schemas.js';
import { MAX_LIMIT } from '../pagination.js';

const notificationSchema = z
  .object({
    id: z.number().meta({ example: 812 }),
    severity: z.enum(NOTIFICATION_SEVERITIES).meta({ example: 'escalation' }),
    title: z.string().meta({ example: 'Task 4821 escalated — Verification failed after 2 Attempts' }),
    detail: z.string().nullable().meta({ example: 'Verification failed twice; waiting for a decision.' }),
    workspaceId: z.number().nullable().meta({ example: 12 }),
    taskId: z.number().nullable().meta({ example: 4821, description: 'The Ticket link; may name a since-deleted Task.' }),
    createdAt: z.number().meta({ example: 1784030400000 }),
    readAt: z.number().nullable().meta({ example: null }),
    read: z.boolean().meta({ example: false }),
  })
  .meta({ id: 'Notification' });

const listQuerySchema = z.object({
  severity: z.enum(NOTIFICATION_SEVERITIES).optional().meta({ example: 'escalation' }),
  workspaceId: z.coerce.number().int().positive().optional().meta({ example: 12 }),
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true')
    .meta({ example: 'true' }),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(50).meta({ example: 50 }),
  before: z.coerce.number().int().positive().optional().meta({ example: 812 }),
});

const listResponseSchema = z.object({
  items: z.array(notificationSchema),
  unreadCount: z.number().int().nonnegative().meta({ example: 3 }),
});

const readAllBodySchema = z.object({ workspaceId: z.number().int().positive().optional().meta({ example: 12 }) });

export async function notificationRoutes(fastify: FastifyInstance, ctx: Pick<PersistenceContext, 'notifications'>): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/notifications',
    {
      schema: {
        tags: ['Notifications'],
        description:
          'List stored Notifications, newest first. `workspaceId` is the Workspace Scope; omitted means Global. ' +
          '`before` is an id cursor: pass the last id of the previous page. `unreadCount` respects the Workspace Scope only. ' +
          '',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        querystring: listQuerySchema,
        response: { 200: listResponseSchema.describe('One page of Notifications plus the unread count for the scope.') },
      },
    },
    async (req) => {
      const { severity, workspaceId, unread, limit, before } = req.query;
      const { items, unreadCount } = await ctx.notifications.list({
        limit,
        unread,
        ...(severity !== undefined && { severity }),
        ...(workspaceId !== undefined && { workspaceId }),
        ...(before !== undefined && { before }),
      });
      return { items: items.map(notificationToApi), unreadCount };
    },
  );

  app.post(
    '/notifications/read-all',
    {
      schema: {
        tags: ['Notifications'],
        description: 'Mark every unread Notification in the scope read (all Workspaces when `workspaceId` is omitted).',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: readAllBodySchema,
        response: { 200: z.object({ updated: z.number().int().nonnegative().meta({ example: 3 }) }).describe('How many Notifications changed.') },
      },
    },
    async (req) => {
      const ids = await ctx.notifications.markAllRead(req.body.workspaceId);
      return { updated: ids.length };
    },
  );

  app.post(
    '/notifications/:id/read',
    {
      schema: {
        tags: ['Notifications'],
        description: 'Mark one Notification read. Idempotent: the first read time is kept.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: z.object({ notification: notificationSchema }).describe('The Notification after the update.'),
          404: errorResponse('No Notification has this id.'),
        },
      },
    },
    async (req) => ({ notification: notificationToApi(await ctx.notifications.markRead(req.params.id)) }),
  );
}
