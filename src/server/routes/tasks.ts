import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { createTaskInputSchema, updateTaskInputSchema, taskListQuerySchema } from '../../domain/tasks.js';
import { previewHumanRejectContinuation } from '../../domain/session-continuation.js';
import {
  TASK_STATES,
  RUN_STATES,
  TASK_ORIGINS,
  WORKFLOWS,
  WAYFINDER_TYPES,
  DRIVES,
  GUARDRAIL_DIMENSIONS,
  GUARDRAIL_CONFIG_SOURCES,
  VERIFICATION_MECHANISMS,
} from '../../db/schema.js';
import { RUN_PHASES } from '../../domain/run-phases.js';
import { Git } from '../../execution/git.js';
import { DomainError } from '../../domain/errors.js';
import { mergeUsage, type RunUsage } from '../../execution/usage.js';
import { readTranscriptLog, withOperatorMessages, type OperatorMessage } from '../../execution/transcript-log.js';
import { attemptTimelineToApi, atRestWorkspaceId, costOfRuns, runToApi, taskToApi, tasksToApi } from '../serialize.js';
import { attemptTimelineResponseSchema, errorResponse, idParamsSchema, costSchema, runUsageSchema, okResponseSchema } from '../schemas.js';

/** The reviewer's note, carried onto the re-attempt or back to the queue. */
const feedbackExample = 'The limiter is per-process; it needs to be shared across workers.';
const requeueInputSchema = z
  .object({
    feedback: z.string().optional().meta({ example: feedbackExample }),
    /** How the re-run continues the rejected Run's Session (issue #170): `'full'`
     * (default) re-binds the warm Session, `'condensed'` starts fresh carrying
     * only the feedback. Omit to keep the historical full-continuation. */
    continuation: z.enum(['full', 'condensed']).optional().meta({ example: 'condensed' }),
  })
  .nullish();
const rejectInputSchema = z.object({ feedback: z.string().optional().meta({ example: feedbackExample }) }).nullish();
/** The operator's note-to-critic input (issue #191): a required human note
 * folded into the critic's trusted preamble for a targeted re-review. */
const noteExample = 'The rate limiter must be shared across worker processes, not per-process.';
const noteToCriticInputSchema = z.object({ note: z.string().trim().min(1).meta({ example: noteExample }) });
const cancelInputSchema = z.object({ withDependents: z.boolean().optional().meta({ example: true }) }).nullish();
/** The reject dialog's continuation preview (issue #170): what `planSessionContinuation`
 * offers for this Task's live Session, so the operator sees the full-continuation
 * cost estimate before choosing. `available: false` means there is nothing to
 * continue (no Run ever bound a Session, or it has been retired), so the dialog
 * shows only the plain re-attempt. */
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
    /** The owning Workspace (ADR-0008). */
    workspaceId: z.number().meta({ example: 1 }),
    /** One of config.ts's HARNESS_IDS ('claude' | 'codex' | 'copilot'); stored as plain text. */
    harness: z.string().meta({ example: 'claude' }),
    model: z.string().meta({ example: 'sonnet-5' }),
    workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
    /** 'direct' | 'worktree' (config.ts ISOLATION_MODES); stored as plain text. */
    isolationMode: z.string().meta({ example: 'worktree' }),
    /** Explicit base branch a worktree Run is cut from and lands back onto
     * (issue #157, ADR-0024); null resolves at spawn to the working dir's
     * current branch. */
    baseBranch: z.string().nullable().meta({ example: 'integration/epic-42' }),
    /** 'high' | 'normal' | 'low' (config.ts PRIORITIES); stored as plain text. */
    priority: z.string().meta({ example: 'normal' }),
    state: z.enum(TASK_STATES).meta({ example: 'awaiting-review' }),
    feedback: z.string().nullable().meta({ example: null }),
    /** How a re-attempt continues the rejected Run's Session (issue #170): 'full'
     * resumes the same Session, 'condensed' starts fresh; null on originals and
     * pre-feature re-attempts (⇒ full). */
    continuationChoice: z.enum(['full', 'condensed']).nullable().meta({ example: null }),
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
    /** Number of blocker edges whose blocker has not completed. */
    openBlockerCount: z.number().int().nonnegative().meta({ example: 1 }),
    /** Whether the Auto-Runner may work this ticket now. */
    agentWorkable: z.boolean().meta({ example: false }),
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
    /** The running run's phase (executing → validating → verifying → [review] →
     * landing → terminal), so the Board's Active card can badge it; null unless
     * the Task is running (or a pre-phase-machine run). */
    phase: z.enum(RUN_PHASES).nullable().meta({ example: 'verifying' }),
    /** The running run's context-window occupancy in tokens; null unless running
     * (or unreported). Live via the run_usage firehose (issue #52). */
    contextTokens: z.number().nullable().meta({ example: 48210 }),
    /** The model's effective context window (config override, else shipped
     * default); null when unknown. The Board card shows `ctx %` =
     * contextTokens/contextWindow — never a fabricated percentage (issue #52). */
    contextWindow: z.number().nullable().meta({ example: 200000 }),
    /** The current scheduler reason this Task is waiting, such as a blocker,
     * capacity limit, disabled Workspace, or missing integration branch;
     * null when it is not waiting (issue #238). */
    skipReason: z.string().nullable().meta({ example: 'blocked-by #12' }),
    /** The latest run's frozen verification candidate ref (issue #134's Run
     * `candidateRef`), surfaced here so an escalated Task's stranded candidate
     * can be adopted for review, or re-reviewed with a note, without a fresh
     * builder run (issue #191); null when no run has produced a candidate yet. */
    candidateRef: z.string().nullable().meta({ example: 'refs/harmonic/candidate/run-9137' }),
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
    /** The durable Harmonic Session (issue #141) this Run bound to on dispatch;
     * a retry/reject continuation (issue #147) inherits its predecessor's, so two
     * Runs sharing a `sessionRowId` continued the same ACP conversation. */
    sessionRowId: z.number().nullable().meta({ example: 42 }),
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
const runLogResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), events: z.array(runEventSchema), liveCursor: z.number() }),
  z.object({ status: z.literal('unavailable'), liveCursor: z.number() }),
]);

/** A Guardrail-trip event as the REST API serves it (`domain/guardrail-events.ts` `GuardrailEventRow`, issue #171). */
const guardrailEventSchema = z.object({
  id: z.number().meta({ example: 812 }),
  runId: z.number().meta({ example: 9137 }),
  seq: z.number().meta({ example: 1 }),
  ts: z.number().meta({ example: 1784032140000 }),
  /** The budget dimension that tripped. */
  dimension: z.enum(GUARDRAIL_DIMENSIONS).meta({ example: 'wall-clock' }),
  /** The Run phase the trip was observed in. */
  phase: z.enum(RUN_PHASES).meta({ example: 'executing' }),
  /** The configured bound that was crossed, in the dimension's unit (ms for wall-clock). */
  limitValue: z.number().meta({ example: 3_600_000 }),
  /** The observed value at trip, same unit as `limitValue`. */
  observedValue: z.number().meta({ example: 3_650_000 }),
  /** Where the limit resolved from: the global default, or a Workspace override. */
  configSource: z.enum(GUARDRAIL_CONFIG_SOURCES).meta({ example: 'default' }),
  /** Free-form JSON evidence attached at trip; `{}` when none. */
  payload: z.unknown().meta({ example: {} }),
});

const guardrailEventsListResponseSchema = z.object({ guardrailEvents: z.array(guardrailEventSchema) });

/** One persisted verification attempt as the REST API serves it (`domain/verification-attempts.ts` `VerificationAttemptRow`, issue #169, part of #109). */
const verificationAttemptSchema = z.object({
  id: z.number().meta({ example: 4210 }),
  runId: z.number().meta({ example: 9137 }),
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
  /** The Run phase the attempt was recorded in. */
  phase: z.enum(RUN_PHASES).meta({ example: 'verifying' }),
  /** Whether the verifier mutated the worktree. */
  mutated: z.boolean().meta({ example: false }),
  /** Whether a critic-session transcript is available for this attempt
   * (ADR-0040). The raw path is server-only; fetch the parsed log from
   * `GET /api/verification-attempts/:id/log`. */
  hasTranscript: z.boolean().meta({ example: false }),
});

const verificationAttemptsListResponseSchema = z.object({ verificationAttempts: z.array(verificationAttemptSchema) });

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

const diffLineSchema = z.object({
  kind: z.enum(['add', 'del', 'context', 'hunk']),
  oldLn: z.number().nullable(),
  newLn: z.number().nullable(),
  text: z.string(),
});

const diffFileSchema = z.object({
  path: z.string().meta({ example: 'src/server/rate-limit.ts' }),
  status: z.enum(['M', 'A', 'D']),
  additions: z.number().meta({ example: 96 }),
  deletions: z.number().meta({ example: 4 }),
  lines: z.array(diffLineSchema),
});

const diffFilesResponseSchema = z.object({ files: z.array(diffFileSchema) });

type DiffFile = z.infer<typeof diffFileSchema>;

/**
 * Parse a `git diff` unified diff (the `base...branch` range {@link Git.diffStat}
 * counts, so per-file additions/deletions here agree with the diffstat) into one
 * {@link DiffFile} per file. `oldLn`/`newLn` track the pre-/post-image line the
 * hunk header seeds; an added line has no old line and a deleted line no new one.
 */
function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let inHunk = false;
  let oldLn = 0;
  let newLn = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      current = { path: '', status: 'M', additions: 0, deletions: 0, lines: [] };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      // Header lines precede the first hunk; a body `+++ `/`--- ` line can only
      // appear once inHunk, so header detection is safe from that ambiguity.
      if (line.startsWith('new file')) current.status = 'A';
      else if (line.startsWith('deleted file')) current.status = 'D';
      else if (line.startsWith('--- ')) {
        const p = line.slice(4);
        if (p !== '/dev/null' && current.path === '') current.path = p.replace(/^[ab]\//, '');
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') current.path = p.replace(/^[ab]\//, '');
      }
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldLn = Number(hunk[1]);
      newLn = Number(hunk[2]);
      current.lines.push({ kind: 'hunk', oldLn: null, newLn: null, text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      current.additions++;
      current.lines.push({ kind: 'add', oldLn: null, newLn, text: line.slice(1) });
      newLn++;
    } else if (line.startsWith('-')) {
      current.deletions++;
      current.lines.push({ kind: 'del', oldLn, newLn: null, text: line.slice(1) });
      oldLn++;
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', oldLn, newLn, text: line.slice(1) });
      oldLn++;
      newLn++;
    }
    // `\ No newline at end of file` and blank trailing lines fall through, ignored.
  }
  return files;
}

export async function taskRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const withDeps = async (task: { id: number }) =>
    await taskToApi(ctx, await ctx.tasks.withDeps(await ctx.tasks.get(task.id)));

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
      const task = await ctx.tasks.create(req.body);
      return reply.status(201).send(await withDeps(task));
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
      const tasks = await tasksToApi(
        ctx,
        await ctx.tasks.listWithDeps(sortBy === 'cost' ? query : { ...query, ...(sortBy ? { sortBy } : {}) }),
      );
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
    async (req) => await withDeps({ id: req.params.id }),
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
    async (req) => await withDeps(await ctx.tasks.update(req.params.id, req.body)),
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
    async (req) => await withDeps(await ctx.tasks.promote(req.params.id)),
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
        const cancelled = await ctx.tasks.cancelWithDependents(id);
        cancelled.forEach((taskId) => ctx.runner.cancelForTask(taskId));
        return await withDeps({ id });
      }
      const task = await ctx.tasks.cancel(id);
      ctx.runner.cancelForTask(task.id);
      return await withDeps(task);
    },
  );

  app.delete(
    '/tasks/:id',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Permanently delete a Task and its Runs, Usage, and Dependency edges. A mirrored Task is also dismissed so a re-poll will not re-create it. Distinct from Cancel, which keeps the record.',
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
          'Force a running task to completed (operator override): stop the agent and settle it done, skipping the review gate. Operator only.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not running.'),
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
      await ctx.tasks.assertExists(req.params.id);
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
    async (req) => await withDeps(await ctx.tasks.unescalate(req.params.id)),
  );

  app.post(
    '/tasks/:id/requeue',
    {
      schema: {
        tags: ['Tasks'],
        description:
          "Send a failed task back to ready for another attempt, re-running the SAME task in place, with optional feedback for the retry. Native tasks append it to the prompt; mirrored tasks carry it in the feedback field (their prompt is re-derived from the ticket each poll). This is the reject re-run path for a mirrored task (which cannot be re-attempted as a new task), so it also accepts the issue #170 Session `continuation` choice. Reachable with a run-scoped Run Key.",
        params: idParamsSchema,
        body: requeueInputSchema,
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not in a state this action can be applied to.'),
        },
      },
    },
    async (req) => await withDeps(await ctx.tasks.requeue(req.params.id, req.body?.feedback, req.body?.continuation)),
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
    async (req) => await withDeps(await ctx.tasks.uncancel(req.params.id)),
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
      const task = await ctx.tasks.addDependency(req.params.id, req.body.dependsOnId);
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
          'Accept an awaiting-review task, completing it (and merging its branch in worktree mode). Human-only.',
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not in a state this action can be applied to.'),
        },
      },
    },
    async (req) => await withDeps(await ctx.review.accept(req.params.id)),
  );

  app.post(
    '/tasks/:id/reject',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Reject an awaiting-review task with optional feedback, failing it. Human-only.',
        params: idParamsSchema,
        body: rejectInputSchema,
        response: {
          200: taskSchema.describe('The task in its new state.'),
          409: errorResponse('The task is not in a state this action can be applied to.'),
        },
      },
    },
    async (req) => await withDeps(await ctx.review.reject(req.params.id, req.body?.feedback)),
  );

  app.post(
    '/tasks/:id/adopt-review',
    {
      schema: {
        tags: ['Tasks'],
        description:
          "Operator escape hatch (issue #191): park an escalated task's existing stranded candidate at awaiting-review — no fresh builder run — so the ordinary accept (accept-anyway) can land it. Human-only.",
        params: idParamsSchema,
        response: {
          200: taskSchema.describe('The task, now awaiting-review with the escalated flag cleared.'),
          409: errorResponse('The task is not escalated, or its latest run has no candidate to adopt.'),
        },
      },
    },
    async (req) => {
      await ctx.runner.adoptForReview(req.params.id);
      return await withDeps({ id: req.params.id });
    },
  );

  app.post(
    '/tasks/:id/note-to-critic',
    {
      schema: {
        tags: ['Tasks'],
        description:
          "Operator escape hatch (issue #191): re-run ONLY the agent critic against an escalated task's existing stranded candidate, with a human note folded into its trusted preamble, and re-fold the verdict. A `proceed` result parks the task at awaiting-review (never auto-landed); otherwise the task stays escalated with the new attempt recorded. Human-only.",
        params: idParamsSchema,
        body: noteToCriticInputSchema,
        response: {
          200: taskSchema.describe('The task — awaiting-review on a proceed verdict, still escalated otherwise.'),
          400: errorResponse('The note is empty (blank/whitespace-only), or the resolved critic harness is not configured.'),
          409: errorResponse('The task is not escalated, its latest run has no candidate, or no critic is configured.'),
        },
      },
    },
    async (req) => {
      await ctx.runner.reverifyWithNote(req.params.id, req.body.note);
      return await withDeps({ id: req.params.id });
    },
  );

  app.get(
    '/tasks/:id/continuation',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Preview the reject-time Session continuation choice (issue #170): if this task has a live Session, the full-continuation cost estimate (from planSessionContinuation) plus the condensed alternative the reject dialog offers. `available: false` when there is nothing to continue.',
        params: idParamsSchema,
        response: {
          200: continuationPreviewSchema.describe('The continuation offer for this task, or `available: false`.'),
          404: errorResponse('No task has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.tasks.assertExists(req.params.id);
      const runsForTask = await ctx.runs.listForTask(req.params.id);
      // `previewHumanRejectContinuation` stays a pure, synchronous domain
      // function; resolve every candidate Session row up front so its
      // `getSession` lookup can remain sync.
      const sessions = new Map<number, Awaited<ReturnType<typeof ctx.sessions.get>> | null>();
      for (const run of runsForTask) {
        if (run.sessionRowId === null || sessions.has(run.sessionRowId)) continue;
        try {
          sessions.set(run.sessionRowId, await ctx.sessions.get(run.sessionRowId));
        } catch {
          sessions.set(run.sessionRowId, null); // Session retired + swept — nothing to continue
        }
      }
      const plan = previewHumanRejectContinuation(
        runsForTask,
        (sessionRowId) => sessions.get(sessionRowId) ?? null,
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
        tags: ['Runs'],
        description: 'Start a run for a ready task. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        response: { 201: runSchema.describe('The run that just started.') },
      },
    },
    async (req, reply) => {
      const run = await ctx.runner.start(req.params.id);
      return reply.status(201).send(runToApi(ctx, run));
    },
  );

  app.get(
    '/tasks/:id/attempts',
    {
      schema: {
        tags: ['Attempts'],
        description: "A ticket's attempt timeline. Tasks are ordered exactly as they ran.",
        params: idParamsSchema,
        response: { 200: attemptTimelineResponseSchema },
      },
    },
    async (req) => {
      await ctx.tasks.assertExists(req.params.id);
      return attemptTimelineToApi(ctx, req.params.id);
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
      await ctx.tasks.assertExists(req.params.id);
      return { runs: (await ctx.runs.listForTask(req.params.id)).map((run) => runToApi(ctx, run)) };
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
    async (req) => runToApi(ctx, await ctx.runs.get(req.params.id)),
  );

  app.get(
    '/runs/:id/log',
    {
      schema: {
        tags: ['Runs'],
        description: "Read a Run's native harness transcript. Missing or unreadable transcripts are explicitly unavailable.",
        params: idParamsSchema,
        response: { 200: runLogResponseSchema.describe('The native transcript events, or an explicit unavailable state.') },
      },
    },
    async (req) => {
      const run = await ctx.runs.get(req.params.id);
      if (run.sessionRowId === null) return { status: 'unavailable' as const, liveCursor: ctx.bus.latestRunLogSeq({ runId: run.id }) };
      let session;
      try {
        session = await ctx.sessions.get(run.sessionRowId);
      } catch {
        return { status: 'unavailable' as const, liveCursor: ctx.bus.latestRunLogSeq({ runId: run.id }) };
      }
      const log = await readTranscriptLog({
        harness: session.harness,
        path: session.transcriptPath,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      });
      const liveCursor = ctx.bus.latestRunLogSeq({ runId: run.id });
      if (log.status !== 'available') return { ...log, liveCursor };
      // The JSONL is only the agent's side; fold in the operator's steer
      // messages (Harmonic's own run-events) so the transcript shows the
      // back-and-forth, not just the agent's turns.
      const operator: OperatorMessage[] = (await ctx.runs.listEvents(run.id)).flatMap((e) => {
        const p = e.payload as { event?: string; text?: unknown } | null;
        return (p?.event === 'steer_injected' || p?.event === 'steer_queued') && typeof p.text === 'string'
          ? [{ ts: e.ts, text: p.text, queued: p.event === 'steer_queued' }]
          : [];
      });
      return {
        status: 'available' as const,
        liveCursor,
        events: withOperatorMessages(log.events, operator).map((event) => ({ ...event, runId: run.id })),
      };
    },
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
    async (req) => ({ events: await ctx.runs.listEvents(req.params.id) }),
  );

  app.get(
    '/runs/:id/guardrail-events',
    {
      schema: {
        tags: ['Runs'],
        description: "Replay a run's Guardrail-trip event log, in sequence order (issue #171). Reachable with a run-scoped Run Key.",
        params: idParamsSchema,
        response: {
          200: guardrailEventsListResponseSchema.describe("The run's Guardrail-trip events in sequence order."),
          404: errorResponse('No run has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.runs.assertExists(req.params.id);
      return {
        guardrailEvents: (await ctx.guardrailEvents.list(req.params.id)).map((r) => ({
          ...r,
          payload: JSON.parse(r.payload) as unknown,
        })),
      };
    },
  );

  app.get(
    '/runs/:id/verification-attempts',
    {
      schema: {
        tags: ['Runs'],
        description:
          "Replay a run's verification-attempt log (per-verifier verdicts + summaries), in sequence order (issue #169, part of #109). Reachable with a run-scoped Run Key.",
        params: idParamsSchema,
        response: {
          200: verificationAttemptsListResponseSchema.describe("The run's verification attempts in sequence order."),
          404: errorResponse('No run has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.runs.assertExists(req.params.id);
      const attempts = await ctx.verificationAttempts.list(req.params.id);
      // The raw `transcriptPath`/`harness` columns stay server-only (an absolute
      // FS path is not the client's business); the response schema strips them
      // and the client reads the parsed log by attempt id when `hasTranscript`.
      return { verificationAttempts: attempts.map((a) => ({ ...a, hasTranscript: a.transcriptPath != null })) };
    },
  );

  app.get(
    '/verification-attempts/:id/log',
    {
      schema: {
        tags: ['Runs'],
        description:
          "Read a critic verification attempt's native harness transcript (ADR-0040) — what the critic itself read, ran, and reasoned. Missing or unreadable transcripts are explicitly unavailable.",
        params: idParamsSchema,
        response: {
          200: runLogResponseSchema.describe('The critic session transcript events, or an explicit unavailable state.'),
        },
      },
    },
    async (req) => {
      const attempt = await ctx.verificationAttempts.get(req.params.id);
      if (!attempt?.transcriptPath || !attempt.harness) return { status: 'unavailable' as const, liveCursor: 0 };
      // No Run window to bound against — a critic attempt has its own single-turn
      // transcript, so accept every event in the file.
      const log = await readTranscriptLog({
        harness: attempt.harness,
        path: attempt.transcriptPath,
        startedAt: 0,
        finishedAt: null,
      });
      return log.status === 'available'
        ? { ...log, liveCursor: 0, events: log.events.map((event) => ({ ...event, runId: attempt.runId })) }
        : { ...log, liveCursor: 0 };
    },
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
      await ctx.tasks.assertExists(req.params.id);
      const runs = await ctx.runs.listForTask(req.params.id);
      const usages = runs
        .map((run) => (run.usage ? (JSON.parse(run.usage) as RunUsage) : null))
        .filter((u): u is RunUsage => u !== null);
      return {
        ...(mergeUsage(usages) ?? { models: {}, totals: null, toolCalls: {}, source: null }),
        cost: costOfRuns(runs),
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
      const run = await ctx.runs.get(req.params.id);
      if (!run.branch || !run.baseBranch) return { branch: null, baseBranch: null, stat: null };
      // Prefer the settle-time snapshot so this endpoint and the board card can
      // never show two different stats (issue #36); only compute live for a run
      // that predates the snapshot column.
      const task = await ctx.tasks.get(run.taskId);
      const stat = run.stat ?? (await Git.diffStat(task.workingDir, run.baseBranch, run.branch));
      return { branch: run.branch, baseBranch: run.baseBranch, stat };
    },
  );

  app.get(
    '/runs/:id/diff/files',
    {
      schema: {
        tags: ['Runs'],
        description:
          'Per-file unified-diff hunks for the review pane (worktree-mode runs only). Empty `files` outside worktree mode or when the branch/worktree is gone. Reachable with a run-scoped Run Key.',
        params: idParamsSchema,
        response: { 200: diffFilesResponseSchema.describe("The run's changed files with parsed +/- hunks; empty outside worktree mode.") },
      },
    },
    async (req) => {
      const run = await ctx.runs.get(req.params.id);
      if (!run.branch || !run.baseBranch) return { files: [] };
      const task = await ctx.tasks.get(run.taskId);
      try {
        const raw = await Git.diffUnified(task.workingDir, run.baseBranch, run.branch);
        return { files: parseUnifiedDiff(raw) };
      } catch {
        // A missing worktree/branch (retired, direct-mode leftover) is "nothing
        // to diff", not a server error — mirror the empty-state contract.
        return { files: [] };
      }
    },
  );
}
