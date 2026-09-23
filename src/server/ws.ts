import type { FastifyInstance } from 'fastify';
import type { AppContext } from './app.js';
import { requestIsOperator } from './auth.js';
import { attemptTimelineToApi, conversationToApi, attemptToApi, attemptUsageToApi, taskToApi } from './serialize.js';
import { operationEventToApi, scheduledJobsToApi, worktreesToApi, type ApiAttemptSummary, type ApiConversation, type ApiTask } from './dto.js';
import { forEachYielding } from '../reliability/yield.js';
import { isTaskAttempt, type AttemptRow, type ConversationRow, type TaskRow } from '../db/schema.js';
import { fireAndForget } from '../error-handling.js';

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

/** One firehose socket at /api/ws: every event is broadcast to every client; clients filter. */
export async function wsRoutes(fastify: FastifyInstance, ctx: AppContext): Promise<void> {

  fastify.get('/ws', { websocket: true }, async (socket, req) => {
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const sendAttemptTimeline = (taskId: number) => {
      fireAndForget(
        async () => {
          const { attempts, budgetBase } = await attemptTimelineToApi(ctx, taskId);
          send({ type: 'attempt_timeline_changed', taskId, attempts, budgetBase });
        },
        { op: 'ws.sendAttemptTimeline', level: 'warn', context: { taskId } },
      );
    };
    // ws echoes back the client's first offered subprotocol, so this is the token the client authenticated the upgrade with.
    const hasWriteScope = await requestIsOperator(req, ctx.auth, socket.protocol || undefined);
    let unsubscribeAttemptLog: (() => void) | undefined;
    let unsubscribeCriticLog: (() => void) | undefined;
    const taskChanged = latestChangeSender<TaskRow, ApiTask>((task) => ctx.tasks.withDeps(task).then((withDeps) => taskToApi(ctx, withDeps)));
    const attemptChanged = latestChangeSender<AttemptRow, ApiAttemptSummary>((run) => attemptToApi(ctx, run));
    const conversationChanged = latestChangeSender<ConversationRow, ApiConversation>((conversation) => conversationToApi(ctx, conversation));
    const unsubscribes = [
      ctx.bus.on('attempt_event', (event) => send({ type: 'attempt_event', event })),
      ctx.bus.on('attempt_changed', (run) => {
        if (isTaskAttempt(run)) {
          void attemptChanged.send(run.id, run, (api) => send({ type: 'attempt_changed', run: api }));
          sendAttemptTimeline(run.taskId);
        } else if (run.workspaceId !== null && run.epicRef !== null) {
          send({ type: 'epic_changed', workspaceId: run.workspaceId, epicRef: run.epicRef });
        }
      }),
      ctx.bus.on('step_changed', ({ taskId }) => sendAttemptTimeline(taskId)),
      ctx.bus.on('attempt_usage', ({ attemptId, snapshot }) => {
        void attemptUsageToApi(ctx, attemptId, snapshot).then((usage) => send({ type: 'attempt_usage', attemptId, ...usage }));
      }),
      ctx.bus.on('task_changed', (task) => void taskChanged.send(task.id, task, (api) => send({ type: 'task_changed', task: api }))),
      ctx.bus.on('task_removed', ({ id }) => {
        taskChanged.markRemoved(id);
        send({ type: 'task_removed', id });
      }),
      ctx.bus.on('epic_changed', (payload) => send({ type: 'epic_changed', ...payload })),
      ctx.bus.on('epic_integrated', (payload) => send({ type: 'epic_integrated', ...payload })),
      ctx.bus.on('scheduled_jobs', (jobs) => send({ type: 'scheduled-jobs', jobs: scheduledJobsToApi(jobs) })),
      ctx.bus.on('operations', (event) => send({ type: 'operations', event: operationEventToApi(event) })),
      ctx.bus.on('worktrees', (worktrees) => send({ type: 'worktrees', worktrees: worktreesToApi(worktrees) })),
      ctx.bus.on('host_load', (load) => send({ type: 'host_load', load })),
      ctx.bus.on('fs_changed', (payload) => send({ type: 'fs_changed', ...payload })),
      ctx.bus.on('git_status', (payload) => send({ type: 'git_status', ...payload })),
    ];
    send({ type: 'host_load', load: ctx.hostLoad.current() });
    if (hasWriteScope) {
      unsubscribes.push(
        ctx.bus.on('conversation_event', (event) => send({ type: 'conversation_event', event })),
        ctx.bus.on('conversation_changed', (conversation) => {
          fireAndForget(
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
      const sub = logSubscription(message);
      if (!sub) return;
      const channel = sub.type === 'critic_log_subscribe' ? 'critic_log_event' : 'attempt_log_event';
      const replaySource = channel === 'critic_log_event' ? ctx.bus.replayCriticLog.bind(ctx.bus) : ctx.bus.replayAttemptLog.bind(ctx.bus);
      if (channel === 'critic_log_event') unsubscribeCriticLog?.();
      else unsubscribeAttemptLog?.();
      const queued: Array<ReturnType<typeof ctx.bus.replayAttemptLog> extends IterableIterator<infer Event> ? Event : never> = [];
      let replaying = true;
      const unsubscribe = ctx.bus.on(channel, (event) => {
        if (event.attemptId !== sub.attemptId || event.seq <= sub.after) return;
        if (replaying) queued.push(event);
        else send({ type: channel, event });
      });
      if (channel === 'critic_log_event') unsubscribeCriticLog = unsubscribe;
      else unsubscribeAttemptLog = unsubscribe;
      if (sub.replay !== false) {
        await forEachYielding(replaySource({ attemptId: sub.attemptId, after: sub.after }), (event) => {
          send({ type: channel, event });
        });
      }
      while (queued.length > 0) {
        await forEachYielding(queued.splice(0), (event) => send({ type: channel, event }));
      }
      replaying = false;
    });
    socket.on('close', () => {
      unsubscribeAttemptLog?.();
      unsubscribeCriticLog?.();
      unsubscribes.forEach((u) => u());
    });
  });
}

/** The builder's transient ACP transcript and the critic's own live channel
 * share one subscription shape; the `type` selects the bus channel. */
function logSubscription(message: unknown): { type: 'attempt_log_subscribe' | 'critic_log_subscribe'; attemptId: number; after: number; replay?: boolean } | null {
  if (typeof message !== 'object' || message === null) return null;
  const type = Reflect.get(message, 'type');
  const attemptId = Reflect.get(message, 'attemptId');
  const after = Reflect.get(message, 'after');
  const replay = Reflect.get(message, 'replay');
  if (type !== 'attempt_log_subscribe' && type !== 'critic_log_subscribe') return null;
  if (typeof attemptId !== 'number' || !Number.isInteger(attemptId)) return null;
  if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) return null;
  if (replay !== undefined && typeof replay !== 'boolean') return null;
  return { type, attemptId, after, ...(replay === undefined ? {} : { replay }) };
}
