import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { createTaskInputSchema, updateTaskInputSchema } from '../../domain/tasks.js';
import { serializeRun } from '../../domain/runs.js';
import { Git } from '../../execution/git.js';

const requeueInputSchema = z.object({ feedback: z.string().optional() }).nullish();
const rejectInputSchema = z.object({ feedback: z.string().optional() }).nullish();
const cancelInputSchema = z.object({ withDependents: z.boolean().optional() }).nullish();

const idOf = (params: unknown): number => {
  const id = Number((params as { id: string }).id);
  return Number.isInteger(id) ? id : -1;
};

export async function taskRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;

  const withDeps = (task: { id: number }) => ctx.tasks.withDeps(ctx.tasks.get(task.id));

  fastify.post('/tasks', async (req, reply) => {
    const task = ctx.tasks.create(createTaskInputSchema.parse(req.body));
    return reply.status(201).send(withDeps(task));
  });

  fastify.get('/tasks', async () => ({ tasks: ctx.tasks.listWithDeps() }));

  fastify.get('/tasks/:id', async (req) => ctx.tasks.withDeps(ctx.tasks.get(idOf(req.params))));

  fastify.patch('/tasks/:id', async (req) =>
    withDeps(ctx.tasks.update(idOf(req.params), updateTaskInputSchema.parse(req.body))),
  );

  fastify.post('/tasks/:id/ready', async (req) => withDeps(ctx.tasks.promote(idOf(req.params))));

  fastify.post('/tasks/:id/cancel', async (req) => {
    const body = cancelInputSchema.parse(req.body ?? null);
    const id = idOf(req.params);
    if (body?.withDependents) {
      const cancelled = ctx.tasks.cancelWithDependents(id);
      cancelled.forEach((taskId) => ctx.runner.cancelForTask(taskId));
      return withDeps({ id });
    }
    const task = ctx.tasks.cancel(id);
    ctx.runner.cancelForTask(task.id);
    return withDeps(task);
  });

  fastify.post('/tasks/:id/requeue', async (req) => {
    const body = requeueInputSchema.parse(req.body ?? null);
    return withDeps(ctx.tasks.requeue(idOf(req.params), body?.feedback));
  });

  fastify.post('/tasks/:id/dependencies', async (req) => {
    const body = z.object({ dependsOnId: z.number().int().positive() }).parse(req.body);
    return ctx.tasks.addDependency(idOf(req.params), body.dependsOnId);
  });

  fastify.delete('/tasks/:id/dependencies/:depId', async (req) => {
    const depId = Number((req.params as { depId: string }).depId);
    return ctx.tasks.removeDependency(idOf(req.params), depId);
  });

  fastify.post('/tasks/:id/accept', async (req) => withDeps(await ctx.review.accept(idOf(req.params))));

  fastify.post('/tasks/:id/reject', async (req) => {
    const body = rejectInputSchema.parse(req.body ?? null);
    return withDeps(ctx.review.reject(idOf(req.params), body?.feedback));
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

  // Branch + diffstat for the review inbox (worktree runs only).
  fastify.get('/runs/:id/diff', async (req) => {
    const run = ctx.runs.get(idOf(req.params));
    if (!run.branch || !run.baseBranch) return { branch: null, baseBranch: null, stat: null };
    const task = ctx.tasks.get(run.taskId);
    const stat = await Git.diffStat(task.workingDir, run.baseBranch, run.branch);
    return { branch: run.branch, baseBranch: run.baseBranch, stat };
  });
}
