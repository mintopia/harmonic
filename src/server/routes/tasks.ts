import type { FastifyInstance } from 'fastify';
import type { App } from '../app.js';
import { createTaskInputSchema, updateTaskInputSchema } from '../../domain/tasks.js';

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

  fastify.post('/tasks/:id/cancel', async (req) => ctx.tasks.cancel(idOf(req.params)));
}
