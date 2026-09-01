import type { AppContext } from './app.js';
import type { ScheduledJobSnapshot } from '../scheduler/scheduler.js';
import type { FlaggedWorktree } from '../domain/flagged-worktrees.js';
import type {
  AttemptRow,
  AttemptState,
  StepRow,
  StepType,
  ConversationRow,
  ConversationState,
  VerificationAttemptRow,
} from '../db/schema.js';
import { attempts, steps, guardrailEvents, attemptEvents, verificationAttempts } from '../db/schema.js';
import { and, desc, eq } from 'drizzle-orm';
import type { TaskWithDeps } from '../domain/tasks.js';
import type { Ticket } from '../tracker/adapter.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import { verifierStatuses, type VerifierStatus } from '../domain/verifier-status.js';
import { costOfUsages, resolveContextWindow, resolvePrices, sumCosts, type Cost } from '../execution/pricing.js';
import type { ProcessTree, AttemptUsage, AttemptUsageSnapshot } from '../execution/usage.js';
import { Git } from '../execution/git.js';
import type { OperationEvent, OperationSnapshot } from '../telemetry/operations.js';
import { z } from 'zod';
import { forEachYielding } from '../reliability/yield.js';

/**
 * API shapes for attempts and tasks, used by both the REST routes and the
 * WebSocket broadcasts so the SPA sees one format (issue 15). Settled Attempt
 * Costs are stored and frozen; only live Usage is priced on read.
 */

const parseUsage = (raw: string | null): AttemptUsage | null => (raw ? (JSON.parse(raw) as AttemptUsage) : null);
const parseCost = (raw: string | null): Cost | null => (raw ? (JSON.parse(raw) as Cost) : null);

const pricesOf = (ctx: AppContext) => resolvePrices(ctx.settingsStore.getGlobal().prices);

/** A Task/Conversation row's `workspaceId` is nullable only because SQLite
 * can't add it NOT NULL to an existing table (schema.ts) — every row has one
 * at rest, so every API-facing shape narrows it back to `number` here. */
export const atRestWorkspaceId = (workspaceId: number | null): number => workspaceId!;

/** Kept as an explicit serializer so REST and the firehose share one DTO seam. */
export const scheduledJobsToApi = (jobs: ScheduledJobSnapshot[]): ScheduledJobSnapshot[] => jobs;

/** Kept as an explicit serializer so REST and the firehose share one DTO seam. */
export const flaggedWorktreesToApi = (flags: readonly FlaggedWorktree[]): readonly FlaggedWorktree[] => flags;

export interface ApiStep {
  id: number;
  attemptId: number;
  type: StepRow['type'];
  position: number;
  state: StepRow['state'];
  command: string | null;
  verdict: string | null;
  logLocator: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface ApiAttempt {
  id: number;
  taskId: number;
  number: number;
  state: AttemptRow['state'];
  startedAt: number;
  endedAt: number | null;
  feedback: string | null;
  verifiedSha: string | null;
  escalationReason: string | null;
  continuation: z.infer<typeof attemptContinuationSchema> | null;
  verifierStatuses: VerifierStatus[];
  steps: ApiStep[];
}

const attemptContinuationSchema = z.object({
  path: z.enum(['continued-session', 'new-session-condensed']),
  reason: z.enum(['continued-within-limits', 'context-tokens', 'session-cold', 'missing-context-tokens', 'missing-warm-window']),
  contextTokens: z.number().nullable(),
  contextReuseTokenLimit: z.number(),
  lastActiveAt: z.number(),
  lastActiveAgeMs: z.number(),
  warmWindowMs: z.number().nullable(),
});

const continuationToApi = (raw: string | null) => raw ? attemptContinuationSchema.parse(JSON.parse(raw) as unknown) : null;

export interface ApiAttemptTimeline {
  attempts: ApiAttempt[];
  /** The attempt number the `maxAttempts` budget counts from (`AttemptStore.budgetBase`). */
  budgetBase: number;
}

const stepToApi = (step: StepRow): ApiStep => ({
  id: step.id,
  attemptId: step.attemptId,
  type: step.type,
  position: step.position,
  state: step.state,
  command: step.command,
  verdict: step.verdict,
  logLocator: step.logLocator,
  startedAt: step.startedAt,
  endedAt: step.endedAt,
});

/** The immutable branch tip an Attempt's verification proved: the latest
 * passing verification attempt's `inputOid` — verification's durable home is
 * `verification_attempts` (ADR-0001). Null when nothing passed. */
function verifiedShaOf(verificationAttempts: readonly VerificationAttemptRow[]): string | null {
  const passing = verificationAttempts.filter((v) => v.verdict === 'pass');
  return passing.length ? passing[passing.length - 1]!.inputOid : null;
}

/** One DTO builder for REST hydration and live timeline updates. */
export async function attemptTimelineToApi(ctx: AppContext, taskId: number): Promise<ApiAttemptTimeline> {
  const [task, rows, budgetBase] = await Promise.all([
    ctx.tasks.get(taskId),
    ctx.attempts.listForTask(taskId),
    ctx.attempts.budgetBase(taskId),
  ]);
  const workspace = await ctx.workspaces.get(atRestWorkspaceId(task.workspaceId));
  const configuredVerifiers = resolveVerifiers(workspace, ctx.settingsStore.getGlobal());
  return {
    budgetBase,
    attempts: await Promise.all(rows.map(async (attempt) => {
      const [stepRows, verificationAttempts] = await Promise.all([
        ctx.attempts.listSteps(attempt.id),
        ctx.verificationAttempts.list(attempt.id),
      ]);
      const stepType = [...stepRows].reverse().find((row) => row.state === 'running')?.type ?? null;
      // The Attempt's disposition-kind `reason` is the cheap audit hedge
      // (ADR-0001), not the free-text detail — that only survives
      // while the ticket is actually escalated, on `tasks.escalationReason`.
      const escalationReason = attempt.state === 'escalated' ? attempt.reason : null;
      return {
        id: attempt.id,
        taskId: attempt.taskId,
        number: attempt.number,
        state: attempt.state,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        feedback: attempt.feedback,
        verifiedSha: verifiedShaOf(verificationAttempts),
        escalationReason,
        continuation: continuationToApi(attempt.continuation),
        verifierStatuses: verifierStatuses({ verifiers: configuredVerifiers, attempts: verificationAttempts, stepType }),
        steps: stepRows.map(stepToApi),
      };
    })),
  };
}

/** The configured-or-recorded verifier rows for one Run's always-visible read model. */
export async function verifierStatusesToApi(
  ctx: AppContext,
  run: Pick<AttemptRow, 'id' | 'taskId' | 'number'>,
  recordedAttempts?: readonly VerificationAttemptRow[],
): Promise<VerifierStatus[]> {
  const task = await ctx.tasks.get(run.taskId);
  const workspace = await ctx.workspaces.get(atRestWorkspaceId(task.workspaceId));
  const listAttempts = async (): Promise<readonly VerificationAttemptRow[]> => {
    if (recordedAttempts) return recordedAttempts;
    const attempt = await ctx.attempts.getForTaskNumber(run.taskId, run.number);
    return attempt ? ctx.verificationAttempts.list(attempt.id) : [];
  };
  const [attempts, stepType] = await Promise.all([
    listAttempts(),
    ctx.attempts.currentStepType(run.taskId, run.number),
  ]);
  return verifierStatuses({ verifiers: resolveVerifiers(workspace, ctx.settingsStore.getGlobal()), attempts, stepType });
}

type TicketTimelineKind =
  | 'attempt-started'
  | 'attempt-finished'
  | 'lifecycle'
  | 'verification'
  | 'guardrail'
  | 'operator-reject'
  | 'fact';

export interface ApiTicketTimelineEvent {
  /** The Attempt this event pertains to, when there is one; null for a
   * source with no single owning Attempt. */
  attemptId: number | null;
  ts: number;
  kind: TicketTimelineKind;
  data: unknown;
}

type PendingTicketTimelineEvent = ApiTicketTimelineEvent & { order: number };

/**
 * Ticket-wide event projection for issue #328. Each persisted source is read
 * once for the ticket, then folded in memory. The fixed query count avoids a
 * per-Attempt and per-event read pattern that would starve the shared event loop.
 */
const TICKET_TIMELINE_SOURCE_LIMIT = 1_000;

export async function ticketTimelineToApi(ctx: AppContext, taskId: number): Promise<{ events: ApiTicketTimelineEvent[] }> {
  const [taskAttempts, lifecycle, verification, skippedVerification, guardrails] = await Promise.all([
    ctx.asyncDb.read((db) => db.select().from(attempts).where(eq(attempts.taskId, taskId)).orderBy(desc(attempts.startedAt), desc(attempts.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ event: attemptEvents }).from(attemptEvents).innerJoin(attempts, eq(attemptEvents.attemptId, attempts.id)).where(and(eq(attempts.taskId, taskId), eq(attemptEvents.type, 'lifecycle'))).orderBy(desc(attemptEvents.ts), desc(attemptEvents.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ attempt: verificationAttempts }).from(verificationAttempts).innerJoin(attempts, eq(verificationAttempts.attemptId, attempts.id)).where(eq(attempts.taskId, taskId)).orderBy(desc(verificationAttempts.ts), desc(verificationAttempts.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ step: steps }).from(steps).innerJoin(attempts, eq(steps.attemptId, attempts.id)).where(eq(attempts.taskId, taskId)).orderBy(desc(steps.endedAt), desc(steps.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ event: guardrailEvents }).from(guardrailEvents).innerJoin(attempts, eq(guardrailEvents.attemptId, attempts.id)).where(eq(attempts.taskId, taskId)).orderBy(desc(guardrailEvents.ts), desc(guardrailEvents.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
  ]);
  const task = await ctx.tasks.get(taskId);
  const workspace = await ctx.workspaces.get(atRestWorkspaceId(task.workspaceId));
  const configuredVerifiers = resolveVerifiers(workspace, ctx.settingsStore.getGlobal());
  const attemptsByNumber = new Map<number, AttemptRow>(taskAttempts.map((a) => [a.number, a]));
  const verificationByAttempt = new Map<number, VerificationAttemptRow[]>();
  for (const { attempt: v } of verification) {
    const rows = verificationByAttempt.get(v.attemptId) ?? [];
    rows.push(v);
    verificationByAttempt.set(v.attemptId, rows);
  }
  const pending: PendingTicketTimelineEvent[] = [];
  const add = (event: ApiTicketTimelineEvent, order: number) => pending.push({ ...event, order });

  await forEachYielding(taskAttempts, async (attempt) => {
    for (const status of verifierStatuses({ verifiers: configuredVerifiers, attempts: verificationByAttempt.get(attempt.id) ?? [] })) {
      if (status.state !== 'disabled') continue;
      add({
        attemptId: attempt.id,
        ts: attempt.endedAt ?? attempt.startedAt,
        kind: 'verification',
        data: { outcome: 'disabled', mechanism: status.mechanism, reason: status.reason, derived: true },
      }, 2);
    }
  });
  await forEachYielding(taskAttempts, async (attempt) => {
    add({ attemptId: attempt.id, ts: attempt.startedAt, kind: 'attempt-started', data: { attempt: attempt.number, state: attempt.state } }, 0);
    if (attempt.endedAt !== null) add({ attemptId: attempt.id, ts: attempt.endedAt, kind: 'attempt-finished', data: { attempt: attempt.number, state: attempt.state, feedback: attempt.feedback, reason: attempt.reason } }, 7);
  });
  await forEachYielding(taskAttempts, async (attempt) => {
    const rejected = attemptsByNumber.get(attempt.number - 1);
    if (rejected?.state === 'escalated' && rejected.feedback !== null) add({ attemptId: rejected.id, ts: attempt.startedAt, kind: 'operator-reject', data: { attempt: rejected.number, feedback: rejected.feedback } }, 4);
  });
  await forEachYielding(lifecycle, async ({ event }) => { add({ attemptId: event.attemptId, ts: event.ts, kind: 'lifecycle', data: { type: event.type, payload: JSON.parse(event.payload) } }, 3); });
  await forEachYielding(verification, async ({ attempt }) => { add({ attemptId: attempt.attemptId, ts: attempt.ts, kind: 'verification', data: { mechanism: attempt.mechanism, verdict: attempt.verdict, summary: attempt.summary, inputOid: attempt.inputOid } }, 2); });
  await forEachYielding(skippedVerification, async ({ step }) => {
    if (step.type !== 'verification' || step.state !== 'skipped' || step.endedAt === null) return;
    add({ attemptId: step.attemptId, ts: step.endedAt, kind: 'verification', data: { outcome: 'skipped', command: step.command, verdict: step.verdict } }, 2);
  });
  await forEachYielding(guardrails, async ({ event }) => { add({ attemptId: event.attemptId, ts: event.ts, kind: 'guardrail', data: { dimension: event.dimension, limitValue: event.limitValue, observedValue: event.observedValue, configSource: event.configSource, payload: JSON.parse(event.payload) } }, 2); });

  // The Task's own creation — the head of the lifecycle, before any Attempt.
  // `order: -1` seats it first even against an Attempt started at the same ms.
  add({ attemptId: null, ts: task.createdAt, kind: 'fact', data: { type: 'task-created', trackerRef: task.trackerRef != null ? String(task.trackerRef) : null, workspace: workspace?.name ?? null } }, -1);

  return {
    events: pending
      .sort((a, b) => a.ts - b.ts || a.order - b.order || (a.attemptId ?? 0) - (b.attemptId ?? 0))
      .map(({ order: _order, ...event }) => event),
  };
}

export interface ApiOperation {
  type: string;
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  attributes: Record<string, unknown>;
  startedAt: number;
  endedAt: number | null;
  status: { code: number; message: string | null };
  children: ApiOperation[];
}

export interface ApiOperationEvent {
  type: OperationEvent['type'];
  operation: ApiOperation;
}

function operationToApi(operation: OperationSnapshot): ApiOperation {
  return {
    type: operation.type,
    name: operation.name,
    traceId: operation.spanContext.traceId,
    spanId: operation.spanContext.spanId,
    parentSpanId: operation.parentSpanContext?.spanId ?? null,
    attributes: { ...operation.attributes },
    startedAt: operation.startedAt,
    endedAt: operation.endedAt ?? null,
    status: { code: operation.status.code, message: operation.status.message ?? null },
    children: [],
  };
}

/** Builds a stable forest from the registry's flat live-operation view. */
export function operationsToApi(operations: readonly OperationSnapshot[]): ApiOperation[] {
  const bySpanId = new Map(operations.map((operation) => {
    const api = operationToApi(operation);
    return [api.spanId, api] as const;
  }));
  const roots: ApiOperation[] = [];
  for (const operation of bySpanId.values()) {
    const parent = operation.parentSpanId ? bySpanId.get(operation.parentSpanId) : undefined;
    if (parent) parent.children.push(operation);
    else roots.push(operation);
  }
  return roots;
}

export const recentOperationsToApi = (operations: readonly OperationSnapshot[]): ApiOperation[] =>
  operations.map(operationToApi);

export const operationEventToApi = (event: OperationEvent): ApiOperationEvent => ({
  type: event.type,
  operation: operationToApi(event.operation),
});

/**
 * The public Attempt wire shape (ADR-0001, #390): `attemptToApi` translates an
 * `AttemptRow` onto it rather than exposing the row raw — `finishedAt` and the
 * 4-value `state` are deliberate projections, not column dumps.
 */
export type ApiAttemptSummary = {
  id: number;
  taskId: number;
  number: number;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  reason: string | null;
  stopReason: string | null;
  sessionId: string | null;
  sessionRowId: number | null;
  prompt: string | null;
  branch: string | null;
  baseBranch: string | null;
  diffBaseOid: string | null;
  diffHeadOid: string | null;
  stat: string | null;
  verifiedHeadOid: string | null;
  verifiedRef: string | null;
  usage: AttemptUsage | null;
  cost: Cost | null;
  /** Total tool calls this Attempt's session made (ADR-0031 native aggregate) —
   * the Stats summary card sums it across Attempts; the Attempt panel shows the
   * one Attempt's. */
  toolCalls: number;
  startedAt: number;
  finishedAt: number | null;
};

/** An Attempt's `state` collapsed onto the 4-value wire vocabulary: `passed`
 * reads as `completed`, and `escalated` reads as the generic `failed` — the
 * escalation itself is Task state, not a fifth execution outcome. */
function apiAttemptState(state: AttemptState): ApiAttemptSummary['state'] {
  if (state === 'passed') return 'completed';
  if (state === 'escalated') return 'failed';
  return state;
}

export async function attemptToApi(ctx: AppContext, run: AttemptRow): Promise<ApiAttemptSummary> {
  // The per-Attempt tool-call total from its native aggregate (ADR-0031) — one
  // bounded read per Attempt (attempts-per-Task is small), no event replay.
  const toolTotals = await ctx.attempts.listToolCalls(run.id);
  let toolCalls = 0;
  for (const total of toolTotals.values()) toolCalls += total;
  return {
    id: run.id,
    taskId: run.taskId,
    number: run.number,
    state: apiAttemptState(run.state),
    // The wire `reason` is the free-text detail (`runs.reason` before the
    // fold) — `attempts.detail` now — falling back to the structured
    // disposition kind (`attempts.reason`) when a disposition carries no
    // extra detail beyond its kind (e.g. plain `process-death`).
    reason: run.detail ?? run.reason,
    stopReason: run.stopReason,
    sessionId: run.sessionId,
    sessionRowId: run.sessionRowId,
    prompt: run.prompt,
    branch: run.branch,
    baseBranch: run.baseBranch,
    diffBaseOid: run.diffBaseOid,
    diffHeadOid: run.diffHeadOid,
    stat: run.stat,
    verifiedHeadOid: run.verifiedHeadOid,
    verifiedRef: run.verifiedRef,
    usage: parseUsage(run.usage),
    cost: parseCost(run.cost),
    toolCalls,
    startedAt: run.startedAt,
    finishedAt: run.endedAt,
  };
}

/** The firehose shape of a live-usage snapshot (ADR 0010): the persisted
 * snapshot plus Cost derived from its Usage on read, like every other Cost. */
export type ApiAttemptUsage = AttemptUsageSnapshot & { cost: Cost | null };

export function attemptUsageToApi(ctx: AppContext, snapshot: AttemptUsageSnapshot): ApiAttemptUsage {
  return { ...snapshot, cost: costOfUsages([snapshot.usage], pricesOf(ctx)) };
}

/** The durable tracker-fact columns (issue #233) are server-side persistence
 * only — write-only, no consumer reads them yet — so they never enter the API
 * shape. Omitting them here keeps the WS broadcast and the zod-validated REST
 * response identical (streaming.test.ts parity). */
type TrackerFactColumns =
  | 'trackerState'
  | 'trackerParent'
  | 'trackerBlockedBy'
  | 'trackerLabels'
  | 'trackerTitle'
  | 'trackerBody'
  | 'trackerUrl'
  | 'trackerCreatedAt';

export type ApiTask = Omit<TaskWithDeps, 'workspaceId' | TrackerFactColumns> & {
  workspaceId: number;
  /** The prompt's first line, bounded (ADR-0045): the card title every list
   * surface renders. Present on both the list rows and the item GET; the full
   * `prompt` is served only on the item GET (and the WS `task_changed`), never
   * on a list row (issue #350). */
  summary: string;
  cost: Cost | null;
  /** The mirrored issue's tracker URL, from the last poll's scan; null on native Tasks or before a poll (issue #35). */
  url: string | null;
  /** The parent Map's title, resolved from mapRef against the last poll's scan; null when unmapped or before a poll (issue #34). */
  mapTitle: string | null;
  /** The latest run's branch (worktree mode only); null in direct mode or before any run. */
  branch: string | null;
  /** The latest run's `git diff --stat`, snapshotted at settle; null until then or in direct mode. */
  stat: string | null;
  /** The running run's `startedAt`; null unless the Task is running — the board card's live elapsed figure (issue #100). */
  runStartedAt: number | null;
  /** Total tool-call count of the running run; null unless the Task is running — the board card's "· N tools" (issue #100). */
  toolCount: number | null;
  /** The running run's id, so the board can match the `attempt_usage` firehose to this card; null unless the Task is running (issue #100). */
  attemptId: number | null;
  /** The running run's current Attempt Step (ADR-0001 Vocabulary), for the
   * Board's Active-card badge; null unless the Task is running, or between
   * Steps (e.g. mid-merge). */
  currentStep: StepType | null;
  /** The running run's current context-window occupancy in tokens; null unless running (or unreported). Live via the `attempt_usage` firehose (issue #52). */
  contextTokens: number | null;
  /** The model's effective context window (config override, else shipped default); null when unknown. The board card shows `ctx %` = contextTokens/contextWindow — never a fabricated percentage (issue #52). */
  contextWindow: number | null;
  /** The current scheduler reason this Task was not picked for, such as a
   * dependency, capacity, disabled Workspace, or missing integration branch;
   * null when it is not waiting (issue #238). */
  skipReason: string | null;
  /** The latest attempt's verified-head ref; null
   * when no attempt has produced one yet (pre-feature, escalated before
   * `validating`, or a dirty direct-mode context). Surfaced so an escalated
   * Task's stranded verified head can be adopted for review, or re-reviewed with
   * an operator note, without a fresh builder run (issue #191). */
  verifiedRef: string | null;
  /** Whether the branch holds a candidate (commits ahead of base) an Accept
   * could merge (issue #429): true once `verifiedRef` is set, or — for an
   * escalated worktree Task that never reached verification (a
   * guardrail/infra escalation) — once its branch actually has commits ahead
   * of its base. */
  hasCandidate: boolean;
};

/** A lean list row (ADR-0045, issue #350): every {@link ApiTask} field except
 * the full `prompt`, which is dropped to keep the payload small — list surfaces
 * render {@link ApiTask.summary} instead. The full prompt stays on the item GET. */
export type ApiTaskListRow = Omit<ApiTask, 'prompt'>;

/** Longest a list-row {@link ApiTask.summary} may be; a longer first line is
 * truncated with an ellipsis so the payload stays lean (ADR-0045). */
const SUMMARY_MAX = 200;

/** The card title a list surface renders: the prompt's first non-empty line,
 * bounded to {@link SUMMARY_MAX}. */
export function summarize(prompt: string): string {
  const firstLine = prompt.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
  return firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX - 1)}…` : firstLine;
}

/** A task's Cost sums ALL its runs — retries and failed attempts included. */
export async function taskToApi(ctx: AppContext, task: TaskWithDeps): Promise<ApiTask> {
  const runs = await ctx.attempts.listForTask(task.id);
  const running = task.state === 'working' ? runs.find((r) => r.state === 'running') : undefined;
  const currentStep = running ? await ctx.attempts.currentStepType(task.id, running.number) : null;
  const hasCandidate = await hasCandidateFor(task, runs.at(-1));
  return taskToApiWithRuns(ctx, task, runs, running ? await runningToolCount(ctx, running) : null, currentStep, hasCandidate);
}

/** Serialize a task list from its already-batched Runs (issue #258). The rows
 * are lean (ADR-0045, issue #350): the full `prompt` is dropped in favour of
 * `summary`, so no list surface carries the whole prompt. */
export async function tasksToApi(ctx: AppContext, tasks: TaskWithDeps[]): Promise<ApiTaskListRow[]> {
  if (tasks.length === 0) return [];
  const runsByTask = new Map(tasks.map((task) => [task.id, [] as AttemptRow[]]));
  for (const run of await ctx.attempts.listForTasks(tasks.map((task) => task.id))) runsByTask.get(run.taskId)?.push(run);
  const running = tasks.flatMap((task) => {
    const run = task.state === 'working' ? runsByTask.get(task.id)?.find((candidate) => candidate.state === 'running') : undefined;
    return run ? [run] : [];
  });
  // `attempt_tool_calls` is keyed off `attempt_id`: resolve each running
  // Task's current Attempt id first, then batch the tool-call totals by
  // Attempt — `toolCountByTask` re-keys the result back onto the Task id every
  // list-row render already has to hand.
  const attemptIdByTask = await ctx.attempts.idsFor(running.map((run) => ({ taskId: run.taskId, number: run.number })));
  const [toolCountsByAttempt, currentSteps, hasCandidates] = await Promise.all([
    ctx.attempts.toolCallCounts([...attemptIdByTask.values()]),
    ctx.attempts.currentStepTypes(running.map((run) => ({ taskId: run.taskId, number: run.number }))),
    Promise.all(tasks.map((task) => hasCandidateFor(task, (runsByTask.get(task.id) ?? []).at(-1)))),
  ]);
  return tasks.map((task, i) => {
    const runs = runsByTask.get(task.id) ?? [];
    const activeRun = task.state === 'working' ? runs.find((run) => run.state === 'running') : undefined;
    const activeAttemptId = activeRun ? attemptIdByTask.get(task.id) : undefined;
    return toListRow(taskToApiWithRuns(
      ctx,
      task,
      runs,
      activeRun ? (activeAttemptId != null ? toolCountsByAttempt.get(activeAttemptId) ?? 0 : 0) : null,
      activeRun ? currentSteps.get(task.id) ?? null : null,
      hasCandidates[i]!,
    ));
  });
}

/** Drop the full `prompt` from a serialized task to make a lean list row
 * (issue #350); `summary` already carries the card title every list surface needs. */
function toListRow({ prompt: _prompt, ...row }: ApiTask): ApiTaskListRow {
  return row;
}

/**
 * Project a top-level Epic's container ticket (ADR-0016) into a Tasks-list row
 * so the list can surface epics from the derived-epic model rather than a
 * mirrored `isEpic` task row. An Epic is a container, never a runnable Task, so
 * every task-only field is a neutral placeholder the epic-format row does not
 * render (`isEpic` rows drop harness/model/state/priority/cost in the table);
 * only the identity a list surface reads — ref, title, url, and the ticket's
 * created timestamp — carries real data.
 */
export function epicToListRow(ticket: Ticket, workspaceId: number): ApiTaskListRow {
  const created = Date.parse(ticket.createdAt) || 0;
  return {
    id: ticket.number,
    workspaceId,
    harness: '',
    model: '',
    workingDir: '',
    isolationMode: 'worktree',
    baseBranch: null,
    priority: 'normal',
    conflictResolveTurns: 0,
    state: 'ready',
    escalationReason: null,
    feedback: null,
    continuationChoice: null,
    origin: 'mirrored',
    trackerRef: ticket.number,
    workflow: null,
    wayfinderType: null,
    mapRef: null,
    createdAt: created,
    updatedAt: created,
    dependsOn: [],
    dependents: [],
    blockedOnFailed: false,
    openBlockerCount: 0,
    agentWorkable: false,
    humanOnly: true,
    isEpic: true,
    overrides: { harness: null, model: null, isolationMode: null, priority: null, conflictResolveTurns: null },
    summary: ticket.title,
    cost: null,
    url: ticket.url,
    mapTitle: null,
    branch: null,
    stat: null,
    runStartedAt: null,
    toolCount: null,
    attemptId: null,
    currentStep: null,
    contextTokens: null,
    contextWindow: null,
    skipReason: null,
    verifiedRef: null,
    hasCandidate: false,
  };
}

/** Peel the durable tracker-fact columns (issue #233) off a task: they are
 * server-side persistence only, so they never enter the API shape — dropping
 * them keeps the WS broadcast and the zod-validated REST response identical
 * (streaming.test.ts parity). */
function stripTrackerFactCols(task: TaskWithDeps): Omit<TaskWithDeps, TrackerFactColumns> {
  const {
    trackerState, trackerParent, trackerBlockedBy, trackerLabels,
    trackerTitle, trackerBody, trackerUrl, trackerCreatedAt,
    ...rest
  } = task;
  return rest;
}

/** The ref an operator Accept would merge: a worktree Run's branch once it has a
 * verified head. A direct Run has no branch — its work is already on the base
 * branch (ADR-0046) — so this is null for it. */
function latestVerifiedRef(run: AttemptRow | undefined): string | null {
  if (!run) return null;
  return run.verifiedRef ?? (run.verifiedHeadOid && run.branch ? run.branch : null);
}

/** Whether an Accept has a candidate to merge (issue #429): true once
 * `latestVerifiedRef` is set (the common, already-verified case), or — for an
 * escalated worktree Task that never reached verification (a guardrail/infra
 * escalation, e.g. tasks 410/411) — once its branch actually has commits
 * ahead of its base. That git call is scoped to escalated worktree Tasks only
 * (cheap: escalated Tasks are few) so every other Task resolves with no I/O. */
async function hasCandidateFor(task: TaskWithDeps, lastRun: AttemptRow | undefined): Promise<boolean> {
  let hasCandidate = latestVerifiedRef(lastRun) !== null;
  if (!hasCandidate && task.state === 'escalated' && task.isolationMode === 'worktree' && lastRun?.branch && lastRun?.baseBranch) {
    hasCandidate = (await Git.commitsAhead(task.workingDir, lastRun.baseBranch, lastRun.branch)) > 0;
  }
  return hasCandidate;
}

function taskToApiWithRuns(
  ctx: AppContext,
  task: TaskWithDeps,
  runs: AttemptRow[],
  toolCount: number | null,
  currentStep: StepType | null,
  hasCandidate: boolean,
): ApiTask {
  const running = runs.find((r) => r.state === 'running');
  // A direct Run has no branch (its work is committed straight onto the base
  // branch, ADR-0046); only a worktree Run has an operator-facing branch.
  const presentedBranch = (branch: string | null | undefined): string | null => branch ?? null;
  return {
    ...stripTrackerFactCols(task),
    workspaceId: atRestWorkspaceId(task.workspaceId),
    summary: summarize(task.prompt),
    cost: sumCosts(runs.map((run) => parseCost(run.cost))),
    url: ctx.trackerManager.urlFor(task.workspaceId, task.trackerRef),
    mapTitle: ctx.trackerManager.titleForMap(task.workspaceId, task.mapRef),
    branch: presentedBranch(runs.at(-1)?.branch),
    stat: runs.at(-1)?.stat ?? null,
    runStartedAt: running?.startedAt ?? null,
    toolCount,
    attemptId: running?.id ?? null,
    currentStep,
    contextTokens: running ? (parseUsage(running.usage)?.contextTokens ?? null) : null,
    contextWindow: contextWindowOf(ctx, task.model),
    skipReason: ctx.autoRunner.skipReasonFor(task.id) ?? null,
    verifiedRef: latestVerifiedRef(runs.at(-1)),
    hasCandidate,
  };
}

/** Total tool calls of a running Attempt from its native aggregate (ADR-0031). */
async function runningToolCount(ctx: AppContext, run: AttemptRow): Promise<number> {
  const attempt = await ctx.attempts.getForTaskNumber(run.taskId, run.number);
  if (!attempt) return 0;
  const totals = await ctx.attempts.listToolCalls(attempt.id);
  let count = 0;
  for (const total of totals.values()) count += total;
  return count;
}

/** Cost of an arbitrary set of Runs, summed from their frozen values. */
export function costOfAttempts(runs: AttemptRow[]): Cost | null {
  return sumCosts(runs.map((run) => parseCost(run.cost)));
}

/** One live process in the Activity snapshot (issue #51); see `activitySnapshot`. */
export interface ApiActivityProcess {
  type: 'attempt' | 'chat';
  /** The Run's id (type `run`), else null. */
  attemptId: number | null;
  /** The Conversation's id (type `chat`), else null. */
  conversationId: number | null;
  /** The owning Task's id (type `run`), else null. */
  taskId: number | null;
  /** The process's display title: a Run's Task prompt first line, a Conversation's title (issue #52). */
  title: string;
  workspaceId: number;
  /** The owning Workspace's name — the Activity view spans Workspaces, so each row names its own (issue #52). */
  workspaceName: string;
  harness: string;
  model: string;
  /** A running Run's AttemptState, or a warm Conversation's ConversationState. */
  state: AttemptState | ConversationState;
  /** Isolation Mode: `worktree`/`direct` for a Run; always `direct` for a Conversation (ADR-0006). */
  isolation: string;
  /** Epoch ms the process started; the client derives elapsed from it. */
  startedAt: number;
  /** The mirrored issue's tracker ref (a Run's Task); null on native Tasks and Conversations. */
  trackerRef: number | null;
  /** The mirrored issue's tracker URL — the Activity row's ticket deep-link (issue #55); null on native Tasks, Conversations, or before a poll. */
  trackerUrl: string | null;
  /** True when the Task is escalated — the Activity view's "Needs you" signal; always false for a Conversation. */
  escalated: boolean;
  usage: AttemptUsage | null;
  contextTokens: number | null;
  /** The model's configured context window; null when unconfigured — the context gauge shows raw tokens, never a fabricated percentage (issue #52). */
  contextWindow: number | null;
  /** One-line current-activity (Runs only); null for a Conversation. */
  activity: string | null;
  /** The process's Process Tree (Runs only); null for a Conversation. */
  tree: ProcessTree | null;
  cost: Cost | null;
}

/**
 * The instance-wide Activity snapshot (issue #51, ADR 0010): every live
 * process across Workspaces. Runs come from the persisted capacity set, then
 * join a Runner snapshot when one is live, so a wedged Run remains visible even
 * after it has left the in-memory registry. A Run carries its live-usage
 * snapshot — rolled-up Usage, context fill, current-activity line, Process
 * Tree — with Cost derived on read like every other Cost. A Conversation has no
 * live tailer, so its `tree`/`activity` are null and its Usage/context come from
 * the Conversation row. `includeChats` is false for a Read Key (a read-scoped
 * viz client): Runs only, mirroring the firehose filter that hides Conversation
 * traffic from Read Keys.
 */
export async function activitySnapshot(ctx: AppContext, includeChats: boolean): Promise<ApiActivityProcess[]> {
  const prices = pricesOf(ctx);
  const snapshots = new Map((await ctx.runner.activeSnapshots()).map((snapshot) => [snapshot.attemptId, snapshot.snapshot]));
  const runs: ApiActivityProcess[] = await Promise.all((await ctx.attempts.listRunning()).map(async (run) => {
    const task = await ctx.tasks.get(run.taskId);
    const snapshot = snapshots.get(run.id) ?? null;
    return {
      type: 'attempt',
      attemptId: run.id,
      conversationId: null,
      taskId: run.taskId,
      title: firstLineTitle(task.prompt) ?? `Task ${run.taskId}`,
      workspaceId: atRestWorkspaceId(task.workspaceId),
      workspaceName: await workspaceNameOf(ctx, task.workspaceId),
      harness: task.harness,
      model: task.model,
      state: run.state,
      isolation: task.isolationMode,
      startedAt: run.startedAt,
      trackerRef: task.trackerRef,
      trackerUrl: ctx.trackerManager.urlFor(task.workspaceId, task.trackerRef),
      escalated: task.state === 'escalated',
      usage: snapshot?.usage ?? null,
      contextTokens: snapshot?.contextTokens ?? null,
      contextWindow: contextWindowOf(ctx, task.model),
      activity: snapshot?.activity ?? null,
      tree: snapshot?.tree ?? null,
      cost: snapshot ? costOfUsages([snapshot.usage], prices) : null,
    };
  }));
  if (!includeChats) return runs;
  const chats: ApiActivityProcess[] = await Promise.all(ctx.conversationDriver.activeConversationIds().map(async (id) => {
    const convo = await ctx.conversations.get(id);
    const usage = parseUsage(convo.usage);
    return {
      type: 'chat',
      attemptId: null,
      conversationId: id,
      taskId: null,
      title: convo.title ?? firstLineTitle(await ctx.conversations.firstTurnText(id)) ?? `Conversation #${id}`,
      workspaceId: atRestWorkspaceId(convo.workspaceId),
      workspaceName: await workspaceNameOf(ctx, convo.workspaceId),
      harness: convo.harness,
      model: convo.model,
      state: convo.state,
      isolation: 'direct',
      startedAt: convo.createdAt,
      trackerRef: null,
      trackerUrl: null,
      escalated: false,
      usage,
      contextTokens: convo.contextTokens,
      contextWindow: contextWindowOf(ctx, convo.model),
      activity: null,
      tree: null,
      cost: costOfUsages([usage], prices),
    };
  }));
  return [...runs, ...chats];
}

/** The Workspace's name for an at-rest workspaceId — every live process names its own Workspace (issue #52). */
async function workspaceNameOf(ctx: AppContext, workspaceId: number | null): Promise<string> {
  return (await ctx.workspaces.get(atRestWorkspaceId(workspaceId))).name;
}

/** A model's effective context window: config override, then the shipped
 * default (`DEFAULT_CONTEXT_WINDOWS`); null when neither knows the model — the
 * gauge then shows raw tokens, never a fabricated percentage (issue #52). */
function contextWindowOf(ctx: AppContext, model: string): number | null {
  return resolveContextWindow(model, ctx.settingsStore.getGlobal().modelInfo);
}

export type ApiConversation = Omit<ConversationRow, 'usage' | 'workspaceId'> & {
  workspaceId: number;
  /** Running Usage accumulated across Turns (issue 12); null before any usage. */
  usage: AttemptUsage | null;
  /** Cost of the running Usage against the live price table; honest-incomplete. */
  cost: Cost | null;
  /** The latest Turn's input-side token footprint (context fill); null when unknown. */
  contextTokens: number | null;
  /** The model's configured context window; null when unconfigured (percentage suppressed). */
  contextWindow: number | null;
  /** The model's configured cache TTL in seconds; null when unconfigured (cold-cache banner suppressed). */
  cacheTtlSeconds: number | null;
};

/** The display title: the operator's title, else derived from the first Turn's first non-empty line (issue 15). */
const DERIVED_TITLE_MAX = 80;

/** First non-empty line of `text`, clamped to `DERIVED_TITLE_MAX` with an ellipsis; null when blank. Shared by the
 * Conversation title fallback (issue 15) and the Activity view's per-process title (issue #52). */
export function firstLineTitle(text: string | null): string | null {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim();
  if (!line) return null;
  return line.length > DERIVED_TITLE_MAX ? `${line.slice(0, DERIVED_TITLE_MAX - 1).trimEnd()}…` : line;
}

function deriveConversationTitle(firstTurnText: string | null): string | null {
  return firstLineTitle(firstTurnText);
}

/**
 * A Conversation as the REST API and firehose both serve it — one format for
 * the SPA. Running Usage/Cost are derived on read (issue 12), the title falls
 * back to one derived from the first Turn (issue 15), and the context-window
 * / cache-TTL facts come from optional per-model config; honest degradation
 * when unconfigured (null, never a fake percentage).
 */
export async function conversationToApi(ctx: AppContext, conversation: ConversationRow): Promise<ApiConversation> {
  const { usage: rawUsage, ...rest } = conversation;
  const usage = parseUsage(rawUsage);
  const config = ctx.settingsStore.getGlobal();
  const modelInfo = config.modelInfo[conversation.model] ?? config.modelInfo[conversation.model.replace(/-\d{8}$/, '')];
  return {
    ...rest,
    workspaceId: atRestWorkspaceId(conversation.workspaceId),
    title: conversation.title ?? deriveConversationTitle(await ctx.conversations.firstTurnText(conversation.id)),
    usage,
    cost: costOfUsages([usage], pricesOf(ctx)),
    contextTokens: conversation.contextTokens,
    contextWindow: modelInfo?.contextWindow ?? null,
    cacheTtlSeconds: modelInfo?.cacheTtlSeconds ?? null,
  };
}
