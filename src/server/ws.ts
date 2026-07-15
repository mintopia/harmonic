import type { FastifyInstance } from 'fastify';
import type { App } from './app.js';
import { conversationToApi, runToApi, taskToApi } from './serialize.js';

/**
 * One firehose socket at /api/ws. Every run event, run state change, and
 * task state change is broadcast to every client; clients filter. Fine at
 * single-operator scale, and it keeps replay and live view on one format.
 */
export async function wsRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as unknown as App;

  fastify.get('/ws', { websocket: true }, (socket) => {
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const unsubscribes = [
      ctx.bus.on('run_event', (event) => send({ type: 'run_event', event })),
      ctx.bus.on('run_changed', (run) => send({ type: 'run_changed', run: runToApi(ctx, run) })),
      // Enrich to the API task shape, same as the REST routes — the SPA
      // merges these payloads straight into its task list (issue 15).
      ctx.bus.on('task_changed', (task) =>
        send({ type: 'task_changed', task: taskToApi(ctx, ctx.tasks.withDeps(task)) })),
      // Conversation events stream in the same run_events shape, so the SPA
      // renders them with the shared EventStream (ADR-0006).
      ctx.bus.on('conversation_event', (event) => send({ type: 'conversation_event', event })),
      ctx.bus.on('conversation_changed', (conversation) =>
        send({ type: 'conversation_changed', conversation: conversationToApi(ctx, conversation) })),
      // A Harness is blocked on the operator's permission decision (ADR-0007);
      // answered via POST /conversations/:id/permissions/:reqId.
      ctx.bus.on('permission_request', (pending) => send({ type: 'permission_request', ...pending })),
    ];
    socket.on('close', () => unsubscribes.forEach((u) => u()));
  });
}
