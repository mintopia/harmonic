import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { createTaskInputSchema, updateTaskInputSchema, taskListQuerySchema, compareListRows } from '../../domain/tasks.js';
import { previewHumanRejectContinuation } from '../../domain/session-continuation.js';
import {
  TASK_STATES,
  MERGE_STATUSES,
  TASK_ORIGINS,
  WORKFLOWS,
  WAYFINDER_TYPES,
  GUARDRAIL_DIMENSIONS,
  GUARDRAIL_CONFIG_SOURCES,
  VERIFICATION_MECHANISMS,
  STEP_TYPES,
} from '../../db/schema.js';
import { DomainError } from '../../domain/errors.js';
import { mergeUsage, type AttemptUsage } from '../../execution/usage.js';
import { readTranscriptLog, withOperatorMessages, type OperatorMessage, type TranscriptLog } from '../../execution/transcript-log.js';
import { adapterFor } from '../../execution/harness/registry.js';
import { attemptTimelineToApi, attemptToApi, taskToApi, tasksToApi, ticketTimelineToApi, verifierStatusesToApi } from '../serialize.js';
import { atRestWorkspaceId, costOfAttempts, epicToListRow } from '../dto.js';
import type { ApiTaskListRow } from '../dto.js';
import { attemptTimelineResponseSchema, errorResponse, idParamsSchema, costSchema, attemptUsageSchema, okResponseSchema, verifierStatusSchema } from '../schemas.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';
import { diffFilesResponseSchema } from './diff.js';
import { attemptDiffFiles, attemptDiffStat } from '../../execution/worktree-diff.js';

/** The operator's guidance on an escalated ticket: becomes the next Attempt's feedback. */
const guidanceExample = 'The limiter is per-process; it needs to be shared across workers.';
const rejectInputSchema = z.object({
  guidance: z.string().trim().min(1).meta({ example: guidanceExample }),
  /** Force-start the next Attempt now, bypassing Auto-Runner capacity; omitted/false requeues to `ready`. */
  start: z.boolean().optional().meta({ example: false }),
});
/** Omitted/false verifies the candidate first; `true` skips verification and merges it as-is. */
const acceptInputSchema = z.object({
  force: z.boolean().optional().meta({ example: false }),
}).nullish();
const cancelInputSchema = z.object({ withDependents: z.boolean().optional().meta({ example: true }) }).nullish();
/** What the continuation rule will do with this Task's live Session; `available: false` when there is nothing to continue. */
const continuationPreviewSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    continueFull: z.object({
      session: z.literal('same'),
      conversation: z.literal('full'),
      estimate: z.object({
        band: z.enum(['warm', 'cold', 'unknown']),
        warm: z.boolean(),
        warmthKnown: z.boolean(),
        estimatedWarmUntil: z.number().nullable(),
        msSinceActive: z.number(),
        msUntilCold: z.number().nullable(),
        note: z.string(),
      }),
    }),
    startCondensed: z.object({
      session: z.literal('new'),
      conversation: z.literal('condensed'),
      estimate: z.object({
        band: z.enum(['warm', 'cold', 'unknown']),
        note: z.string(),
      }),
    }),
  }),
]);
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
    workspaceId: z.number().meta({ example: 1 }),
    /** One of config.ts's HARNESS_IDS; stored as plain text. */
    harness: z.string().meta({ example: 'claude' }),
    model: z.string().meta({ example: 'sonnet-5' }),
    workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
    /** 'direct' | 'worktree' (config.ts ISOLATION_MODES); stored as plain text. */
    isolationMode: z.string().meta({ example: 'worktree' }),
    /** Explicit base branch a worktree Attempt is cut from; null resolves at spawn to the working dir's current branch. */
    baseBranch: z.string().nullable().meta({ example: 'integration/epic-42' }),
    /** 'high' | 'normal' | 'low' (config.ts PRIORITIES); stored as plain text. */
    priority: z.string().meta({ example: 'normal' }),
    conflictResolveTurns: z.number().int().meta({ example: 2 }),
    /** draft → ready → working → done, plus escalated and cancelled. Blocked-ness is derived (`openBlockerCount`), never stored. */
    state: z.enum(TASK_STATES).meta({ example: 'working' }),
    /** Why the ticket is `escalated` — the trigger's recorded reason; null in every other state. */
    escalationReason: z.string().nullable().meta({ example: null }),
    /** Live merge indicator, orthogonal to `state`: 'merging' while the candidate merges onto base, 'resolving-conflicts' once that merge conflicts; null at rest. */
    mergeStatus: z.enum(MERGE_STATUSES).nullable().meta({ example: null }),
    feedback: z.string().nullable().meta({ example: null }),
    /** 'full' resumes the same Session, 'condensed' starts fresh; null before any continuation (⇒ full). */
    continuationChoice: z.enum(['full', 'condensed']).nullable().meta({ example: null }),
    /** 'native' (authored here) | 'mirrored' (1:1 tracker projection). */
    origin: z.enum(TASK_ORIGINS).meta({ example: 'native' }),
    /** The mirrored issue's number; null on native Tasks. */
    trackerRef: z.number().nullable().meta({ example: null }),
    /** 'wayfinder' | 'implement'; null on native Tasks. */
    workflow: z.enum(WORKFLOWS).nullable().meta({ example: null }),
    /** 'research'|'prototype'|'grilling'|'task'; null for implement and native. */
    wayfinderType: z.enum(WAYFINDER_TYPES).nullable().meta({ example: null }),
    /** The parent Map issue's number (query-time Map rollup); null off-Map or native. */
    mapRef: z.number().nullable().meta({ example: null }),
    createdAt: z.number().meta({ example: 1784030400000 }),
    updatedAt: z.number().meta({ example: 1784032260000 }),
    dependsOn: z.array(z.number()).meta({ example: [4818] }),
    dependents: z.array(z.number()).meta({ example: [4830] }),
    /** Ready, and at least one blocker is escalated or cancelled — it will not unblock on its own. */
    blockedOnFailed: z.boolean().meta({ example: false }),
    /** Number of blocker edges whose blocker has not completed. */
    openBlockerCount: z.number().int().nonnegative().meta({ example: 1 }),
    /** Derived: opted in (mirrored: the `ready-for-agent` label, not an Epic container) and no open Blockers. */
    agentWorkable: z.boolean().meta({ example: false }),
    /** A mirrored ticket Harmonic never works (no `ready-for-agent`, an Epic container, or a human wayfinder kind); false on native Tasks. Independent of blockers, so a blocked human-only ticket still reads human-only. */
    humanOnly: z.boolean().meta({ example: false }),
    /** This ticket is an Epic container — some other mirrored ticket names it as its parent. List surfaces mark and link it as an Epic (closed ones included); false on native Tasks and leaf tickets. */
    isEpic: z.boolean().meta({ example: false }),
    /** The Task-default overrides as stored: `null` ⇒ inherits; the sibling fields above are the resolved values. */
    overrides: z
      .object({
        harness: z.string().nullable().meta({ example: null }),
        model: z.string().nullable().meta({ example: 'opus-4.8' }),
        isolationMode: z.string().nullable().meta({ example: null }),
        priority: z.string().nullable().meta({ example: null }),
        conflictResolveTurns: z.number().int().nullable().meta({ example: null }),
      })
      .meta({ example: { harness: null, model: 'opus-4.8', isolationMode: null, priority: null, conflictResolveTurns: null } }),
  })
  .meta({ id: 'TaskWithDeps' });

/** The task shape the REST API and WebSocket both serve (serialize.ts `ApiTask`) — `TaskWithDeps` plus Cost and the tracker url. */
const taskSchema = taskWithDepsSchema
  .extend({
    /** The prompt's first line, bounded: the card title; the full `prompt` is item-GET-only. */
    summary: z.string().meta({ example: 'Add rate limiting to POST /api/tasks' }),
    cost: costSchema.nullable(),
    /** The mirrored issue's tracker URL (from the last poll); null on native Tasks or before a poll. */
    url: z.string().nullable().meta({ example: 'https://github.com/mintopia/harmonic/issues/35' }),
    /** The parent Map's title (resolved from mapRef, last poll); null when unmapped or before a poll. */
    mapTitle: z.string().nullable().meta({ example: 'Wayfinder' }),
    /** The latest Attempt's branch (worktree mode only); null in direct mode or before any Attempt. */
    branch: z.string().nullable().meta({ example: 'agent/4821-rate-limiting' }),
    /** The latest Attempt's `git diff --numstat` (additions⇥deletions⇥path per line),
     * snapshotted at merging; null before then or in direct mode. */
    stat: z.string().nullable().meta({ example: '96\t0\tsrc/server/rate-limit.ts' }),
    /** The running Attempt's `startedAt`; null unless the Task is running (issue #100). */
    runStartedAt: z.number().nullable().meta({ example: 1784032020000 }),
    /** Total tool-call count of the running attempt; null unless the Task is running. */
    toolCount: z.number().nullable().meta({ example: 12 }),
    /** The running attempt's id, so the board can match the attempt_usage firehose to this card; null unless running. */
    attemptId: z.number().nullable().meta({ example: 41 }),
    /** The running attempt's current Step; null unless the Task is working, or between Steps. */
    currentStep: z.enum(STEP_TYPES).nullable().meta({ example: 'verification' }),
    /** The running attempt's context-window occupancy in tokens; null unless running (or unreported). */
    contextTokens: z.number().nullable().meta({ example: 48210 }),
    /** The model's effective context window; null when unknown. */
    contextWindow: z.number().nullable().meta({ example: 200000 }),
    /** Why the scheduler is skipping this Task (blocker, capacity, disabled Workspace, missing integration branch); null when not waiting. */
    skipReason: z.string().nullable().meta({ example: 'blocked-by #12' }),
    /** The latest attempt's verified head ref; null when no attempt has produced a verified head yet. */
    verifiedRef: z.string().nullable().meta({ example: 'refs/harmonic/direct/attempt-9137' }),
    /** Whether the branch holds commits ahead of base an Accept could merge. */
    hasCandidate: z.boolean().meta({ example: true }),
  })
  .meta({ id: 'Task' });

/** The full task shape minus `prompt`; list surfaces render `summary` instead. */
const taskListRowSchema = taskSchema.omit({ prompt: true }).meta({ id: 'TaskListRow' });

const tasksListResponseSchema = listResponse('tasks', taskListRowSchema);

/** An Attempt as the REST API and WebSocket both serve it (serialize.ts `ApiAttempt`). */
const attemptSchema = z
  .object({
    id: z.number().meta({ example: 9137 }),
    taskId: z.number().meta({ example: 4821 }),
    number: z.number().meta({ example: 1 }),
    state: z.enum(['running', 'completed', 'failed', 'cancelled']).meta({ example: 'completed' }),
    /** Failure reason: 'interrupted', an error message, or null. */
    reason: z.string().nullable().meta({ example: null }),
    /** ACP stopReason from the session/prompt result. */
    stopReason: z.string().nullable().meta({ example: 'end_turn' }),
    sessionId: z.string().nullable().meta({ example: 'a3f2c1d0-8b4e-4c1a-9f7d-2e6b5a0c3d91' }),
    /** The Session this Attempt bound to on dispatch; a continuation inherits its predecessor's. */
    sessionRowId: z.number().nullable().meta({ example: 42 }),
    /** The exact prompt text sent to the harness; null until the prompt turn is sent. */
    prompt: z.string().nullable().meta({ example: 'Fix the rate-limiting bug in src/api.ts' }),
    /** Worktree mode: the attempt's branch and the branch it was cut from. */
    branch: z.string().nullable().meta({ example: 'agent/4821-rate-limiting' }),
    baseBranch: z.string().nullable().meta({ example: 'main' }),
    /** The verified head OID and the private ref it is pinned to; null when no verified head was produced. */
    verifiedHeadOid: z.string().nullable().meta({ example: '0f758cd2200565e7605902a86c2827c65ad25ce0' }),
    verifiedRef: z.string().nullable().meta({ example: 'refs/harmonic/direct/attempt-9137' }),
    usage: attemptUsageSchema.nullable(),
    /** Total tool calls this Attempt's session made. */
    toolCalls: z.number().meta({ example: 63 }),
    startedAt: z.number().meta({ example: 1784032020000 }),
    contextTokens: z.number().nullable().meta({ example: 48210 }),
    contextWindow: z.number().nullable().meta({ example: 200000 }),
    finishedAt: z.number().nullable().meta({ example: 1784032260000 }),
    cost: costSchema.nullable(),
  })
  .meta({ id: 'AttemptSummary' });

const attemptsListResponseSchema = listResponse('attempts', attemptSchema);

const attemptEventSchema = z.object({
  id: z.number().meta({ example: 55210 }),
  /** The Attempt this event is keyed to (`attempt_events.attempt_id`). */
  attemptId: z.number().meta({ example: 61 }),
  seq: z.number().meta({ example: 42 }),
  ts: z.number().meta({ example: 1784032140000 }),
  /** 'permission_request' | 'lifecycle' */
  type: z.string().meta({ example: 'lifecycle' }),
  /** JSON payload — shape varies by event type. */
  payload: z.unknown().meta({
    example: { event: 'merged', oid: '0f758cd2200565e7605902a86c2827c65ad25ce0' },
  }),
});

const eventsListResponseSchema = listResponse('events', attemptEventSchema);
const ticketTimelineEventSchema = z.object({
  attemptId: z.number().nullable(),
  ts: z.number(),
  kind: z.enum(['attempt-started', 'attempt-finished', 'lifecycle', 'verification', 'guardrail', 'operator-reject', 'fact']),
  data: z.unknown(),
});
const ticketTimelineResponseSchema = listResponse('events', ticketTimelineEventSchema);
const attemptLogResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), events: z.array(attemptEventSchema), liveCursor: z.number() }),
  z.object({ status: z.literal('unavailable'), liveCursor: z.number() }),
]);

/** A Guardrail-trip event as the REST API serves it. */
const guardrailEventSchema = z.object({
  id: z.number().meta({ example: 812 }),
  /** The Attempt this event is keyed to (`guardrail_events.attempt_id`). */
  attemptId: z.number().meta({ example: 61 }),
  seq: z.number().meta({ example: 1 }),
  ts: z.number().meta({ example: 1784032140000 }),
  /** The budget dimension that tripped. */
  dimension: z.enum(GUARDRAIL_DIMENSIONS).meta({ example: 'wall-clock' }),
  /** The configured bound that was crossed, in the dimension's unit (ms for wall-clock). */
  limitValue: z.number().meta({ example: 3_600_000 }),
  /** The observed value at trip, same unit as `limitValue`. */
  observedValue: z.number().meta({ example: 3_650_000 }),
  /** Where the limit resolved from: the global default, or a Workspace override. */
  configSource: z.enum(GUARDRAIL_CONFIG_SOURCES).meta({ example: 'default' }),
  /** Free-form JSON evidence attached at trip; `{}` when none. */
  payload: z.unknown().meta({ example: {} }),
});

const guardrailEventsListResponseSchema = listResponse('guardrailEvents', guardrailEventSchema);

/** One persisted verification attempt as the REST API serves it. */
const verificationAttemptSchema = z.object({
  id: z.number().meta({ example: 4210 }),
  /** The Attempt this row is keyed to (`verification_attempts.attempt_id`). */
  attemptId: z.number().meta({ example: 61 }),
  seq: z.number().meta({ example: 1 }),
  ts: z.number().meta({ example: 1784032140000 }),
  /** Which verifier produced this attempt. */
  mechanism: z.enum(VERIFICATION_MECHANISMS).meta({ example: 'command' }),
  /** The tree oid the verifier ran against. */
  inputOid: z.string().meta({ example: 'a1b2c3d4' }),
  /** This verifier's verdict for the attempt. */
  verdict: z.enum(['pass', 'fail', 'inconclusive']).meta({ example: 'pass' }),
  /** Short human summary of the outcome. */
  summary: z.string().meta({ example: 'all checks passed' }),
  /** Raw verifier output, caller-capped. */
  output: z.string().meta({ example: '' }),
  /** The exact prompt sent to the critic; null for a command verifier. */
  prompt: z.string().nullable().meta({ example: null }),
  /** The critic harness that produced the transcript; null for a command verifier or an older row. */
  harness: z.string().nullable().meta({ example: 'claude' }),
  /** Whether a critic transcript is available; fetch the parsed log from `GET /api/verification-attempts/:id/log`. */
  hasTranscript: z.boolean().meta({ example: false }),
});

const verificationAttemptsListResponseSchema = listResponse('verificationAttempts', verificationAttemptSchema).extend({
  verifierStatuses: z.array(verifierStatusSchema),
});

const usageResponseSchema = attemptUsageSchema.extend({
  cost: costSchema.nullable(),
  /** How many of the task's Attempts (including failed retries) reported usage. */
  attemptCount: z.number().meta({ example: 2 }),
});

const diffResponseSchema = z.object({
  branch: z.string().nullable().meta({ example: 'agent/4821-rate-limiting' }),
  baseBranch: z.string().nullable().meta({ example: 'main' }),
  /** `git diff --numstat` (additions⇥deletions⇥path per line) between baseBranch
   * and branch; null outside worktree mode. */
  stat: z.string().nullable().meta({
    example: '96\t0\tsrc/server/rate-limit.ts\n5\t3\tsrc/server/app.ts',
  }),
});

const filterEmpty = (value: string | readonly unknown[] | undefined): boolean =>
  value === undefined || (Array.isArray(value) && value.length === 0);

function sortListRows(rows: ApiTaskListRow[], sortBy: string | undefined, order: string | undefined): ApiTaskListRow[] {
  if (!sortBy) return rows;
  const dir = order === 'desc' ? -1 : 1;
  return rows.sort((a, b) => {
    const cmp = sortBy === 'cost' ? (a.cost?.totalUsd ?? -1) - (b.cost?.totalUsd ?? -1) : compareListRows(sortBy, a, b);
    return cmp * dir;
  });
}

export async function taskRoutes(fastify: FastifyInstance, ctx: AppContext): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const withDeps = async (task: { id: number }) =>
    await taskToApi(ctx, await ctx.tasks.withDeps(await ctx.tasks.get(task.id)));

  app.post(
    '/tasks',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Create a task. Reachable with an attempt-scoped Attempt Key.',
        body: createTaskInputSchema,
        response: {
          201: taskSchema.describe('The created task, in draft.'),
          400: errorResponse('The payload failed validation — see the error message for the offending field.'),
        },
      },
    },
    async (req, reply) => {
      const task = await ctx.tasks.create(req.body);
      return reply.status(201).send(await withDeps(task));
    },
  );

  app.get(
    '/tasks',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'List tasks: filtered (`state`, `harness`, `priority`, `parent` — an Epic ref, returning its child tasks), searched (`q`, server-side substring over prompt + title), sorted, and paginated (`limit`/`offset`, with a `total` count). An omitted `limit` returns every match. With `epics=true` and a `workspaceId`, the derived-epic model (ADR-0016) contributes epic-format rows to the unfiltered list. Reachable with an attempt-scoped Attempt Key.',
        querystring: taskListQuerySchema
          .extend(paginationQuerySchema.shape)
          .extend({ epics: z.enum(['true', 'false']).optional().meta({ example: 'true' }) }),
        response: { 200: tasksListResponseSchema.describe('One page of tasks matching the filters, in the requested order, plus the full match `total`.') },
      },
    },
    async (req) => {
      const { sortBy, order, limit, offset, epics, ...query } = req.query;
      const taskRows = await tasksToApi(ctx, await ctx.tasks.listWithDeps(query));
      const needle = query.q?.trim().toLowerCase();
      const wantEpics =
        epics === 'true' && query.workspaceId != null && filterEmpty(query.state) && filterEmpty(query.harness) && filterEmpty(query.priority);
      const epicRows = wantEpics
        ? (await ctx.trackerManager.listEpicTickets(query.workspaceId!))
            .filter((ticket) => !needle || ticket.title.toLowerCase().includes(needle))
            .map((ticket) => epicToListRow(ticket, query.workspaceId!))
        : [];
      const rows = sortListRows([...taskRows, ...epicRows], sortBy, order);
      const { items, total } = paginate(rows, { limit, offset });
      return { tasks: items, total };
    },
  );

  app.get(
    '/tasks/:id',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Get one task with its dependency context and Cost. Reachable with an attempt-scoped Attempt Key.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The task, with its dependency context and Cost.'),
          404: errorResponse('No task has that id.'),
        },
      },
    },
    async (req) => await withDeps({ id: req.params.id }),
  );

  app.patch(
    '/tasks/:id',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Edit a draft or ready task. Each Task-default field (harness, model, isolationMode, priority) accepts null to clear it back to inherit. Reachable with an attempt-scoped Attempt Key.',
        params: idParamsSchema,
        body: updateTaskInputSchema,
        response: {
          200: taskSchema.describe('The updated task.'),
          400: errorResponse('The payload failed validation — see the error message for the offending field.'),
          409: errorResponse('The task is running or finished, so its definition is frozen.'),
        },
      },
    },
    async (req) => await withDeps(await ctx.tasks.update(req.params.id, req.body)),
  );

  app.post(
    '/tasks/:id/ready',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Promote a draft to ready. Blocked-ness is derived from its open blockers. Reachable with an attempt-scoped Attempt Key.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not in a state this action can be applied to.'),
        },
      },
    },
    async (req) => await withDeps(await ctx.tasks.promote(req.params.id)),
  );

  app.post(
    '/tasks/:id/cancel',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Cancel a non-terminal task, optionally cascading to its dependents. Reachable with an attempt-scoped Attempt Key.',
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
        const cancelled = await ctx.tasks.cancelWithDependents(id);
        cancelled.forEach((taskId) => ctx.runner.cancelForTask(taskId));
        return await withDeps({ id });
      }
      const task = await ctx.tasks.cancel(id);
      ctx.runner.cancelForTask(task.id);
      return await withDeps(task);
    },
  );

  app.post(
    '/tasks/:id/pause',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Inject the configured pause steer, then pause a working task after its active turn settles. Reachable with an attempt-scoped Attempt Key.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The paused task.'),
          409: errorResponse('The task is not working.'),
        },
      },
    },
    async (req, reply) => {
      if (!(await ctx.runner.pause(req.params.id))) {
        return reply.code(409).send({ error: { code: 'conflict', message: 'The task is not actively running.' } });
      }
      return await withDeps({ id: req.params.id });
    },
  );

  app.post(
    '/tasks/:id/resume',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Resume a paused task on its existing Session. Reachable with an attempt-scoped Attempt Key.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The working task.'),
          409: errorResponse('The task is not paused.'),
        },
      },
    },
    async (req, reply) => {
      if (!(await ctx.runner.resume(req.params.id))) {
        return reply.code(409).send({ error: { code: 'conflict', message: 'The task has no paused Attempt to resume.' } });
      }
      return await withDeps({ id: req.params.id });
    },
  );

  app.delete(
    '/tasks/:id',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Permanently delete a Task and its Attempts, Usage, and Dependency edges. A mirrored Task is also dismissed so a re-poll will not re-create it. Distinct from Cancel, which keeps the record.',
        params: idParamsSchema,
        response: {
          200: z.object({ id: z.number().int() }).meta({ example: { id: 4821 } }).describe('The id of the deleted Task.'),
          404: errorResponse('No task has that id.'),
          409: errorResponse('The task is running and cannot be deleted.'),
        },
      },
    },
    async (req) => {
      const id = req.params.id;
      ctx.runner.cancelForTask(id);
      await ctx.tasks.delete(id);
      return { id };
    },
  );

  app.post(
    '/tasks/:id/complete',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Force a working task to done (operator override): stop the agent and settle it done, skipping verification and merging. Operator only.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not working.'),
        },
      },
    },
    async (req) => {
      const task = await ctx.tasks.complete(req.params.id);
      ctx.runner.completeForTask(task.id);
      return await withDeps(task);
    },
  );

  app.post(
    '/tasks/:id/steer',
    {
      schema: {
        tags: ['Tasks'],
        description:
          "Steer a running task: send an operator message to its active Attempt. When the harness supports ACP mid-turn steering, the message is injected into the running turn immediately — pre-empting the current generation without cancelling it. Otherwise, or when the agent is parked between turns, the message is queued and delivered as a fresh prompt turn at the next turn boundary. When no Attempt is active but the task's last Attempt left a still-warm, resumable session (an escalated task that ended without closure), the message continues that session in a fresh Attempt — a follow-up in the same conversation. Use it to redirect an agent that has gone off-track, nudge one that ended its turn and parked, or continue one whose Attempt just ended while its session is still warm. Operator only.",
        params: idParamsSchema,
        body: steerInputSchema,
        response: {
          200: okResponseSchema.describe("The message was injected into the running turn or queued at the next boundary of the task's active Attempt, or continued its last Attempt's still-warm session in a fresh Attempt."),
          409: errorResponse('The task has no active Attempt to steer and no warm, resumable session to continue.'),
        },
      },
    },
    async (req) => {
      await ctx.tasks.assertExists(req.params.id);
      if (!(await ctx.runner.steer(req.params.id, req.body.text)) && !(await ctx.runner.steerSettled(req.params.id, req.body.text))) {
        throw new DomainError('invalid_state', `task ${req.params.id} has no active Attempt to steer and no warm session to continue`);
      }
      return { ok: true } as const;
    },
  );

  app.post(
    '/tasks/:id/uncancel',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Return a cancelled task to the queue in place (ready; blocked-ness is derived from its open blockers). Reachable with an attempt-scoped Attempt Key.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not cancelled.'),
        },
      },
    },
    async (req) => await withDeps(await ctx.tasks.uncancel(req.params.id)),
  );

  app.post(
    '/tasks/:id/dependencies',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Add a dependency edge, re-deriving the open-blocker count. Reachable with an attempt-scoped Attempt Key.',
        params: idParamsSchema,
        body: dependsOnBodySchema,
        response: {
          200: taskWithDepsSchema.describe('The task with the edge added, and its open-blocker count re-derived.'),
          409: errorResponse('The edge is unknown, self-referential, or would close a dependency cycle.'),
        },
      },
    },
    async (req) => {
      const task = await ctx.tasks.addDependency(req.params.id, req.body.dependsOnId);
      return { ...task, workspaceId: atRestWorkspaceId(task.workspaceId) };
    },
  );

  app.delete(
    '/tasks/:id/dependencies/:depId',
    {
      schema: {
        tags: ['Tasks'],
        description: 'Remove a dependency edge, re-deriving the open-blocker count. Reachable with an attempt-scoped Attempt Key.',
        params: depParamsSchema,
        response: { 200: taskWithDepsSchema.describe('The task with the edge removed, and its open-blocker count re-derived.') },
      },
    },
    async (req) => {
      const task = await ctx.tasks.removeDependency(req.params.id, req.params.depId);
      return { ...task, workspaceId: atRestWorkspaceId(task.workspaceId) };
    },
  );

  app.post(
    '/tasks/:id/accept',
    {
      schema: {
        tags: ['Tasks'],
        description:
          "Accept an escalated ticket: verifies the ticket's candidate first — a pass merges it as-is and continues the success path (merge, close the tracker issue, clean up, moving it to done); a non-pass re-enters the Attempt loop with the verifier's reason as feedback, exactly like Reject, and the ticket stays escalated-turned-working. Force-Accept (`{ force: true }`) skips verification and merges the candidate as-is. Human-only.",
        params: idParamsSchema,
        body: acceptInputSchema,
        response: {
          200: taskSchema.describe('The task, done (a passing or forced Accept) or back in the Attempt loop (a non-pass verify).'),
          409: errorResponse('The task is not escalated, has no candidate to accept (the branch has no commits ahead of its base), or the merging failed (the detail says why); it stays escalated.'),
        },
      },
    },
    async (req) => await withDeps(await ctx.escalation.accept(req.params.id, { force: req.body?.force ?? false })),
  );

  app.post(
    '/tasks/:id/reject',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Reject an escalated ticket with guidance: the guidance becomes feedback for the next Attempt and the attempt budget resets. The ticket requeues to `ready` — the Auto-Runner starts the next Attempt when capacity frees; it is not force-started here unless `start: true` (the warm-Session "start now" override, which bypasses the capacity ceiling). The escalated Attempt\'s branch is retained as evidence until its Session retires. Human-only.',
        params: idParamsSchema,
        body: rejectInputSchema,
        response: {
          200: taskSchema.describe('The task, back in the Attempt loop.'),
          400: errorResponse('The guidance is empty.'),
          409: errorResponse('The task is not escalated.'),
        },
      },
    },
    async (req) => await withDeps(await ctx.escalation.reject(req.params.id, req.body.guidance, req.body.start ?? false)),
  );

  app.post(
    '/tasks/:id/close',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Close an escalated ticket: cancel it and clean up — remove its branch and worktree, close the tracker issue. Human-only.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The task, cancelled.'),
          409: errorResponse('The task is not escalated.'),
        },
      },
    },
    async (req) => await withDeps(await ctx.escalation.close(req.params.id)),
  );

  app.get(
    '/tasks/:id/continuation',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Preview the Session continuation a Reject with guidance will get (issue #170; decided by the #311 rule, not the operator): if this task has a live Session, the warm-session estimate and the condensed alternative. `available: false` when there is nothing to continue.',
        params: idParamsSchema,
        response: {
          200: continuationPreviewSchema.describe('The continuation offer for this task, or `available: false`.'),
          404: errorResponse('No task has that id.'),
        },
      },
    },
    async (req) => {
      const task = await ctx.tasks.get(req.params.id);
      const runsForTask = await ctx.attempts.listForTask(req.params.id);
      const sessions = new Map<number, Awaited<ReturnType<typeof ctx.sessions.get>> | null>();
      for (const run of runsForTask) {
        if (run.sessionRowId === null || sessions.has(run.sessionRowId)) continue;
        try {
          sessions.set(run.sessionRowId, await ctx.sessions.get(run.sessionRowId));
        } catch {
          sessions.set(run.sessionRowId, null);
        }
      }
      const plan = previewHumanRejectContinuation(
        runsForTask,
        (sessionRowId) => sessions.get(sessionRowId) ?? null,
        Object.entries(ctx.settingsStore.getGlobal().harnesses).find(([id]) => id === task.harness)?.[1].cacheWarmSeconds ?? 0,
        Date.now(),
      );
      if (!plan) return { available: false as const };
      return { available: true as const, continueFull: plan.continueFull, startCondensed: plan.startCondensed };
    },
  );

  app.post(
    '/tasks/:id/run',
    {
      schema: {
        tags: ['Attempts'],
        description: 'Start an attempt for a ready task. Reachable with an attempt-scoped Attempt Key.',
        params: idParamsSchema,
        response: { 201: attemptSchema.describe('The attempt that just started.') },
      },
    },
    async (req, reply) => {
      const run = await ctx.runner.start(req.params.id);
      return reply.status(201).send(await attemptToApi(ctx, run));
    },
  );

  app.get(
    '/tasks/:id/attempts/timeline',
    {
      schema: {
        tags: ['Attempts'],
        description: "A ticket's attempt timeline. Steps are ordered exactly as they ran.",
        params: idParamsSchema,
        querystring: paginationQuerySchema,
        response: { 200: attemptTimelineResponseSchema },
      },
    },
    async (req) => {
      await ctx.tasks.assertExists(req.params.id);
      const { limit, offset } = req.query;
      const { attempts, budgetBase } = await attemptTimelineToApi(ctx, req.params.id);
      const { items, total } = paginate(attempts, { limit, offset });
      return { attempts: items, total, budgetBase };
    },
  );

  app.get(
    '/tasks/:id/timeline',
    {
      schema: {
        tags: ['Tasks'],
        description: 'A chronological projection of the ticket lifecycle, verification, guardrail, operator, and merging event logs.',
        params: idParamsSchema,
        querystring: paginationQuerySchema,
        response: { 200: ticketTimelineResponseSchema.describe('Chronological lifecycle events for this task.'), 404: errorResponse('No task has that id.') },
      },
    },
    async (req) => {
      await ctx.tasks.assertExists(req.params.id);
      const { limit, offset } = req.query;
      const { events } = await ticketTimelineToApi(ctx, req.params.id);
      const { items, total } = paginate(events, { limit, offset });
      return { events: items, total };
    },
  );

  app.get(
    '/tasks/:id/attempts',
    {
      schema: {
        tags: ['Attempts'],
        description: "List a task's attempts (retries included). Reachable with an attempt-scoped Attempt Key.",
        params: idParamsSchema,
        querystring: paginationQuerySchema,
        response: { 200: attemptsListResponseSchema.describe("Every attempt for the task, including failed retries, oldest first.") },
      },
    },
    async (req) => {
      await ctx.tasks.assertExists(req.params.id);
      const { limit, offset } = req.query;
      const list = await Promise.all((await ctx.attempts.listForTask(req.params.id)).map((run) => attemptToApi(ctx, run)));
      const { items, total } = paginate(list, { limit, offset });
      return { attempts: items, total };
    },
  );

  app.get(
    '/tasks/:id/attempts/current',
    {
      schema: {
        tags: ['Attempts'],
        description:
          "The task's current (latest) attempt — the follow-forward read for pollers: self-heal advances to a new Attempt row each turn, and this always reflects the live one. Reachable with an attempt-scoped Attempt Key.",
        params: idParamsSchema,
        response: {
          200: attemptSchema.describe('The current attempt, with its Usage and Cost.'),
          404: errorResponse('No task has that id, or it has no attempts yet.'),
        },
      },
    },
    async (req) => {
      await ctx.tasks.assertExists(req.params.id);
      return await attemptToApi(ctx, await ctx.attempts.currentForTask(req.params.id));
    },
  );

  app.get(
    '/attempts/:id',
    {
      schema: {
        tags: ['Attempts'],
        description: 'Get one attempt with its Usage and Cost. Reachable with an attempt-scoped Attempt Key.',
        params: idParamsSchema,
        response: {
          200: attemptSchema.describe('The attempt, with its Usage and Cost.'),
          404: errorResponse('No attempt has that id.'),
        },
      },
    },
    async (req) => await attemptToApi(ctx, await ctx.attempts.get(req.params.id)),
  );

  app.get(
    '/attempts/:id/log',
    {
      schema: {
        tags: ['Attempts'],
        description: "Read an Attempt's native harness transcript. Missing or unreadable transcripts are explicitly unavailable.",
        params: idParamsSchema,
        response: { 200: attemptLogResponseSchema.describe('The native transcript events, or an explicit unavailable state.') },
      },
    },
    async (req) => {
      const run = await ctx.attempts.get(req.params.id);
      if (run.sessionRowId === null) return { status: 'unavailable' as const, liveCursor: ctx.bus.latestAttemptLogSeq({ attemptId: run.id }) };
      let session;
      try {
        session = await ctx.sessions.get(run.sessionRowId);
      } catch {
        return { status: 'unavailable' as const, liveCursor: ctx.bus.latestAttemptLogSeq({ attemptId: run.id }) };
      }
      const adapter = adapterFor(session.harness);
      let log: TranscriptLog;
      if (adapter.exportTranscript) {
        const events = await adapter.exportTranscript({ sessionId: session.harnessSessionId, cwd: session.cwd });
        log = events && events.length > 0 ? { status: 'available', events } : { status: 'unavailable' };
      } else {
        const path = session.transcriptPath ?? (await ctx.runner.ensureSessionTranscript(run.sessionRowId));
        log = await readTranscriptLog({
          harness: session.harness,
          path,
          startedAt: run.startedAt,
          finishedAt: run.endedAt,
        });
      }
      const liveCursor = ctx.bus.latestAttemptLogSeq({ attemptId: run.id });
      if (log.status !== 'available') return { ...log, liveCursor };
      const operator: OperatorMessage[] = (await ctx.attempts.listEvents(run.id)).flatMap((e) => {
        const p = e.payload as { event?: string; text?: unknown } | null;
        return (p?.event === 'steer_injected' || p?.event === 'steer_queued') && typeof p.text === 'string'
          ? [{ ts: e.ts, text: p.text, queued: p.event === 'steer_queued' }]
          : [];
      });
      return {
        status: 'available' as const,
        liveCursor,
        events: withOperatorMessages(log.events, operator).map((event) => ({ ...event, attemptId: run.id })),
      };
    },
  );

  app.get(
    '/attempts/:id/events',
    {
      schema: {
        tags: ['Attempts'],
        description: 'Replay an attempt\'s persisted events, in order — the same records streamed live over the WebSocket. Reachable with an attempt-scoped Attempt Key.',
        params: idParamsSchema,
        querystring: paginationQuerySchema,
        response: { 200: eventsListResponseSchema.describe('The attempt\'s persisted events in sequence order.') },
      },
    },
    async (req) => {
      const run = await ctx.attempts.get(req.params.id);
      const { limit, offset } = req.query;
      const { items, total } = paginate(await ctx.attempts.listEvents(run.id), { limit, offset });
      return { events: items, total };
    },
  );

  app.get(
    '/attempts/:id/guardrail-events',
    {
      schema: {
        tags: ['Attempts'],
        description: "Replay an attempt's Guardrail-trip event log, in sequence order (issue #171). Reachable with an attempt-scoped Attempt Key.",
        params: idParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: guardrailEventsListResponseSchema.describe("The attempt's Guardrail-trip events in sequence order."),
          404: errorResponse('No attempt has that id.'),
        },
      },
    },
    async (req) => {
      const run = await ctx.attempts.get(req.params.id);
      const { limit, offset } = req.query;
      const guardrailEvents = (await ctx.guardrailEvents.list(run.id)).map((r) => ({
        ...r,
        payload: JSON.parse(r.payload) as unknown,
      }));
      const { items, total } = paginate(guardrailEvents, { limit, offset });
      return { guardrailEvents: items, total };
    },
  );

  app.get(
    '/attempts/:id/verification-attempts',
    {
      schema: {
        tags: ['Attempts'],
        description:
          "Replay an attempt's verification-attempt log (per-verifier verdicts + summaries), in sequence order (issue #169, part of #109). Reachable with an attempt-scoped Attempt Key.",
        params: idParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: verificationAttemptsListResponseSchema.describe("The attempt's verification attempts in sequence order."),
          404: errorResponse('No attempt has that id.'),
        },
      },
    },
    async (req) => {
      const run = await ctx.attempts.get(req.params.id);
      const { limit, offset } = req.query;
      const attempts = await ctx.verificationAttempts.list(run.id);
      const verifierStatuses = await verifierStatusesToApi(ctx, run, attempts);
      const { items, total } = paginate(
        attempts.map((a) => ({ ...a, hasTranscript: a.transcriptPath != null })),
        { limit, offset },
      );
      return { verificationAttempts: items, total, verifierStatuses };
    },
  );

  app.get(
    '/verification-attempts/:id',
    {
      schema: {
        tags: ['Attempts'],
        description: 'Read a verification task outcome and its captured command output.',
        params: idParamsSchema,
        response: {
          200: z
            .object({ output: z.string(), summary: z.string(), hasTranscript: z.boolean() })
            .describe("The verification task's captured command output and summary, and whether a critic transcript exists."),
        },
      },
    },
    async (req) => {
      const attempt = await ctx.verificationAttempts.get(req.params.id);
      if (!attempt) throw new DomainError('not_found', `verification attempt ${req.params.id} not found`);
      return { output: attempt.output, summary: attempt.summary, hasTranscript: attempt.transcriptPath !== null };
    },
  );

  app.get(
    '/verification-attempts/:id/log',
    {
      schema: {
        tags: ['Attempts'],
        description:
          "Read a critic verification attempt's native harness transcript — what the critic itself read, ran, and reasoned. Missing or unreadable transcripts are explicitly unavailable.",
        params: idParamsSchema,
        response: {
          200: attemptLogResponseSchema.describe('The critic session transcript events, or an explicit unavailable state.'),
        },
      },
    },
    async (req) => {
      const attempt = await ctx.verificationAttempts.get(req.params.id);
      if (!attempt?.transcriptPath || !attempt.harness) return { status: 'unavailable' as const, liveCursor: 0 };
      const log = await readTranscriptLog({
        harness: attempt.harness,
        path: attempt.transcriptPath,
        startedAt: 0,
        finishedAt: null,
      });
      return log.status === 'available'
        ? { ...log, liveCursor: 0, events: log.events.map((event) => ({ ...event, attemptId: attempt.attemptId })) }
        : { ...log, liveCursor: 0 };
    },
  );

  app.get(
    '/tasks/:id/usage',
    {
      schema: {
        tags: ['Attempts'],
        description:
          "Usage and Cost rolled up across all of a task's attempts, retries included. Reachable with an attempt-scoped Attempt Key.",
        params: idParamsSchema,
        response: { 200: usageResponseSchema.describe('Usage and Cost rolled up across the task\'s attempts.') },
      },
    },
    async (req) => {
      await ctx.tasks.assertExists(req.params.id);
      const runs = await ctx.attempts.listForTask(req.params.id);
      const usages = runs
        .map((run) => (run.usage ? (JSON.parse(run.usage) as AttemptUsage) : null))
        .filter((u): u is AttemptUsage => u !== null);
      return {
        ...(mergeUsage(usages) ?? { models: {}, totals: null, toolCalls: {}, source: null }),
        cost: costOfAttempts(runs),
        attemptCount: usages.length,
      };
    },
  );

  app.get(
    '/attempts/:id/diff',
    {
      schema: {
        tags: ['Attempts'],
        description:
          'Branch and diffstat for the review inbox (worktree-mode attempts only; other fields are null). Reachable with an attempt-scoped Attempt Key.',
        params: idParamsSchema,
        response: { 200: diffResponseSchema.describe('The attempt\'s branch and its diffstat against the base; nulls outside worktree mode.') },
      },
    },
    async (req) => {
      const run = await ctx.attempts.get(req.params.id);
      if (!run.branch || !run.baseBranch) return { branch: null, baseBranch: null, stat: null };
      const task = await ctx.tasks.get(run.taskId);
      const stat = await attemptDiffStat(task.workingDir, run).catch(() => null);
      return { branch: run.branch, baseBranch: run.baseBranch, stat };
    },
  );

  app.get(
    '/attempts/:id/diff/files',
    {
      schema: {
        tags: ['Attempts'],
        description:
          'Per-file unified-diff hunks for the review pane (worktree-mode attempts only). Empty `files` outside worktree mode or when the branch/worktree is gone. Reachable with an attempt-scoped Attempt Key.',
        params: idParamsSchema,
        querystring: paginationQuerySchema,
        response: { 200: diffFilesResponseSchema.describe("The attempt's changed files with parsed +/- hunks; empty outside worktree mode.") },
      },
    },
    async (req) => {
      const run = await ctx.attempts.get(req.params.id);
      const task = await ctx.tasks.get(run.taskId);
      const { limit, offset } = req.query;
      const files = await attemptDiffFiles(task.workingDir, run).catch(() => []);
      const { items, total } = paginate(files, { limit, offset });
      return { files: items, total };
    },
  );
}
