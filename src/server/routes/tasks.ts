import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { createTaskInputSchema, updateTaskInputSchema, taskListQuerySchema } from '../../domain/tasks.js';
import { TASK_STATES, RUN_STATES, TASK_ORIGINS, WORKFLOWS, WAYFINDER_TYPES, DRIVES } from '../../db/schema.js';
import { RUN_PHASES } from '../../domain/run-phases.js';
import { Git } from '../../execution/git.js';
import { DomainError } from '../../domain/errors.js';
import { mergeUsage, type RunUsage } from '../../execution/usage.js';
import { atRestWorkspaceId, costOfRuns, runToApi, taskToApi } from '../serialize.js';
import { errorResponse, idParamsSchema, costSchema, runUsageSchema, okResponseSchema } from '../schemas.js';

/** The reviewer's note, carried onto the re-attempt or back to the queue. */
const feedbackExample = 'The limiter is per-process; it needs to be shared across workers.';
const requeueInputSchema = z.object({ feedback: z.string().optional().meta({ example: feedbackExample }) }).nullish();
const reattemptInputSchema = z
  .object({ feedback: z.string().optional().meta({ example: feedbackExample }) })
  .nullish();
const rejectInputSchema = z.object({ feedback: z.string().optional().meta({ example: feedbackExample }) }).nullish();
const cancelInputSchema = z.object({ withDependents: z.boolean().optional().meta({ example: true }) }).nullish();
const dependsOnBodySchema = z.object({ dependsOnId: z.number().int().positive().meta({ example: 4818 }) });
const steerInputSchema = z.object({
  text: z.string().min(1).meta({ example: 'Stop — check the existing tests before changing the limiter.' }),
});
const depParamsSchema = z.object({
  id: z.coerce.number().int().meta({ example: 4821 }),
  depId: z.coerce.number().int().meta({ example: 4818 }),
});

/** A task plus its dependency context (`TaskService.withDeps`) — no Cost, since not every caller derives it. */
const taskWithDepsSchema = z
  .object({
    id: z.number().meta({ example: 4821 }),
    prompt: z.string().meta({ example: 'Add rate limiting to POST /api/tasks' }),
    /** The owning Workspace (ADR-0008). */
    workspaceId: z.number().meta({ example: 1 }),
    /** One of config.ts's HARNESS_IDS ('claude' | 'codex' | 'copilot'); stored as plain text. */
    harness: z.string().meta({ example: 'claude' }),
    model: z.string().meta({ example: 'sonnet-5' }),
    workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
    /** 'direct' | 'worktree' (config.ts ISOLATION_MODES); stored as plain text. */
    isolationMode: z.string().meta({ example: 'worktree' }),
    /** 'high' | 'normal' | 'low' (config.ts PRIORITIES); stored as plain text. */
    priority: z.string().meta({ example: 'normal' }),
    state: z.enum(TASK_STATES).meta({ example: 'awaiting-review' }),
    /** The original this task re-attempts, or null; feedback carries the reviewer's notes in full. */
    reattemptOf: z.number().nullable().meta({ example: null }),
    feedback: z.string().nullable().meta({ example: null }),
    // --- Tracker mirroring (issue #30). native Tasks carry origin + nulls/false. ---
    /** 'native' (authored here) | 'mirrored' (1:1 tracker projection). */
    origin: z.enum(TASK_ORIGINS).meta({ example: 'native' }),
    /** The mirrored issue's number; null on native Tasks. */
    trackerRef: z.number().nullable().meta({ example: null }),
    /** 'wayfinder' | 'implement'; null on native Tasks. */
    workflow: z.enum(WORKFLOWS).nullable().meta({ example: null }),
    /** 'research'|'prototype'|'grilling'|'task'; null for implement and native. */
    wayfinderType: z.enum(WAYFINDER_TYPES).nullable().meta({ example: null }),
    /** 'afk' | 'hitl'; null on native Tasks. */
    drive: z.enum(DRIVES).nullable().meta({ example: null }),
    /** An afk Run escalated to a human. */
    escalated: z.boolean().meta({ example: false }),
    /** The parent Map issue's number (query-time Map rollup); null off-Map or native. */
    mapRef: z.number().nullable().meta({ example: null }),
    createdAt: z.number().meta({ example: 1784030400000 }),
    updatedAt: z.number().meta({ example: 1784032260000 }),
    dependsOn: z.array(z.number()).meta({ example: [4818] }),
    dependents: z.array(z.number()).meta({ example: [4830] }),
    /** blocked, and at least one dependency is failed or cancelled. */
    blockedOnFailed: z.boolean().meta({ example: false }),
    /** Task ids that re-attempt this one (reverse of reattemptOf). */
    reattempts: z.array(z.number()).meta({ example: [] }),
    /** The four Task-default overrides as stored (ADR-0012): `null` ⇒ this field
     * *inherits* (Workspace override → global default), so the sibling
     * harness/model/isolationMode/priority above are the resolved effective
     * values while these say whether each was pinned. The editor reads both. */
    overrides: z
      .object({
        harness: z.string().nullable().meta({ example: null }),
        model: z.string().nullable().meta({ example: 'opus-4.8' }),
        isolationMode: z.string().nullable().meta({ example: null }),
        priority: z.string().nullable().meta({ example: null }),
      })
      .meta({ example: { harness: null, model: 'opus-4.8', isolationMode: null, priority: null } }),
  })
  .meta({ id: 'TaskWithDeps' });

/** The task shape the REST API and WebSocket both serve (serialize.ts `ApiTask`) — `TaskWithDeps` plus Cost and the tracker url. */
const taskSchema = taskWithDepsSchema
  .extend({
    cost: costSchema.nullable(),
    /** The mirrored issue's tracker URL (from the last poll); null on native Tasks or before a poll. */
    url: z.string().nullable().meta({ example: 'https://github.com/mintopia/harmonic/issues/35' }),
    /** The parent Map's title (resolved from mapRef, last poll); null when unmapped or before a poll. */
    mapTitle: z.string().nullable().meta({ example: 'Wayfinder' }),
    /** The latest run's branch (worktree mode only); null in direct mode or before any run. */
    branch: z.string().nullable().meta({ example: 'agent/4821-rate-limiting' }),
    /** The latest run's diffstat, snapshotted at settle; null until awaiting-review or in direct mode. */
    stat: z.string().nullable().meta({ example: ' src/server/rate-limit.ts | 96 ++++++++++++++\n 1 file changed, 96 insertions(+)' }),
    /** The running run's `startedAt`; null unless the Task is running (issue #100). */
    runStartedAt: z.number().nullable().meta({ example: 1784032020000 }),
    /** Total tool-call count of the running run; null unless the Task is running (issue #100). */
    toolCount: z.number().nullable().meta({ example: 12 }),
    /** The running run's id, so the board can match the run_usage firehose to this card; null unless running (issue #100). */
    runId: z.number().nullable().meta({ example: 41 }),
  })
  .meta({ id: 'Task' });

const tasksListResponseSchema = z.object({ tasks: z.array(taskSchema) });

/** A run as the REST API and WebSocket both serve it (serialize.ts `ApiRun`). */
const runSchema = z
  .object({
    id: z.number().meta({ example: 9137 }),
    taskId: z.number().meta({ example: 4821 }),
    attempt: z.number().meta({ example: 1 }),
    state: z.enum(RUN_STATES).meta({ example: 'completed' }),
    /** The Run's position in the phase machine (issue #114): executing →
     * validating → verifying → [review] → landing → terminal. Null on
     * pre-feature Runs. A native Run is `state:'running'`, `phase:'review'`
     * while parked at the human gate. */
    phase: z.enum(RUN_PHASES).nullable().meta({ example: 'review' }),
    /** Review-SLA deadline (epoch ms) while parked in `review`; null otherwise. */
    reviewDeadline: z.number().nullable().meta({ example: null }),
    /** Failure reason: 'interrupted', an error message, or null. */
    reason: z.string().nullable().meta({ example: null }),
    /** ACP stopReason from the session/prompt result. */
    stopReason: z.string().nullable().meta({ example: 'end_turn' }),
    sessionId: z.string().nullable().meta({ example: 'a3f2c1d0-8b4e-4c1a-9f7d-2e6b5a0c3d91' }),
    /** The exact prompt text sent to the harness for this Run; null for
     * pre-feature Runs and until the prompt turn is sent. */
    prompt: z.string().nullable().meta({ example: 'Fix the rate-limiting bug in src/api.ts' }),
    /** Worktree mode: the run's branch and the branch it was cut from. */
    branch: z.string().nullable().meta({ example: 'agent/4821-rate-limiting' }),
    baseBranch: z.string().nullable().meta({ example: 'main' }),
    /** The frozen verification candidate (issue #134): the `commit-tree` OID
     * captured in `validating` and the private Harmonic ref it is pinned to,
     * built without moving the target branch. Null when no candidate was
     * produced (pre-feature, escalated before `validating`, or a dirty
     * direct-mode context). */
    candidateOid: z.string().nullable().meta({ example: '0f758cd2200565e7605902a86c2827c65ad25ce0' }),
    candidateRef: z.string().nullable().meta({ example: 'refs/harmonic/candidate/run-9137' }),
    usage: runUsageSchema.nullable(),
    /** 'accepted' | 'rejected' | null (domain/review.ts); stored as plain text. */
    review: z.string().nullable().meta({ example: null }),
    reviewFeedback: z.string().nullable().meta({ example: null }),
    reviewedAt: z.number().nullable().meta({ example: null }),
    startedAt: z.number().meta({ example: 1784032020000 }),
    finishedAt: z.number().nullable().meta({ example: 1784032260000 }),
    cost: costSchema.nullable(),
  })
  .meta({ id: 'Run' });

const runsListResponseSchema = z.object({ runs: z.array(runSchema) });

const runEventSchema = z.object({
  id: z.number().meta({ example: 55210 }),
  runId: z.number().meta({ example: 9137 }),
  seq: z.number().meta({ example: 42 }),
  ts: z.number().meta({ example: 1784032140000 }),
  /** 'session_update' | 'permission_request' | 'lifecycle' */
  type: z.string().meta({ example: 'session_update' }),
  /** For session_update, the ACP `update` object verbatim — shape varies by update kind. */
  payload: z.unknown().meta({
    example: { sessionUpdate: 'tool_call', toolCallId: 'call_7', kind: 'edit', title: 'src/server/rate-limit.ts' },
  }),
});

const eventsListResponseSchema = z.object({ events: z.array(runEventSchema) });

const usageResponseSchema = runUsageSchema.extend({
  cost: costSchema.nullable(),
  /** How many of the task's runs (including failed retries) reported usage. */
  runCount: z.number().meta({ example: 2 }),
});

const diffResponseSchema = z.object({
  branch: z.string().nullable().meta({ example: 'agent/4821-rate-limiting' }),
  baseBranch: z.string().nullable().meta({ example: 'main' }),
  /** `git diff --stat` between baseBranch and branch; null outside worktree mode. */
  stat: z.string().nullable().meta({
    example: ' src/server/rate-limit.ts | 96 ++++++++++++++\n src/server/app.ts       |  8 +-\n 2 files changed, 100 insertions(+), 4 deletions(-)',
  }),
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
        response: {
          201: taskSchema.describe('The created task, in draft.'),
          400: errorResponse('The payload failed validation — see the error message for the offending field.'),
        },
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
        response: { 200: tasksListResponseSchema.describe('Every task matching the filters, in the requested order.') },
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
        response: {
          200: taskSchema.describe('The task, with its dependency context and Cost.'),
          404: errorResponse('No task has that id.'),
        },
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
          'Edit a draft, ready, or blocked task. Each Task-default field (harness, model, isolationMode, priority) accepts null to clear it back to inherit. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        body: updateTaskInputSchema,
        response: {
          200: taskSchema.describe('The updated task.'),
          400: errorResponse('The payload failed validation — see the error message for the offending field.'),
          409: errorResponse('The task is running or finished, so its definition is frozen.'),
        },
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
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not in a state this action can be applied to.'),
        },
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
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not in a state this action can be applied to.'),
        },
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
    '/tasks/:id/complete',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Force a running task to completed (operator override): stop the agent and settle it done, skipping the review gate. Operator only.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not running.'),
        },
      },
    },
    async (req) => {
      const task = ctx.tasks.complete(req.params.id);
      ctx.runner.completeForTask(task.id);
      return withDeps(task);
    },
  );

  app.post(
    '/tasks/:id/steer',
    {
      schema: {
        tags: ['Tasks'],
        description:
          "Steer a running task: send an operator message to its active run. When the harness supports ACP mid-turn steering, the message is injected into the running turn immediately — pre-empting the current generation without cancelling it. Otherwise, or when the agent is parked between turns, the message is queued and delivered as a fresh prompt turn at the next turn boundary. Use it to redirect an agent that has gone off-track, or to nudge one that ended its turn and parked. Operator only.",
        params: idParamsSchema,
        body: steerInputSchema,
        response: {
          200: okResponseSchema.describe('The message was injected into the running turn, or queued for the next turn boundary, of the task\'s active run.'),
          409: errorResponse('The task has no active run to steer (it is not running here).'),
        },
      },
    },
    async (req) => {
      ctx.tasks.get(req.params.id); // 404 on unknown task
      if (!(await ctx.runner.steer(req.params.id, req.body.text))) {
        throw new DomainError('invalid_state', `task ${req.params.id} has no active run to steer`);
      }
      return { ok: true } as const;
    },
  );

  app.post(
    '/tasks/:id/unescalate',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Un-escalate a mirrored Task: clear the escalated flag and flip drive back to afk, handing it back to autonomous drive. The Task keeps its state (usually ready), so the Auto-Runner re-picks it. Operator only.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The Task, no longer escalated and back on afk drive.'),
          409: errorResponse('The Task is native, or is not escalated.'),
        },
      },
    },
    async (req) => withDeps(ctx.tasks.unescalate(req.params.id)),
  );

  app.post(
    '/tasks/:id/requeue',
    {
      schema: {
        tags: ['Tasks'],
        description:
          "Send a failed task back to ready for another attempt, with optional feedback for the retry. Native tasks append it to the prompt; mirrored tasks carry it in the feedback field (their prompt is re-derived from the ticket each poll). Reachable with a run-scoped Run Key.",
        params: idParamsSchema,
        body: requeueInputSchema,
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not in a state this action can be applied to.'),
        },
      },
    },
    async (req) => withDeps(ctx.tasks.requeue(req.params.id, req.body?.feedback)),
  );

  app.post(
    '/tasks/:id/uncancel',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Return a cancelled task to the queue in place: ready, or blocked if it has unmet dependencies. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not cancelled.'),
        },
      },
    },
    async (req) => withDeps(ctx.tasks.uncancel(req.params.id)),
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
        response: {
          201: taskSchema.describe('The new task, carrying the feedback and pointing at the original via reattemptOf.'),
          404: errorResponse('No task has that id.'),
          409: errorResponse('Only a failed or rejected task can be re-attempted.'),
        },
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
        response: {
          200: taskWithDepsSchema.describe('The task with the edge added, and blocked/ready re-derived.'),
          409: errorResponse('The edge is unknown, self-referential, or would close a dependency cycle.'),
        },
      },
    },
    async (req) => {
      const task = ctx.tasks.addDependency(req.params.id, req.body.dependsOnId);
      return { ...task, workspaceId: atRestWorkspaceId(task.workspaceId) };
    },
  );

  app.delete(
    '/tasks/:id/dependencies/:depId',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Remove a dependency edge, re-deriving blocked/ready. Reachable with a run-scoped Run Key.',
        params: depParamsSchema,
        response: { 200: taskWithDepsSchema.describe('The task with the edge removed, and blocked/ready re-derived.') },
      },
    },
    async (req) => {
      const task = ctx.tasks.removeDependency(req.params.id, req.params.depId);
      return { ...task, workspaceId: atRestWorkspaceId(task.workspaceId) };
    },
  );

  app.post(
    '/tasks/:id/accept',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Accept an awaiting-review task, completing it (and merging its branch in worktree mode). Human-only by default; reachable with a run-scoped Run Key only when the agentReview config flag is enabled.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not in a state this action can be applied to.'),
        },
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
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not in a state this action can be applied to.'),
        },
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
        response: { 201: runSchema.describe('The run that just started.') },
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
        response: { 200: runsListResponseSchema.describe("Every run for the task, including failed retries, oldest first.") },
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
        response: {
          200: runSchema.describe('The run, with its Usage and Cost.'),
          404: errorResponse('No run has that id, or it belongs to another task.'),
        },
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
        response: { 200: eventsListResponseSchema.describe('The run\'s persisted events in sequence order.') },
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
        response: { 200: usageResponseSchema.describe('Usage and Cost rolled up across the task\'s runs.') },
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
        response: { 200: diffResponseSchema.describe('The run\'s branch and its diffstat against the base; nulls outside worktree mode.') },
      },
    },
    async (req) => {
      const run = ctx.runs.get(req.params.id);
      if (!run.branch || !run.baseBranch) return { branch: null, baseBranch: null, stat: null };
      // Prefer the settle-time snapshot so this endpoint and the board card can
      // never show two different stats (issue #36); only compute live for a run
      // that predates the snapshot column.
      const task = ctx.tasks.get(run.taskId);
      const stat = run.stat ?? (await Git.diffStat(task.workingDir, run.baseBranch, run.branch));
      return { branch: run.branch, baseBranch: run.baseBranch, stat };
    },
  );
}
