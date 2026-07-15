import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { createTaskInputSchema, updateTaskInputSchema, taskListQuerySchema } from '../../domain/tasks.js';
import { TASK_STATES, RUN_STATES } from '../../db/schema.js';
import { Git } from '../../execution/git.js';
import { mergeUsage, type RunUsage } from '../../execution/usage.js';
import { costOfRuns, runToApi, taskToApi } from '../serialize.js';
import { errorResponseSchema, idParamsSchema, costSchema, runUsageSchema } from '../schemas.js';

const requeueInputSchema = z.object({ feedback: z.string().optional() }).nullish();
const reattemptInputSchema = z.object({ feedback: z.string().optional() }).nullish();
const rejectInputSchema = z.object({ feedback: z.string().optional() }).nullish();
const cancelInputSchema = z.object({ withDependents: z.boolean().optional() }).nullish();
const dependsOnBodySchema = z.object({ dependsOnId: z.number().int().positive() });
const depParamsSchema = z.object({ id: z.coerce.number().int(), depId: z.coerce.number().int() });

/** A task plus its dependency context (`TaskService.withDeps`) — no Cost, since not every caller derives it. */
const taskWithDepsSchema = z
  .object({
    id: z.number(),
    prompt: z.string(),
    /** One of config.ts's HARNESS_IDS ('claude' | 'codex' | 'copilot'); stored as plain text. */
    harness: z.string(),
    model: z.string(),
    workingDir: z.string(),
    /** 'direct' | 'worktree' (config.ts ISOLATION_MODES); stored as plain text. */
    isolationMode: z.string(),
    /** 'high' | 'normal' | 'low' (config.ts PRIORITIES); stored as plain text. */
    priority: z.string(),
    state: z.enum(TASK_STATES),
    /** The original this task re-attempts, or null; feedback carries the reviewer's notes in full. */
    reattemptOf: z.number().nullable(),
    feedback: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    dependsOn: z.array(z.number()),
    dependents: z.array(z.number()),
    /** blocked, and at least one dependency is failed or cancelled. */
    blockedOnFailed: z.boolean(),
    /** Task ids that re-attempt this one (reverse of reattemptOf). */
    reattempts: z.array(z.number()),
  })
  .meta({ id: 'TaskWithDeps' });

/** The task shape the REST API and WebSocket both serve (serialize.ts `ApiTask`) — `TaskWithDeps` plus Cost. */
const taskSchema = taskWithDepsSchema.extend({ cost: costSchema.nullable() }).meta({ id: 'Task' });

const tasksListResponseSchema = z.object({ tasks: z.array(taskSchema) });

/** A run as the REST API and WebSocket both serve it (serialize.ts `ApiRun`). */
const runSchema = z
  .object({
    id: z.number(),
    taskId: z.number(),
    attempt: z.number(),
    state: z.enum(RUN_STATES),
    /** Failure reason: 'interrupted', an error message, or null. */
    reason: z.string().nullable(),
    /** ACP stopReason from the session/prompt result. */
    stopReason: z.string().nullable(),
    sessionId: z.string().nullable(),
    /** Worktree mode: the run's branch and the branch it was cut from. */
    branch: z.string().nullable(),
    baseBranch: z.string().nullable(),
    usage: runUsageSchema.nullable(),
    /** 'accepted' | 'rejected' | null (domain/review.ts); stored as plain text. */
    review: z.string().nullable(),
    reviewFeedback: z.string().nullable(),
    reviewedAt: z.number().nullable(),
    startedAt: z.number(),
    finishedAt: z.number().nullable(),
    cost: costSchema.nullable(),
  })
  .meta({ id: 'Run' });

const runsListResponseSchema = z.object({ runs: z.array(runSchema) });

const runEventSchema = z.object({
  id: z.number(),
  runId: z.number(),
  seq: z.number(),
  ts: z.number(),
  /** 'session_update' | 'permission_request' | 'lifecycle' */
  type: z.string(),
  /** For session_update, the ACP `update` object verbatim — shape varies by update kind. */
  payload: z.unknown(),
});

const eventsListResponseSchema = z.object({ events: z.array(runEventSchema) });

const usageResponseSchema = runUsageSchema.extend({
  cost: costSchema.nullable(),
  /** How many of the task's runs (including failed retries) reported usage. */
  runCount: z.number(),
});

const diffResponseSchema = z.object({
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  /** `git diff --stat` between baseBranch and branch; null outside worktree mode. */
  stat: z.string().nullable(),
});

export async function taskRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const withDeps = (task: { id: number }) =>
    taskToApi(ctx, ctx.tasks.withDeps(ctx.tasks.get(task.id)));

  app.post(
    '/tasks',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Create a task. Reachable with a run-scoped Run Key.',
        body: createTaskInputSchema,
        response: { 201: taskSchema, 400: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const task = ctx.tasks.create(req.body);
      return reply.status(201).send(withDeps(task));
    },
  );

  app.get(
    '/tasks',
    {
      schema: {
        tags: ['Tasks'],
        description: 'List tasks, optionally filtered and sorted. Reachable with a run-scoped Run Key.',
        querystring: taskListQuerySchema,
        response: { 200: tasksListResponseSchema },
      },
    },
    async (req) => {
      const { sortBy, ...query } = req.query;
      // Cost is not a task column — it is derived from runs — so the cost
      // sort happens here, after serialization; unknown cost sorts lowest.
      const tasks = ctx.tasks
        .listWithDeps(sortBy === 'cost' ? query : { ...query, ...(sortBy ? { sortBy } : {}) })
        .map((task) => taskToApi(ctx, task));
      if (sortBy === 'cost') {
        const dir = query.order === 'desc' ? -1 : 1;
        tasks.sort((a, b) => ((a.cost?.totalUsd ?? -1) - (b.cost?.totalUsd ?? -1)) * dir);
      }
      return { tasks };
    },
  );

  app.get(
    '/tasks/:id',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Get one task with its dependency context and Cost. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        response: { 200: taskSchema, 404: errorResponseSchema },
      },
    },
    async (req) => withDeps({ id: req.params.id }),
  );

  app.patch(
    '/tasks/:id',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Edit a draft or ready task. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        body: updateTaskInputSchema,
        response: { 200: taskSchema, 400: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req) => withDeps(ctx.tasks.update(req.params.id, req.body)),
  );

  app.post(
    '/tasks/:id/ready',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Promote a draft to ready (or blocked, if dependencies are unmet). Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        response: { 200: taskSchema, 409: errorResponseSchema },
      },
    },
    async (req) => withDeps(ctx.tasks.promote(req.params.id)),
  );

  app.post(
    '/tasks/:id/cancel',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Cancel a non-terminal task, optionally cascading to its dependents. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        body: cancelInputSchema,
        response: { 200: taskSchema, 409: errorResponseSchema },
      },
    },
    async (req) => {
      const id = req.params.id;
      if (req.body?.withDependents) {
        const cancelled = ctx.tasks.cancelWithDependents(id);
        cancelled.forEach((taskId) => ctx.runner.cancelForTask(taskId));
        return withDeps({ id });
      }
      const task = ctx.tasks.cancel(id);
      ctx.runner.cancelForTask(task.id);
      return withDeps(task);
    },
  );

  app.post(
    '/tasks/:id/requeue',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Send a failed task back to ready for another attempt, optionally appending feedback to its prompt. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        body: requeueInputSchema,
        response: { 200: taskSchema, 409: errorResponseSchema },
      },
    },
    async (req) => withDeps(ctx.tasks.requeue(req.params.id, req.body?.feedback)),
  );

  app.post(
    '/tasks/:id/reattempt',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Create a new task that re-attempts an existing one: a copy of its config and dependencies, linked back via reattemptOf, carrying optional reviewer feedback (composed into the run prompt at run time, so the original prompt stays pristine). The original is left unchanged. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        body: reattemptInputSchema,
        response: { 201: taskSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) =>
      reply.status(201).send(withDeps(ctx.tasks.reattempt(req.params.id, req.body?.feedback))),
  );

  app.post(
    '/tasks/:id/dependencies',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Add a dependency edge, re-deriving blocked/ready. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        body: dependsOnBodySchema,
        response: { 200: taskWithDepsSchema, 409: errorResponseSchema },
      },
    },
    async (req) => ctx.tasks.addDependency(req.params.id, req.body.dependsOnId),
  );

  app.delete(
    '/tasks/:id/dependencies/:depId',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Remove a dependency edge, re-deriving blocked/ready. Reachable with a run-scoped Run Key.',
        params: depParamsSchema,
        response: { 200: taskWithDepsSchema },
      },
    },
    async (req) => ctx.tasks.removeDependency(req.params.id, req.params.depId),
  );

  app.post(
    '/tasks/:id/accept',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Accept an awaiting-review task, completing it (and merging its branch in worktree mode). Human-only by default; reachable with a run-scoped Run Key only when the agentReview config flag is enabled.',
        params: idParamsSchema,
        response: { 200: taskSchema, 409: errorResponseSchema },
      },
    },
    async (req) => withDeps(await ctx.review.accept(req.params.id)),
  );

  app.post(
    '/tasks/:id/reject',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Reject an awaiting-review task with optional feedback, failing it. Human-only by default; reachable with a run-scoped Run Key only when the agentReview config flag is enabled.',
        params: idParamsSchema,
        body: rejectInputSchema,
        response: { 200: taskSchema, 409: errorResponseSchema },
      },
    },
    async (req) => withDeps(ctx.review.reject(req.params.id, req.body?.feedback)),
  );

  app.post(
    '/tasks/:id/run',
    {
      schema: {
        tags: ['Runs'],
        description: 'Start a run for a ready task. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        response: { 201: runSchema },
      },
    },
    async (req, reply) => {
      const run = ctx.runner.start(req.params.id);
      return reply.status(201).send(runToApi(ctx, run));
    },
  );

  app.get(
    '/tasks/:id/runs',
    {
      schema: {
        tags: ['Runs'],
        description: "List a task's runs (retries included). Reachable with a run-scoped Run Key.",
        params: idParamsSchema,
        response: { 200: runsListResponseSchema },
      },
    },
    async (req) => {
      ctx.tasks.get(req.params.id);
      return { runs: ctx.runs.listForTask(req.params.id).map((run) => runToApi(ctx, run)) };
    },
  );

  app.get(
    '/runs/:id',
    {
      schema: {
        tags: ['Runs'],
        description: 'Get one run with its Usage and Cost. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        response: { 200: runSchema, 404: errorResponseSchema },
      },
    },
    async (req) => runToApi(ctx, ctx.runs.get(req.params.id)),
  );

  app.get(
    '/runs/:id/events',
    {
      schema: {
        tags: ['Runs'],
        description: 'Replay a run\'s persisted events, in order — the same records streamed live over the WebSocket. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        response: { 200: eventsListResponseSchema },
      },
    },
    async (req) => ({ events: ctx.runs.listEvents(req.params.id) }),
  );

  app.get(
    '/tasks/:id/usage',
    {
      schema: {
        tags: ['Runs'],
        description:
          "Usage and Cost rolled up across all of a task's runs, retries included. Reachable with a run-scoped Run Key.",
        params: idParamsSchema,
        response: { 200: usageResponseSchema },
      },
    },
    async (req) => {
      ctx.tasks.get(req.params.id);
      const runs = ctx.runs.listForTask(req.params.id);
      const usages = runs
        .map((run) => (run.usage ? (JSON.parse(run.usage) as RunUsage) : null))
        .filter((u): u is RunUsage => u !== null);
      return {
        ...(mergeUsage(usages) ?? { models: {}, totals: null, toolCalls: {}, source: null }),
        cost: costOfRuns(ctx, runs),
        runCount: usages.length,
      };
    },
  );

  app.get(
    '/runs/:id/diff',
    {
      schema: {
        tags: ['Runs'],
        description:
          'Branch and diffstat for the review inbox (worktree-mode runs only; other fields are null). Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        response: { 200: diffResponseSchema },
      },
    },
    async (req) => {
      const run = ctx.runs.get(req.params.id);
      if (!run.branch || !run.baseBranch) return { branch: null, baseBranch: null, stat: null };
      const task = ctx.tasks.get(run.taskId);
      const stat = await Git.diffStat(task.workingDir, run.baseBranch, run.branch);
      return { branch: run.branch, baseBranch: run.baseBranch, stat };
    },
  );
}
