import { z } from 'zod';
import type { AgentMessageRecipient, TaskRow } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import { resolveScoped } from '../domain/setting-override.js';
import { deliverAgentMessage } from '../execution/agent-message-delivery.js';
import type { AppContext } from '../server/app.js';
import type { McpCaller } from './caller.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { wrapAsync } from './tool-result.js';

const OPEN_STATES: readonly string[] = ['ready', 'working', 'paused', 'escalated'];

const epicAddress = (task: TaskRow): string | null => (task.trackerParent == null ? null : `epic:${task.trackerParent}`);

async function openSiblings(ctx: AppContext, task: TaskRow): Promise<TaskRow[]> {
  if (task.trackerParent == null || task.workspaceId == null) return [];
  const members = await ctx.tasks.list({ workspaceId: task.workspaceId, parent: task.trackerParent });
  return members.filter((t) => t.id !== task.id && OPEN_STATES.includes(t.state));
}

/** Resolves a recipient address ("epic:<n>", "task:<n>", "#<n>" or a bare number) to the open Tasks it reaches, or refuses with a reason. */
async function resolveRecipients(ctx: AppContext, sender: TaskRow, to: string): Promise<number[]> {
  const address = to.trim();
  if (/^epic:/i.test(address)) {
    if (address.toLowerCase() !== epicAddress(sender)) throw new DomainError('forbidden', `${address} is not your Epic`);
    const siblings = await openSiblings(ctx, sender);
    if (siblings.length === 0) throw new DomainError('invalid_state', 'your Epic has no open sibling Tasks');
    return siblings.map((t) => t.id);
  }
  const id = Number(/^(?:task:|#)?(\d+)$/i.exec(address)?.[1]);
  if (!Number.isInteger(id)) throw new DomainError('validation', `unrecognised recipient "${to}"; use a Task id or the Epic address from list_peers`);
  if (id === sender.id) throw new DomainError('forbidden', 'you cannot send a message to yourself');
  const recipient = await ctx.tasks.get(id).catch(() => null);
  if (!recipient || recipient.workspaceId !== sender.workspaceId) {
    throw new DomainError('forbidden', `Task #${id} is not in your Workspace`);
  }
  if (!OPEN_STATES.includes(recipient.state)) {
    throw new DomainError('invalid_state', `Task #${id} is ${recipient.state} and cannot receive messages`);
  }
  return [id];
}

export function registerAgentMessageTools(server: McpServer, ctx: AppContext, caller: McpCaller): void {
  const { attempt, task, workspace } = caller;
  if (caller.scope !== 'attempt' || !attempt || !task || !workspace) return;
  const global = ctx.settingsStore.getGlobal().agentMessages;
  if (!resolveScoped('agentMessagesEnabled', workspace.agentMessagesEnabled, global.enabled)) return;
  const sendCap = resolveScoped('agentMessagesSendCap', workspace.agentMessagesSendCap, global.sendCap);

  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to a peer Task in this Workspace, or to every open sibling in your Epic. `to` is a Task id ' +
        'or the Epic address from list_peers. Set `replyTo` to a message id to reply in its Thread.',
      inputSchema: {
        to: z.union([z.string().min(1), z.number().int().positive()]).describe('Task id or Epic address'),
        text: z.string().min(1),
        replyTo: z.string().optional().describe('Id of the message being replied to'),
      },
    },
    wrapAsync(async ({ to, text, replyTo }) => {
      const sent = await ctx.agentMessages.countForAttempt(attempt.id);
      if (sent >= sendCap) {
        throw new DomainError('forbidden', `send cap of ${sendCap} messages per Attempt reached`);
      }
      const recipientIds = await resolveRecipients(ctx, task, String(to));
      let threadId: string | null = null;
      if (replyTo !== undefined) {
        const parent = await ctx.agentMessages.get(replyTo);
        const involved = parent && parent.workspaceId === workspace.id && (parent.senderTaskId === task.id || parent.recipients.some((r) => r.taskId === task.id));
        if (!parent || !involved) throw new DomainError('not_found', `no message ${replyTo} that you sent or received`);
        threadId = parent.threadId;
      }
      const recipients: AgentMessageRecipient[] = recipientIds.map((taskId) => ({ taskId, receipt: 'queued' }));
      const row = await ctx.agentMessages.create({
        workspaceId: workspace.id,
        text,
        replyTo: replyTo ?? null,
        threadId,
        senderTaskId: task.id,
        senderAttemptId: attempt.id,
        recipients,
      });
      const receipts = await deliverAgentMessage({ store: ctx.agentMessages, runner: ctx.runner }, row, task);
      return { messageId: row.id, threadId: row.threadId, recipients: receipts, sendsRemaining: sendCap - sent - 1 };
    }),
  );

  server.registerTool(
    'read_messages',
    { description: 'Read the Agent Messages this Task has sent and received, oldest first.', inputSchema: {} },
    wrapAsync(async () => await ctx.agentMessages.presentedForTask(workspace.id, task.id)),
  );

  server.registerTool(
    'list_peers',
    { description: 'List the open sibling Tasks in your Epic that you can message, and the Epic address.', inputSchema: {} },
    wrapAsync(async () => ({
      epic: epicAddress(task),
      peers: (await openSiblings(ctx, task)).map((t) => ({
        taskId: t.id,
        title: t.trackerTitle ?? t.prompt.split('\n')[0]?.slice(0, 120) ?? '',
        state: t.state,
        live: ctx.runner.hasLiveAgent(t.id),
      })),
    })),
  );
}
