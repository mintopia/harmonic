import type { AppContext } from './app.js';
import type { ScheduledJobSnapshot } from '../scheduler/scheduler.js';
import type {
  AttemptRow,
  AttemptTaskRow,
  ConversationRow,
  ConversationState,
  RunRow,
  RunState,
  VerificationAttemptRow,
} from '../db/schema.js';
import { attempts, attemptTasks, guardrailEvents, landingJournal, runEvents, runFacts, runs, verificationAttempts } from '../db/schema.js';
import { and, desc, eq } from 'drizzle-orm';
import type { TaskWithDeps } from '../domain/tasks.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import { verifierStatuses, type VerifierStatus } from '../domain/verifier-status.js';
import { costOfUsages, resolveContextWindow, resolvePrices, sumCosts, type Cost } from '../execution/pricing.js';
import type { ProcessTree, RunUsage, RunUsageSnapshot } from '../execution/usage.js';
import type { OperationEvent, OperationSnapshot } from '../telemetry/operations.js';
import { z } from 'zod';
import { forEachYielding } from '../reliability/yield.js';

/**
 * API shapes for runs and tasks, used by both the REST routes and the
 * WebSocket broadcasts so the SPA sees one format (issue 15). Settled Run
 * Costs are stored and frozen; only live Usage is priced on read.
 */

const parseUsage = (raw: string | null): RunUsage | null => (raw ? (JSON.parse(raw) as RunUsage) : null);
const parseCost = (raw: string | null): Cost | null => (raw ? (JSON.parse(raw) as Cost) : null);

const pricesOf = (ctx: AppContext) => resolvePrices(ctx.configStore.get().prices);

/** A Task/Conversation row's `workspaceId` is nullable only because SQLite
 * can't add it NOT NULL to an existing table (schema.ts) — every row has one
 * at rest, so every API-facing shape narrows it back to `number` here. */
export const atRestWorkspaceId = (workspaceId: number | null): number => workspaceId!;

/** Kept as an explicit serializer so REST and the firehose share one DTO seam. */
export const scheduledJobsToApi = (jobs: ScheduledJobSnapshot[]): ScheduledJobSnapshot[] => jobs;

export interface ApiAttemptTask {
  id: number;
  attemptId: number;
  type: AttemptTaskRow['type'];
  position: number;
  state: AttemptTaskRow['state'];
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
  tasks: ApiAttemptTask[];
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

const attemptTaskToApi = (task: AttemptTaskRow): ApiAttemptTask => ({
  id: task.id,
  attemptId: task.attemptId,
  type: task.type,
  position: task.position,
  state: task.state,
  command: task.command,
  verdict: task.verdict,
  logLocator: task.logLocator,
  startedAt: task.startedAt,
  endedAt: task.endedAt,
});

/** One DTO builder for REST hydration and live timeline updates. */
export async function attemptTimelineToApi(ctx: AppContext, taskId: number): Promise<ApiAttemptTimeline> {
  const [task, rows, budgetBase, taskRuns] = await Promise.all([
    ctx.tasks.get(taskId),
    ctx.attempts.listForTask(taskId),
    ctx.attempts.budgetBase(taskId),
    ctx.runs.listForTask(taskId),
  ]);
  const workspace = await ctx.workspaces.get(atRestWorkspaceId(task.workspaceId));
  const configuredVerifiers = resolveVerifiers(workspace, ctx.configStore.get());
  const runsByAttempt = new Map(taskRuns.map((run) => [run.attempt, run]));
  return {
    budgetBase,
    attempts: await Promise.all(rows.map(async (attempt) => {
      const run = runsByAttempt.get(attempt.number);
      const [tasks, verifiedSha, escalationReason, verificationAttempts] = await Promise.all([
        ctx.attempts.listTasks(attempt.id),
        ctx.attempts.verifiedSha(attempt.id),
        ctx.attempts.escalationReason(attempt.id),
        run ? ctx.verificationAttempts.list(run.id) : [],
      ]);
      return {
        id: attempt.id,
        taskId: attempt.taskId,
        number: attempt.number,
        state: attempt.state,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        feedback: attempt.feedback,
        verifiedSha,
        escalationReason,
        continuation: continuationToApi(attempt.continuation),
        verifierStatuses: verifierStatuses({ verifiers: configuredVerifiers, attempts: verificationAttempts }),
        tasks: tasks.map(attemptTaskToApi),
      };
    })),
  };
}

/** The configured-or-recorded verifier rows for one Run's always-visible read model. */
export async function verifierStatusesToApi(
  ctx: AppContext,
  run: Pick<RunRow, 'id' | 'taskId'>,
  recordedAttempts?: readonly VerificationAttemptRow[],
): Promise<VerifierStatus[]> {
  const task = await ctx.tasks.get(run.taskId);
  const workspace = await ctx.workspaces.get(atRestWorkspaceId(task.workspaceId));
  const attempts = recordedAttempts ?? await ctx.verificationAttempts.list(run.id);
  return verifierStatuses({ verifiers: resolveVerifiers(workspace, ctx.configStore.get()), attempts });
}

type TicketTimelineKind =
  | 'attempt-started'
  | 'attempt-finished'
  | 'run-started'
  | 'run-finished'
  | 'lifecycle'
  | 'verification'
  | 'guardrail'
  | 'escalation'
  | 'operator-accept'
  | 'operator-reject'
  | 'landing'
  | 'fact';

export interface ApiTicketTimelineEvent {
  runId: number | null;
  ts: number;
  kind: TicketTimelineKind;
  data: unknown;
}

type PendingTicketTimelineEvent = ApiTicketTimelineEvent & { order: number };

/**
 * Ticket-wide event projection for issue #328. Each persisted source is read
 * once for the ticket, then folded in memory. The fixed query count avoids the
 * per-Run and per-event read pattern that would starve the shared event loop.
 */
const TICKET_TIMELINE_SOURCE_LIMIT = 1_000;

export async function ticketTimelineToApi(ctx: AppContext, taskId: number): Promise<{ events: ApiTicketTimelineEvent[] }> {
  const [taskRuns, taskAttempts, lifecycle, verification, skippedVerification, guardrails, facts, landing] = await Promise.all([
    ctx.asyncDb.read((db) => db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.startedAt), desc(runs.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select().from(attempts).where(eq(attempts.taskId, taskId)).orderBy(desc(attempts.startedAt), desc(attempts.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ event: runEvents }).from(runEvents).innerJoin(runs, eq(runEvents.runId, runs.id)).where(and(eq(runs.taskId, taskId), eq(runEvents.type, 'lifecycle'))).orderBy(desc(runEvents.ts), desc(runEvents.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ attempt: verificationAttempts }).from(verificationAttempts).innerJoin(runs, eq(verificationAttempts.runId, runs.id)).where(eq(runs.taskId, taskId)).orderBy(desc(verificationAttempts.ts), desc(verificationAttempts.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ task: attemptTasks }).from(attemptTasks).innerJoin(attempts, eq(attemptTasks.attemptId, attempts.id)).where(eq(attempts.taskId, taskId)).orderBy(desc(attemptTasks.endedAt), desc(attemptTasks.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ event: guardrailEvents }).from(guardrailEvents).innerJoin(runs, eq(guardrailEvents.runId, runs.id)).where(eq(runs.taskId, taskId)).orderBy(desc(guardrailEvents.ts), desc(guardrailEvents.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ fact: runFacts }).from(runFacts).innerJoin(runs, eq(runFacts.runId, runs.id)).where(eq(runs.taskId, taskId)).orderBy(desc(runFacts.ts), desc(runFacts.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ entry: landingJournal }).from(landingJournal).innerJoin(runs, eq(landingJournal.runId, runs.id)).where(eq(runs.taskId, taskId)).orderBy(desc(landingJournal.ts), desc(landingJournal.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
  ]);
  const task = await ctx.tasks.get(taskId);
  const workspace = await ctx.workspaces.get(atRestWorkspaceId(task.workspaceId));
  const configuredVerifiers = resolveVerifiers(workspace, ctx.configStore.get());
  const verificationByRun = new Map<number, VerificationAttemptRow[]>();
  for (const { attempt } of verification) {
    const rows = verificationByRun.get(attempt.runId) ?? [];
    rows.push(attempt);
    verificationByRun.set(attempt.runId, rows);
  }
  const pending: PendingTicketTimelineEvent[] = [];
  const attemptsByNumber = new Map<number, AttemptRow>();
  const add = (event: ApiTicketTimelineEvent, order: number) => pending.push({ ...event, order });

  await forEachYielding(taskRuns, async (run) => {
    add({ runId: run.id, ts: run.startedAt, kind: 'run-started', data: { attempt: run.attempt, state: run.state, phase: run.phase } }, 0);
    for (const status of verifierStatuses({ verifiers: configuredVerifiers, attempts: verificationByRun.get(run.id) ?? [] })) {
      if (status.state !== 'disabled') continue;
      add({
        runId: run.id,
        ts: run.finishedAt ?? run.startedAt,
        kind: 'verification',
        data: { outcome: 'disabled', mechanism: status.mechanism, reason: status.reason, derived: true },
      }, 2);
    }
    if (run.finishedAt !== null) add({ runId: run.id, ts: run.finishedAt, kind: 'run-finished', data: { attempt: run.attempt, state: run.state, phase: run.phase, reason: run.reason } }, 7);
  });
  await forEachYielding(taskAttempts, async (attempt) => {
    attemptsByNumber.set(attempt.number, attempt);
    add({ runId: null, ts: attempt.startedAt, kind: 'attempt-started', data: { attempt: attempt.number, state: attempt.state } }, 0);
    if (attempt.endedAt !== null) add({ runId: null, ts: attempt.endedAt, kind: 'attempt-finished', data: { attempt: attempt.number, state: attempt.state, feedback: attempt.feedback } }, 7);
  });
  await forEachYielding(taskAttempts, async (attempt) => {
    const rejected = attemptsByNumber.get(attempt.number - 1);
    if (rejected?.state === 'escalated' && rejected.feedback !== null) add({ runId: null, ts: attempt.startedAt, kind: 'operator-reject', data: { attempt: rejected.number, feedback: rejected.feedback } }, 4);
  });
  await forEachYielding(lifecycle, async ({ event }) => { add({ runId: event.runId, ts: event.ts, kind: 'lifecycle', data: { type: event.type, payload: JSON.parse(event.payload) } }, 3); });
  await forEachYielding(verification, async ({ attempt }) => { add({ runId: attempt.runId, ts: attempt.ts, kind: 'verification', data: { mechanism: attempt.mechanism, verdict: attempt.verdict, summary: attempt.summary, inputOid: attempt.inputOid, phase: attempt.phase, mutated: attempt.mutated } }, 2); });
  await forEachYielding(skippedVerification, async ({ task }) => {
    if (task.type !== 'verification' || task.state !== 'skipped' || task.endedAt === null) return;
    add({ runId: null, ts: task.endedAt, kind: 'verification', data: { outcome: 'skipped', command: task.command, verdict: task.verdict } }, 2);
  });
  await forEachYielding(guardrails, async ({ event }) => { add({ runId: event.runId, ts: event.ts, kind: 'guardrail', data: { dimension: event.dimension, phase: event.phase, limitValue: event.limitValue, observedValue: event.observedValue, configSource: event.configSource, payload: JSON.parse(event.payload) } }, 2); });
  await forEachYielding(facts, async ({ fact }) => {
    const kind: TicketTimelineKind = fact.type === 'escalate' ? 'escalation' : fact.type === 'operator-accept' ? 'operator-accept' : 'fact';
    add({ runId: fact.runId, ts: fact.ts, kind, data: { type: fact.type, payload: JSON.parse(fact.payload) } }, 4);
  });
  await forEachYielding(landing, async ({ entry }) => { add({ runId: entry.runId, ts: entry.ts, kind: 'landing', data: { kind: entry.kind, effect: entry.effect, idempotencyKey: entry.idempotencyKey, payload: JSON.parse(entry.payload) } }, 6); });

  return {
    events: pending
      .sort((a, b) => a.ts - b.ts || a.order - b.order || (a.runId ?? 0) - (b.runId ?? 0))
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

export type ApiRun = Omit<RunRow, 'usage' | 'liveUsage' | 'cost'> & { usage: RunUsage | null; cost: Cost | null };

export function runToApi(_ctx: AppContext, run: RunRow): ApiRun {
  const usage = parseUsage(run.usage);
  // liveUsage is the Activity view's live/persisted snapshot, streamed as a
  // `run_usage` firehose event — not part of the run's REST shape.
  const { liveUsage, ...rest } = run;
  return { ...rest, usage, cost: parseCost(run.cost) };
}

/** The firehose shape of a live-usage snapshot (ADR 0010): the persisted
 * snapshot plus Cost derived from its Usage on read, like every other Cost. */
export type ApiRunUsage = RunUsageSnapshot & { cost: Cost | null };

export function runUsageToApi(ctx: AppContext, snapshot: RunUsageSnapshot): ApiRunUsage {
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
  /** The running run's id, so the board can match the `run_usage` firehose to this card; null unless the Task is running (issue #100). */
  runId: number | null;
  /** The running run's phase, for the Board's Active-card badge; null unless the Task is running (or a pre-phase-machine run). */
  phase: RunRow['phase'];
  /** The running run's current context-window occupancy in tokens; null unless running (or unreported). Live via the `run_usage` firehose (issue #52). */
  contextTokens: number | null;
  /** The model's effective context window (config override, else shipped default); null when unknown. The board card shows `ctx %` = contextTokens/contextWindow — never a fabricated percentage (issue #52). */
  contextWindow: number | null;
  /** The current scheduler reason this Task was not picked for, such as a
   * dependency, capacity, disabled Workspace, or missing integration branch;
   * null when it is not waiting (issue #238). */
  skipReason: string | null;
  /** The latest run's frozen verification candidate ref (issue #134); null
   * when no run has produced a candidate yet (pre-feature, escalated before
   * `validating`, or a dirty direct-mode context). Surfaced so an escalated
   * Task's stranded candidate can be adopted for review, or re-reviewed with
   * an operator note, without a fresh builder run (issue #191). */
  candidateRef: string | null;
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
  const runs = await ctx.runs.listForTask(task.id);
  const running = task.state === 'working' ? runs.find((r) => r.state === 'running') : undefined;
  return taskToApiWithRuns(ctx, task, runs, running ? await runningToolCount(ctx, running) : null);
}

/** Serialize a task list from its already-batched Runs (issue #258). The rows
 * are lean (ADR-0045, issue #350): the full `prompt` is dropped in favour of
 * `summary`, so no list surface carries the whole prompt. */
export async function tasksToApi(ctx: AppContext, tasks: TaskWithDeps[]): Promise<ApiTaskListRow[]> {
  if (tasks.length === 0) return [];
  const runsByTask = new Map(tasks.map((task) => [task.id, [] as RunRow[]]));
  for (const run of await ctx.runs.listForTasks(tasks.map((task) => task.id))) runsByTask.get(run.taskId)?.push(run);
  const running = tasks.flatMap((task) => {
    const run = task.state === 'working' ? runsByTask.get(task.id)?.find((candidate) => candidate.state === 'running') : undefined;
    return run ? [run] : [];
  });
  const toolCounts = await ctx.runs.toolCallCounts(running.map((run) => run.id));
  return tasks.map((task) => {
    const runs = runsByTask.get(task.id) ?? [];
    const activeRun = task.state === 'working' ? runs.find((run) => run.state === 'running') : undefined;
    return toListRow(taskToApiWithRuns(ctx, task, runs, activeRun ? toolCounts.get(activeRun.id) ?? 0 : null));
  });
}

/** Drop the full `prompt` from a serialized task to make a lean list row
 * (issue #350); `summary` already carries the card title every list surface needs. */
function toListRow({ prompt: _prompt, ...row }: ApiTask): ApiTaskListRow {
  return row;
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

/** The ref an operator Accept would land: a worktree Run's branch once it has a
 * verified head. A direct Run has no branch — its work is already on the base
 * branch (ADR-0046) — so this is null for it. */
function latestVerifiedRef(run: RunRow | undefined): string | null {
  if (!run) return null;
  return run.candidateRef ?? (run.candidateOid && run.branch ? run.branch : null);
}

function taskToApiWithRuns(ctx: AppContext, task: TaskWithDeps, runs: RunRow[], toolCount: number | null): ApiTask {
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
    runId: running?.id ?? null,
    phase: running?.phase ?? null,
    contextTokens: running ? (parseUsage(running.usage)?.contextTokens ?? null) : null,
    contextWindow: contextWindowOf(ctx, task.model),
    skipReason: ctx.autoRunner.skipReasonFor(task.id) ?? null,
    candidateRef: latestVerifiedRef(runs.at(-1)),
  };
}

/** Total tool calls of a running run from its native aggregate (ADR-0031). */
async function runningToolCount(ctx: AppContext, run: RunRow): Promise<number> {
  const totals = await ctx.runs.listToolCalls(run.id);
  let count = 0;
  for (const total of totals.values()) count += total;
  return count;
}

/** Cost of an arbitrary set of Runs, summed from their frozen values. */
export function costOfRuns(runs: RunRow[]): Cost | null {
  return sumCosts(runs.map((run) => parseCost(run.cost)));
}

/** One live process in the Activity snapshot (issue #51); see `activitySnapshot`. */
export interface ApiActivityProcess {
  type: 'run' | 'chat';
  /** The Run's id (type `run`), else null. */
  runId: number | null;
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
  /** A running Run's RunState, or a warm Conversation's ConversationState. */
  state: RunState | ConversationState;
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
  usage: RunUsage | null;
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
  const snapshots = new Map((await ctx.runner.activeSnapshots()).map((snapshot) => [snapshot.runId, snapshot.snapshot]));
  const runs: ApiActivityProcess[] = await Promise.all((await ctx.runs.listRunning()).map(async (run) => {
    const task = await ctx.tasks.get(run.taskId);
    const snapshot = snapshots.get(run.id) ?? null;
    return {
      type: 'run',
      runId: run.id,
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
      runId: null,
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
  return resolveContextWindow(model, ctx.configStore.get().modelInfo);
}

export type ApiConversation = Omit<ConversationRow, 'usage' | 'workspaceId'> & {
  workspaceId: number;
  /** Running Usage accumulated across Turns (issue 12); null before any usage. */
  usage: RunUsage | null;
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
  const config = ctx.configStore.get();
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
