import { trackerRef } from '../../tracker/adapter.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { RECEIPT_STATES, TASK_STATES } from '../../db/schema.js';
import { resolveAgentMessages } from '../../domain/agent-messages.js';
import { MAX_LIMIT, listResponse, paginationQuerySchema } from '../pagination.js';

const DEFAULT_THREAD_LIMIT = 50;

const recipientSchema = z
  .object({
    taskId: z.number().int().positive().describe('Recipient Task id.').meta({ example: 12 }),
    receipt: z.enum(RECEIPT_STATES).describe('Delivery state: queued, delivered, held, or refused.').meta({ example: 'delivered' }),
    mode: z.enum(['mid-turn', 'next-turn']).optional().describe('How a delivered message reached the Agent; absent while held or refused.'),
    deliveredAt: z.number().optional().describe('Epoch ms the message was delivered; absent until then.'),
    reason: z.string().optional().describe('Why the message was refused; present only when refused.'),
    deleted: z.boolean().describe('True when the recipient Task no longer exists.'),
  })
  .meta({ id: 'AgentMessageRecipient', description: "One recipient's delivery receipt for an Agent Message." });

const messageSchema = z
  .object({
    messageId: z.string().describe('Agent Message id.'),
    role: z.string().describe('A2A-shaped role of the sender.').meta({ example: 'agent' }),
    parts: z.array(z.object({ kind: z.literal('text'), text: z.string() })).describe('Message content as A2A-shaped text Parts.'),
    replyTo: z.string().nullable().describe('Id of the message this one replies to; null for a Thread root.'),
    threadId: z.string().describe('Id of the Thread (the root message id).'),
    senderTaskId: z.number().int().positive().describe('Task that sent the message.'),
    senderDeleted: z.boolean().describe('True when the sender Task no longer exists.'),
    senderAttemptId: z.number().int().positive().describe('Attempt that sent the message.'),
    senderAttemptNumber: z.number().int().nullable().describe('Number of the sending Attempt within its Task; null when the Attempt no longer exists.'),
    workspaceId: z.number().int().positive().describe('Workspace the message belongs to.'),
    createdAt: z.number().describe('Epoch ms the message was sent.'),
    recipients: z.array(recipientSchema).describe('Every recipient with its own receipt; an Epic-addressed message has one per open sibling.'),
  })
  .meta({ id: 'AgentMessage', description: 'An Agent Message sent between Tasks in a Workspace.' });

const participantSchema = z
  .object({
    taskId: z.number().int().positive().describe('Participant Task id.'),
    title: z.string().nullable().describe('Display title of the Task; null when deleted.'),
    harness: z.string().nullable().describe('Harness the Task runs on; null when deleted.'),
    epicId: z.string().nullable().describe('Tracker ref of the Task\'s Epic; null when it has none or is deleted.'),
    deleted: z.boolean().describe('True when the Task no longer exists.'),
    model: z.string().nullable().describe("The Task's stored model; null when unset or the Task is deleted."),
    state: z.enum(TASK_STATES).nullable().describe("The Task's lifecycle state; null when deleted."),
    betweenAttempts: z.boolean().describe('Working with no running Attempt.'),
    attemptNumber: z.number().int().nullable().describe('Number of the latest Attempt; null when none.'),
    sends: z.number().int().nonnegative().describe('Messages the latest Attempt has sent; render with `sendCap` as "sends/sendCap".'),
    sendCap: z.number().int().nonnegative().describe("The Task's Workspace Agent Messages send cap."),
    lastMessageAt: z.number().nullable().describe('Epoch ms of the newest message this Task sent in the Thread.'),
  })
  .meta({ id: 'AgentMessageParticipant', description: 'A Task that sent or received messages in a Thread.' });

const threadSchema = z
  .object({
    threadId: z.string().describe('Thread id (the root message id).'),
    workspaceId: z.number().int().positive().describe('Workspace the Thread belongs to.'),
    workspaceName: z.string().describe('Display name of that Workspace.'),
    latestAt: z.number().describe("Epoch ms of the Thread's newest message."),
    live: z.boolean().describe('True while any participant Task has a running Attempt.'),
    messages: z.array(messageSchema).describe('Oldest first.'),
    participants: z.array(participantSchema).describe('Senders and recipients in first-appearance order.'),
  })
  .meta({ id: 'AgentMessageThread', description: 'A root Agent Message and its replies, with the Tasks taking part.' });

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
          workspaceId: z.coerce.number().int().positive().optional().describe('Restrict to one Workspace; omit for Global.'),
          epicId: z.string().min(1).optional().describe('Keep Threads with a participant Task under this Epic tracker ref.'),
          taskId: z.coerce.number().int().positive().optional().describe('Keep Threads this Task sent or received in.'),
          live: z.enum(['true', 'false']).optional().describe('`true` keeps Threads with a participant running an Attempt.'),
        }),
        response: {
          200: listResponse('threads', threadSchema)
            .extend({ totalMessages: z.number().int().nonnegative().describe('Messages across every Thread matching the filters, not just the page.') })
            .describe('Threads with their messages, participants and per-recipient receipts; an empty array when none match.'),
        },
      },
    },
    async (req) => {
      const { limit, offset, workspaceId, epicId, taskId, live } = req.query;
      const global = ctx.settingsStore.getGlobal().agentMessages;
      const resolved = (await ctx.workspaces.list()).map((ws) => ({ ws, ...resolveAgentMessages(ws, global) }));
      const workspaceInfo = new Map(resolved.map(({ ws, sendCap }) => [ws.id, { name: ws.name, sendCap }]));
      const workspaceIds = resolved.filter(({ ws, enabled }) => (workspaceId === undefined || ws.id === workspaceId) && enabled).map(({ ws }) => ws.id);
      return ctx.agentMessages.listThreads({ workspaceIds, workspaceInfo, epicId: epicId === undefined ? undefined : trackerRef(epicId), taskId, live: live === 'true', limit, offset });
    },
  );
}
