import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './app.js';
import { requestIsOperator } from './auth.js';
import { conversationToApi, attemptToApi, attemptUsageToApi, taskToApi } from './serialize.js';
import { operationEventToApi, scheduledJobsToApi, notificationToApi, worktreesToApi, type ApiAttemptSummary, type ApiConversation, type ApiTask } from './dto.js';
import { forEachYielding } from '../reliability/yield.js';
import { isTaskAttempt, type AttemptRow, type ConversationRow, type TaskRow } from '../db/schema.js';

/** Only the newest send per id is delivered; a removal invalidates any send still in flight for that id. */
function latestChangeSender<TRow, TApi>(toApi: (row: TRow) => Promise<TApi>): {
  send: (id: number, row: TRow, deliver: (api: TApi) => void) => Promise<void>;
  markRemoved: (id: number) => void;
} {
  const generation = new Map<number, number>();
  return {
    async send(id, row, deliver) {
      const gen = (generation.get(id) ?? 0) + 1;
      generation.set(id, gen);
      const api = await toApi(row);
      if (generation.get(id) !== gen) return;
      generation.delete(id);
      deliver(api);
    },
    markRemoved(id) {
      if (generation.has(id)) generation.set(id, generation.get(id)! + 1);
    },
  };
}

const filesSubscriptionSchema = z.object({
  type: z.enum(['subscribe_files', 'unsubscribe_files']),
  workspaceId: z.number().int().positive(),
});

export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

/** One firehose socket at /api/ws: every event is broadcast to every client; clients filter. */
export async function wsRoutes(fastify: FastifyInstance, ctx: AppContext): Promise<void> {

  fastify.get('/ws', { websocket: true }, async (socket, req) => {
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    // ws echoes back the client's first offered subprotocol, so this is the token the client authenticated the upgrade with.
    const hasWriteScope = await requestIsOperator(req, ctx.auth, socket.protocol || undefined);
    let unsubscribeAttemptLog: (() => void) | undefined;
    const fileSubscriptions = new Map<number, () => void>();
    const taskChanged = latestChangeSender<TaskRow, ApiTask>((task) => ctx.tasks.withDeps(task).then((withDeps) => taskToApi(ctx, withDeps)));
    const attemptChanged = latestChangeSender<AttemptRow, ApiAttemptSummary>((run) => attemptToApi(ctx, run));
    const conversationChanged = latestChangeSender<ConversationRow, ApiConversation>((conversation) => conversationToApi(ctx, conversation));
    const unsubscribes = [
      ctx.bus.on('attempt_event', (event) => send({ type: 'attempt_event', event })),
      ctx.bus.on('attempt_changed', (run) => {
        if (isTaskAttempt(run)) {
          ctx.fireAndForget(() => attemptChanged.send(run.id, run, (api) => send({ type: 'attempt_changed', run: api })), { op: 'ws.attemptChanged', level: 'debug', context: { attemptId: run.id } });
        } else if (run.workspaceId !== null && run.epicRef !== null) {
          send({ type: 'epic_changed', workspaceId: run.workspaceId, epicRef: run.epicRef });
        }
      }),
      ctx.bus.on('step_changed', ({ taskId, attemptId }) => send({ type: 'step_run_changed', taskId, attemptId: attemptId ?? null })),
      ctx.bus.on('attempt_usage', ({ attemptId, snapshot }) => {
        ctx.fireAndForget(async () => send({ type: 'attempt_usage', attemptId, ...(await attemptUsageToApi(ctx, attemptId, snapshot)) }), { op: 'ws.attemptUsage', level: 'debug', context: { attemptId } });
      }),
      ctx.bus.on('task_changed', (task) => ctx.fireAndForget(() => taskChanged.send(task.id, task, (api) => send({ type: 'task_changed', task: api })), { op: 'ws.taskChanged', level: 'debug', context: { taskId: task.id } })),
      ctx.bus.on('task_removed', ({ id }) => {
        taskChanged.markRemoved(id);
        send({ type: 'task_removed', id });
      }),
      ctx.bus.on('epic_changed', (payload) => send({ type: 'epic_changed', ...payload })),
      ctx.bus.on('agent_messages_changed', (payload) => send({ type: 'agent_messages_changed', ...payload })),
      ctx.bus.on('epic_integrated', (payload) => send({ type: 'epic_integrated', ...payload })),
      ctx.bus.on('scheduled_jobs', (jobs) => send({ type: 'scheduled-jobs', jobs: scheduledJobsToApi(jobs) })),
      ctx.bus.on('operations', (event) => send({ type: 'operations', event: operationEventToApi(event) })),
      ctx.bus.on('worktrees', (worktrees) => send({ type: 'worktrees', worktrees: worktreesToApi(worktrees) })),
      ctx.bus.on('host_load', (load) => send({ type: 'host_load', load })),
      ctx.bus.on('export_failed', (payload) => send({ type: 'export_failed', ...payload })),
      ctx.bus.on('notification_created', (row) => send({ type: 'notification_created', notification: notificationToApi(row) })),
      ctx.bus.on('notifications_read', ({ ids }) => send({ type: 'notifications_read', ids })),
      ctx.bus.on('fs_changed', (payload) => send({ type: 'fs_changed', ...payload })),
      ctx.bus.on('git_status', (payload) => send({ type: 'git_status', ...payload })),
    ];
    send({ type: 'host_load', load: ctx.hostLoad.current() });
    let awaitingPong = false;
    socket.on('pong', () => {
      awaitingPong = false;
    });
    if (hasWriteScope) {
      unsubscribes.push(
        ctx.bus.on('conversation_event', (event) => send({ type: 'conversation_event', event })),
        ctx.bus.on('conversation_changed', (conversation) => {
          ctx.fireAndForget(
            () => conversationChanged.send(conversation.id, conversation, (api) => send({ type: 'conversation_changed', conversation: api })),
            { op: 'ws.sendConversationChanged', level: 'warn', context: { conversationId: conversation.id } },
          );
        }),
        ctx.bus.on('conversation_commands', (payload) => send({ type: 'conversation_commands', ...payload })),
        ctx.bus.on('permission_request', (pending) => send({ type: 'permission_request', ...pending })),
        ctx.bus.on('elicitation_request', (pending) => send({ type: 'elicitation_request', ...pending })),
      );
      for (const pending of ctx.conversationDriver.listPendingPermissions()) {
        send({ type: 'permission_request', ...pending });
      }
      for (const pending of ctx.conversationDriver.listPendingElicitations()) {
        send({ type: 'elicitation_request', ...pending });
      }
    }
    socket.on('message', async (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      const filesMessage = filesSubscriptionSchema.safeParse(message);
      if (filesMessage.success) {
        const { type, workspaceId } = filesMessage.data;
        if (type === 'subscribe_files') {
          if (!fileSubscriptions.has(workspaceId)) fileSubscriptions.set(workspaceId, ctx.workspaceWatcher.subscribe(workspaceId));
        } else {
          fileSubscriptions.get(workspaceId)?.();
          fileSubscriptions.delete(workspaceId);
        }
        return;
      }
      const sub = logSubscription(message);
      if (!sub) return;
      unsubscribeAttemptLog?.();
      const queued: Array<ReturnType<typeof ctx.bus.replayAttemptLog> extends IterableIterator<infer Event> ? Event : never> = [];
      let replaying = true;
      unsubscribeAttemptLog = ctx.bus.on('attempt_log_event', (event) => {
        if (event.attemptId !== sub.attemptId || event.seq <= sub.after) return;
        if (replaying) queued.push(event);
        else send({ type: 'attempt_log_event', event });
      });
      if (sub.replay !== false) {
        await forEachYielding(ctx.bus.replayAttemptLog({ attemptId: sub.attemptId, after: sub.after }), (event) => {
          send({ type: 'attempt_log_event', event });
        });
      }
      while (queued.length > 0) {
        await forEachYielding(queued.splice(0), (event) => send({ type: 'attempt_log_event', event }));
      }
      replaying = false;
    });
    // Browsers cannot observe protocol pings, so each tick also sends a `heartbeat` message clients can time out on.
    const heartbeat = setInterval(() => {
      if (awaitingPong) {
        socket.terminate();
        return;
      }
      awaitingPong = true;
      socket.ping();
      send({ type: 'heartbeat', intervalMs: WS_HEARTBEAT_INTERVAL_MS, ts: Date.now() });
    }, WS_HEARTBEAT_INTERVAL_MS);
    socket.on('close', () => {
      clearInterval(heartbeat);
      unsubscribeAttemptLog?.();
      for (const release of fileSubscriptions.values()) release();
      fileSubscriptions.clear();
      unsubscribes.forEach((u) => u());
    });
  });
}

function logSubscription(message: unknown): { attemptId: number; after: number; replay?: boolean } | null {
  if (typeof message !== 'object' || message === null) return null;
  const type = Reflect.get(message, 'type');
  const attemptId = Reflect.get(message, 'attemptId');
  const after = Reflect.get(message, 'after');
  const replay = Reflect.get(message, 'replay');
  if (type !== 'attempt_log_subscribe') return null;
  if (typeof attemptId !== 'number' || !Number.isInteger(attemptId)) return null;
  if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) return null;
  if (replay !== undefined && typeof replay !== 'boolean') return null;
  return { attemptId, after, ...(replay === undefined ? {} : { replay }) };
}
