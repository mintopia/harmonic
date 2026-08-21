import type { FastifyInstance } from 'fastify';
import type { App } from './app.js';
import { conversationToApi, runToApi, runUsageToApi, taskToApi } from './serialize.js';

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
    // A read-scoped key (issue #35) gets a filtered firehose: the board's
    // task/run/run-event traffic only, with Conversation and permission
    // events dropped. Auth already passed in the onRequest hook; this just
    // re-reads the key's scope from the same `?token=`.
    const token = (req.query as Record<string, string | undefined>)?.token;
    const readOnly = (token ? await ctx.auth.verifyKey(token) : null)?.scope === 'read';
    const unsubscribes = [
      ctx.bus.on('run_event', (event) => send({ type: 'run_event', event })),
      ctx.bus.on('run_changed', (run) => send({ type: 'run_changed', run: runToApi(ctx, run) })),
      // Live Run usage (ADR 0010) is board/viz traffic — sent to read keys too;
      // the Conversation's usage rides conversation_changed, already dropped below.
      ctx.bus.on('run_usage', ({ runId, snapshot }) =>
        send({ type: 'run_usage', runId, ...runUsageToApi(ctx, snapshot) })),
      // Enrich to the API task shape, same as the REST routes — the SPA
      // merges these payloads straight into its task list (issue 15).
      ctx.bus.on('task_changed', async (task) =>
        send({ type: 'task_changed', task: await taskToApi(ctx, await ctx.tasks.withDeps(task)) })),
      // A Task was hard-deleted (issue #162); the SPA drops it straight from
      // its task list, same board traffic as task_changed above.
      ctx.bus.on('task_removed', ({ id }) => send({ type: 'task_removed', id })),
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
    socket.on('close', () => unsubscribes.forEach((u) => u()));
  });
}
