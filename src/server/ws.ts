import type { FastifyInstance } from 'fastify';
import type { App } from './app.js';
import { serializeRun } from '../domain/runs.js';

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
      ctx.bus.on('run_changed', (run) => send({ type: 'run_changed', run: serializeRun(run) })),
      // Enrich to the API task shape, same as the REST routes — the SPA
      // merges these payloads straight into its task list (issue 15).
      ctx.bus.on('task_changed', (task) => send({ type: 'task_changed', task: ctx.tasks.withDeps(task) })),
    ];
    socket.on('close', () => unsubscribes.forEach((u) => u()));
  });
}
