import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { RECEIPT_STATES } from '../../db/schema.js';
import { resolveScoped } from '../../domain/setting-override.js';
import { MAX_LIMIT, listResponse, paginationQuerySchema } from '../pagination.js';

const DEFAULT_THREAD_LIMIT = 50;

const recipientSchema = z.object({
  taskId: z.number().int().meta({ example: 12 }),
  receipt: z.enum(RECEIPT_STATES).meta({ example: 'delivered' }),
  mode: z.enum(['mid-turn', 'next-turn']).optional(),
  deliveredAt: z.number().optional(),
  reason: z.string().optional(),
  deleted: z.boolean(),
});

const messageSchema = z.object({
  messageId: z.string(),
  role: z.string().meta({ example: 'agent' }),
  parts: z.array(z.object({ kind: z.literal('text'), text: z.string() })),
  replyTo: z.string().nullable(),
  threadId: z.string(),
  senderTaskId: z.number().int(),
  senderDeleted: z.boolean(),
  senderAttemptId: z.number().int(),
  workspaceId: z.number().int(),
  createdAt: z.number(),
  recipients: z.array(recipientSchema),
});

const participantSchema = z.object({
  taskId: z.number().int(),
  title: z.string().nullable(),
  harness: z.string().nullable(),
  epicId: z.number().int().nullable(),
  deleted: z.boolean(),
});

const threadSchema = z.object({
  threadId: z.string(),
  workspaceId: z.number().int(),
  latestAt: z.number().meta({ description: 'Epoch ms of the Thread\'s newest message.' }),
  live: z.boolean().meta({ description: 'True while any participant Task has a running Attempt.' }),
  messages: z.array(messageSchema).meta({ description: 'Oldest first.' }),
  participants: z.array(participantSchema).meta({ description: 'Senders and recipients in first-appearance order.' }),
});

export async function agentMessageRoutes(fastify: FastifyInstance, ctx: AppContext): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/agent-messages/threads',
    {
      schema: {
        tags: ['Agent Messages'],
        description:
          'Agent Message Threads, newest activity first. An omitted `workspaceId` is Global (every Workspace with Agent Messages enabled); ' +
          'Workspaces with Agent Messages disabled never contribute Threads. `epicId` keeps Threads with a participant Task under that Epic, ' +
          '`taskId` keeps Threads that Task sent or received in, `live=true` keeps Threads with a participant running an Attempt.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        querystring: paginationQuerySchema.extend({
          limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_THREAD_LIMIT),
          workspaceId: z.coerce.number().int().positive().optional(),
          epicId: z.coerce.number().int().optional(),
          taskId: z.coerce.number().int().optional(),
          live: z.enum(['true', 'false']).optional(),
        }),
        response: {
          200: listResponse('threads', threadSchema)
            .extend({ totalMessages: z.number().int().nonnegative().meta({ description: 'Messages across every Thread matching the filters, not just the page.' }) })
            .describe('Threads with their messages, participants and per-recipient receipts; an empty array when none match.'),
        },
      },
    },
    async (req) => {
      const { limit, offset, workspaceId, epicId, taskId, live } = req.query;
      const globalEnabled = ctx.settingsStore.getGlobal().agentMessages.enabled;
      const workspaceIds = (await ctx.workspaces.list())
        .filter((ws) => (workspaceId === undefined || ws.id === workspaceId) && resolveScoped('agentMessagesEnabled', ws.agentMessagesEnabled, globalEnabled))
        .map((ws) => ws.id);
      return ctx.agentMessages.listThreads({ workspaceIds, epicId, taskId, live: live === 'true', limit, offset });
    },
  );
}
