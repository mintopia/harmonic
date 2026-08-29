import type { FastifyInstance } from 'fastify';
import type { App } from './app.js';
import { attemptTimelineToApi, conversationToApi, flaggedWorktreesToApi, operationEventToApi, attemptToApi, attemptUsageToApi, scheduledJobsToApi, taskToApi } from './serialize.js';
import { forEachYielding } from '../reliability/yield.js';

/**
 * One firehose socket at /api/ws. Every run event, run state change, and
 * task state change is broadcast to every client; clients filter. Fine at
 * single-operator scale, and it keeps replay and live view on one format.
 */
export async function wsRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as unknown as App;

  fastify.get('/ws', { websocket: true }, async (socket, req) => {
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const sendAttemptTimeline = (taskId: number) => {
      void attemptTimelineToApi(ctx, taskId)
        .then(({ attempts, budgetBase }) => send({ type: 'attempt_timeline_changed', taskId, attempts, budgetBase }))
        .catch(() => {});
    };
    // A read-scoped key (issue #35) gets a filtered firehose: the board's
    // task/run/run-event traffic only, with Conversation and permission
    // events dropped. Auth already passed in the onRequest hook; this just
    // re-reads the key's scope from the same `?token=`.
    const token = (req.query as Record<string, string | undefined>)?.token;
    const readOnly = (token ? await ctx.auth.verifyKey(token) : null)?.scope === 'read';
    let unsubscribeAttemptLog: (() => void) | undefined;
    const unsubscribes = [
      ctx.bus.on('attempt_event', (event) => send({ type: 'attempt_event', event })),
      ctx.bus.on('attempt_changed', (run) => {
        send({ type: 'attempt_changed', run: attemptToApi(ctx, run) });
        sendAttemptTimeline(run.taskId);
      }),
      // Live Run usage (ADR 0010) is board/viz traffic — sent to read keys too;
      // the Conversation's usage rides conversation_changed, already dropped below.
      ctx.bus.on('attempt_usage', ({ attemptId, snapshot }) =>
        send({ type: 'attempt_usage', attemptId, ...attemptUsageToApi(ctx, snapshot) })),
      // Enrich to the API task shape, same as the REST routes — the SPA
      // merges these payloads straight into its task list (issue 15).
      ctx.bus.on('task_changed', async (task) =>
        send({ type: 'task_changed', task: await taskToApi(ctx, await ctx.tasks.withDeps(task)) })),
      // A Task was hard-deleted (issue #162); the SPA drops it straight from
      // its task list, same board traffic as task_changed above.
      ctx.bus.on('task_removed', ({ id }) => send({ type: 'task_removed', id })),
      ctx.bus.on('scheduled_jobs', (jobs) => send({ type: 'scheduled-jobs', jobs: scheduledJobsToApi(jobs) })),
      ctx.bus.on('operations', (event) => send({ type: 'operations', event: operationEventToApi(event) })),
      ctx.bus.on('flagged_worktrees', (flags) => send({ type: 'flagged-worktrees', flags: flaggedWorktreesToApi(flags) })),
    ];
    if (!readOnly) {
      unsubscribes.push(
        // Conversation events stream in the same run_events shape, so the SPA
        // renders them with the shared EventStream (ADR-0006).
        ctx.bus.on('conversation_event', (event) => send({ type: 'conversation_event', event })),
        ctx.bus.on('conversation_changed', (conversation) => {
          void conversationToApi(ctx, conversation)
            .then((c) => send({ type: 'conversation_changed', conversation: c }))
            .catch(() => {});
        }),
        // A Harness is blocked on the operator's permission decision (ADR-0007);
        // answered via POST /conversations/:id/permissions/:reqId.
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
      if (!isAttemptLogSubscription(message)) return;
      unsubscribeAttemptLog?.();
      const queued: Array<ReturnType<typeof ctx.bus.replayAttemptLog> extends IterableIterator<infer Event> ? Event : never> = [];
      let replaying = true;
      unsubscribeAttemptLog = ctx.bus.on('attempt_log_event', (event) => {
        if (event.attemptId !== message.attemptId || event.seq <= message.after) return;
        if (replaying) queued.push(event);
        else send({ type: 'attempt_log_event', event });
      });
      if (message.replay !== false) {
        await forEachYielding(ctx.bus.replayAttemptLog({ attemptId: message.attemptId, after: message.after }), (event) => {
          send({ type: 'attempt_log_event', event });
        });
      }
      while (queued.length > 0) {
        await forEachYielding(queued.splice(0), (event) => send({ type: 'attempt_log_event', event }));
      }
      replaying = false;
    });
    socket.on('close', () => {
      unsubscribeAttemptLog?.();
      unsubscribes.forEach((u) => u());
    });
  });
}

function isAttemptLogSubscription(message: unknown): message is { type: 'attempt_log_subscribe'; attemptId: number; after: number; replay?: boolean } {
  if (typeof message !== 'object' || message === null) return false;
  const type = Reflect.get(message, 'type');
  const attemptId = Reflect.get(message, 'attemptId');
  const after = Reflect.get(message, 'after');
  const replay = Reflect.get(message, 'replay');
  return type === 'attempt_log_subscribe' && typeof attemptId === 'number' && Number.isInteger(attemptId) && typeof after === 'number' && Number.isInteger(after) && after >= 0 && (replay === undefined || typeof replay === 'boolean');
}
