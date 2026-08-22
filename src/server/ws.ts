import type { FastifyInstance } from 'fastify';
import type { App } from './app.js';
import { conversationToApi, runToApi, runUsageToApi, taskToApi } from './serialize.js';

export async function wsRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as unknown as App;

  fastify.get('/ws', { websocket: true }, async (socket, req) => {
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const token = (req.query as Record<string, string | undefined>)?.token;
    const readOnly = (token ? await ctx.auth.verifyKey(token) : null)?.scope === 'read';
    const unsubscribes = [
      ctx.bus.on('run_event', (event) => send({ type: 'run_event', event })),
      ctx.bus.on('run_changed', (run) => send({ type: 'run_changed', run: runToApi(ctx, run) })),
      ctx.bus.on('run_usage', ({ runId, snapshot }) =>
        send({ type: 'run_usage', runId, ...runUsageToApi(ctx, snapshot) })),
      ctx.bus.on('task_changed', async (task) =>
        send({ type: 'task_changed', task: await taskToApi(ctx, await ctx.tasks.withDeps(task)) })),
      ctx.bus.on('task_removed', ({ id }) => send({ type: 'task_removed', id })),
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
    socket.on('close', () => unsubscribes.forEach((u) => u()));
  });
}
