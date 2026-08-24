import type { FastifyInstance } from 'fastify';
import type { App } from './app.js';
import { conversationToApi, runToApi, runUsageToApi, taskToApi } from './serialize.js';
import { forEachYielding } from '../reliability/yield.js';

export async function wsRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as unknown as App;

  fastify.get('/ws', { websocket: true }, async (socket, req) => {
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const token = (req.query as Record<string, string | undefined>)?.token;
    const readOnly = (token ? await ctx.auth.verifyKey(token) : null)?.scope === 'read';
    let unsubscribeRunLog: (() => void) | undefined;
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
    socket.on('message', async (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!isRunLogSubscription(message)) return;
      unsubscribeRunLog?.();
      const queued: Array<ReturnType<typeof ctx.bus.replayRunLog> extends IterableIterator<infer Event> ? Event : never> = [];
      let replaying = true;
      unsubscribeRunLog = ctx.bus.on('run_log_event', (event) => {
        if (event.runId !== message.runId || event.seq <= message.after) return;
        if (replaying) queued.push(event);
        else send({ type: 'run_log_event', event });
      });
      if (message.replay !== false) {
        await forEachYielding(ctx.bus.replayRunLog({ runId: message.runId, after: message.after }), (event) => {
          send({ type: 'run_log_event', event });
        });
      }
      while (queued.length > 0) {
        await forEachYielding(queued.splice(0), (event) => send({ type: 'run_log_event', event }));
      }
      replaying = false;
    });
    socket.on('close', () => {
      unsubscribeRunLog?.();
      unsubscribes.forEach((u) => u());
    });
  });
}

function isRunLogSubscription(message: unknown): message is { type: 'run_log_subscribe'; runId: number; after: number; replay?: boolean } {
  if (typeof message !== 'object' || message === null) return false;
  const type = Reflect.get(message, 'type');
  const runId = Reflect.get(message, 'runId');
  const after = Reflect.get(message, 'after');
  const replay = Reflect.get(message, 'replay');
  return type === 'run_log_subscribe' && typeof runId === 'number' && Number.isInteger(runId) && typeof after === 'number' && Number.isInteger(after) && after >= 0 && (replay === undefined || typeof replay === 'boolean');
}
