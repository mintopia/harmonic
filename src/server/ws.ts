import type { FastifyInstance } from 'fastify';
import type { AppContext } from './app.js';
import { attemptTimelineToApi, conversationToApi, attemptToApi, attemptUsageToApi, taskToApi } from './serialize.js';
import { flaggedWorktreesToApi, operationEventToApi, scheduledJobsToApi } from './dto.js';
import { forEachYielding } from '../reliability/yield.js';

/** One firehose socket at /api/ws: every event is broadcast to every client; clients filter. */
export async function wsRoutes(fastify: FastifyInstance, ctx: AppContext): Promise<void> {

  fastify.get('/ws', { websocket: true }, async (socket, req) => {
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const sendAttemptTimeline = (taskId: number) => {
      void attemptTimelineToApi(ctx, taskId)
        .then(({ attempts, budgetBase }) => send({ type: 'attempt_timeline_changed', taskId, attempts, budgetBase }))
        .catch(() => {});
    };
    const token = (req.query as Record<string, string | undefined>)?.token;
    const readOnly = (token ? await ctx.auth.verifyKey(token) : null)?.scope === 'read';
    let unsubscribeAttemptLog: (() => void) | undefined;
    let unsubscribeCriticLog: (() => void) | undefined;
    const unsubscribes = [
      ctx.bus.on('attempt_event', (event) => send({ type: 'attempt_event', event })),
      ctx.bus.on('attempt_changed', async (run) => {
        send({ type: 'attempt_changed', run: await attemptToApi(ctx, run) });
        sendAttemptTimeline(run.taskId);
      }),
      ctx.bus.on('step_changed', ({ taskId }) => sendAttemptTimeline(taskId)),
      ctx.bus.on('attempt_usage', ({ attemptId, snapshot }) => {
        void attemptUsageToApi(ctx, attemptId, snapshot).then((usage) => send({ type: 'attempt_usage', attemptId, ...usage }));
      }),
      ctx.bus.on('task_changed', async (task) =>
        send({ type: 'task_changed', task: await taskToApi(ctx, await ctx.tasks.withDeps(task)) })),
      ctx.bus.on('task_removed', ({ id }) => send({ type: 'task_removed', id })),
      ctx.bus.on('scheduled_jobs', (jobs) => send({ type: 'scheduled-jobs', jobs: scheduledJobsToApi(jobs) })),
      ctx.bus.on('operations', (event) => send({ type: 'operations', event: operationEventToApi(event) })),
      ctx.bus.on('flagged_worktrees', (flags) => send({ type: 'flagged-worktrees', flags: flaggedWorktreesToApi(flags) })),
    ];
    if (!readOnly) {
      unsubscribes.push(
        ctx.bus.on('conversation_event', (event) => send({ type: 'conversation_event', event })),
        ctx.bus.on('conversation_changed', (conversation) => {
          void conversationToApi(ctx, conversation)
            .then((c) => send({ type: 'conversation_changed', conversation: c }))
            .catch(() => {});
        }),
        ctx.bus.on('permission_request', (pending) => send({ type: 'permission_request', ...pending })),
      );
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
