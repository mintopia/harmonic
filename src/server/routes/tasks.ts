import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { createTaskInputSchema, updateTaskInputSchema } from '../../domain/tasks.js';
import { serializeRun } from '../../domain/runs.js';

const requeueInputSchema = z.object({ feedback: z.string().optional() }).nullish();

const idOf = (params: unknown): number => {
  const id = Number((params as { id: string }).id);
  return Number.isInteger(id) ? id : -1;
};

export async function taskRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;

  fastify.post('/tasks', async (req, reply) => {
    const task = ctx.tasks.create(createTaskInputSchema.parse(req.body));
    return reply.status(201).send(task);
  });

  fastify.get('/tasks', async () => ({ tasks: ctx.tasks.list() }));

  fastify.get('/tasks/:id', async (req) => ctx.tasks.get(idOf(req.params)));

  fastify.patch('/tasks/:id', async (req) =>
    ctx.tasks.update(idOf(req.params), updateTaskInputSchema.parse(req.body)),
  );

  fastify.post('/tasks/:id/ready', async (req) => ctx.tasks.promote(idOf(req.params)));

  fastify.post('/tasks/:id/cancel', async (req) => {
    const task = ctx.tasks.cancel(idOf(req.params));
    ctx.runner.cancelForTask(task.id);
    return task;
  });

  fastify.post('/tasks/:id/requeue', async (req) => {
    const body = requeueInputSchema.parse(req.body ?? null);
    return ctx.tasks.requeue(idOf(req.params), body?.feedback);
  });

  fastify.post('/tasks/:id/run', async (req, reply) => {
    const run = ctx.runner.start(idOf(req.params));
    return reply.status(201).send(serializeRun(run));
  });

  fastify.get('/tasks/:id/runs', async (req) => {
    ctx.tasks.get(idOf(req.params));
    return { runs: ctx.runs.listForTask(idOf(req.params)).map(serializeRun) };
  });

  fastify.get('/runs/:id', async (req) => serializeRun(ctx.runs.get(idOf(req.params))));

  fastify.get('/runs/:id/events', async (req) => ({ events: ctx.runs.listEvents(idOf(req.params)) }));
}
