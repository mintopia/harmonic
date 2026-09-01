import type {
  AttemptRow,
  AttemptState,
  StepRow,
  StepType,
  ConversationRow,
  ConversationState,
  VerificationAttemptRow,
  TaskRow,
} from '../db/schema.js';
import type { TaskWithDeps } from '../domain/tasks.js';
import type { Ticket } from '../tracker/adapter.js';
import type { ScheduledJobSnapshot } from '../scheduler/scheduler.js';
import type { FlaggedWorktree } from '../domain/flagged-worktrees.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import { verifierStatuses, type VerifierStatus } from '../domain/verifier-status.js';
import { sumCosts, type Cost } from '../domain/pricing.js';
import type { AttemptUsage, AttemptUsageSnapshot, ProcessTree } from '../execution/usage.js';
import type { OperationEvent, OperationSnapshot } from '../telemetry/operations.js';
import { z } from 'zod';

/**
 * Pure row->DTO mappers for the API shapes of attempts, tasks, conversations,
 * operations, and the activity snapshot (issue 15). Everything here is a pure
 * function of its inputs — no `AppContext`, no I/O — so it is unit-testable in
 * isolation. The read-model builders in `serialize.ts` do the multi-store query
 * orchestration and then call these. Settled Attempt Costs are stored and
 * frozen; only live Usage is priced on read, so the price-dependent Cost is
 * always passed in by the builder rather than resolved here.
 */

export const parseUsage = (raw: string | null): AttemptUsage | null => (raw ? (JSON.parse(raw) as AttemptUsage) : null);
export const parseCost = (raw: string | null): Cost | null => (raw ? (JSON.parse(raw) as Cost) : null);

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
export function verifiedShaOf(verificationAttempts: readonly VerificationAttemptRow[]): string | null {
  const passing = verificationAttempts.filter((v) => v.verdict === 'pass');
  return passing.length ? passing[passing.length - 1]!.inputOid : null;
}

/** One Attempt row projected onto its timeline DTO, given the Attempt's already
 * read Steps and Verification Attempts plus the Task's configured verifiers. */
export function attemptToTimelineApi(
  attempt: AttemptRow,
  stepRows: readonly StepRow[],
  attemptVerifications: readonly VerificationAttemptRow[],
  verifiers: ReturnType<typeof resolveVerifiers>,
): ApiAttempt {
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
    verifiedSha: verifiedShaOf(attemptVerifications),
    escalationReason,
    continuation: continuationToApi(attempt.continuation),
    verifierStatuses: verifierStatuses({ verifiers, attempts: attemptVerifications, stepType }),
    steps: stepRows.map(stepToApi),
  };
}

export type TicketTimelineKind =
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
 * The public Attempt wire shape (ADR-0001, #390): `attemptToApiSummary`
 * translates an `AttemptRow` onto it rather than exposing the row raw —
 * `finishedAt` and the 4-value `state` are deliberate projections, not column
 * dumps.
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

/** An `AttemptRow` projected onto its public wire summary, given the Attempt's
 * already summed tool-call total (its native ADR-0031 aggregate). */
export function attemptToApiSummary(run: AttemptRow, toolCalls: number): ApiAttemptSummary {
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

/** Drop the full `prompt` from a serialized task to make a lean list row
 * (issue #350); `summary` already carries the card title every list surface needs. */
export function toListRow({ prompt: _prompt, ...row }: ApiTask): ApiTaskListRow {
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
export function latestVerifiedRef(run: AttemptRow | undefined): string | null {
  if (!run) return null;
  return run.verifiedRef ?? (run.verifiedHeadOid && run.branch ? run.branch : null);
}

/** A Task projected onto its API shape from its already-batched Runs and the
 * store-derived values a builder resolves for it (tool count, current Step,
 * candidate flag, tracker URL/map title, skip reason, context window). */
export function taskToApiDto(
  task: TaskWithDeps,
  runs: AttemptRow[],
  resolved: {
    toolCount: number | null;
    currentStep: StepType | null;
    hasCandidate: boolean;
    url: string | null;
    mapTitle: string | null;
    skipReason: string | null;
    contextWindow: number | null;
  },
): ApiTask {
  const running = runs.find((r) => r.state === 'running');
  return {
    ...stripTrackerFactCols(task),
    workspaceId: atRestWorkspaceId(task.workspaceId),
    summary: summarize(task.prompt),
    cost: sumCosts(runs.map((run) => parseCost(run.cost))),
    url: resolved.url,
    mapTitle: resolved.mapTitle,
    // A direct Run has no branch (its work is committed straight onto the base
    // branch, ADR-0046); only a worktree Run has an operator-facing branch.
    branch: runs.at(-1)?.branch ?? null,
    stat: runs.at(-1)?.stat ?? null,
    runStartedAt: running?.startedAt ?? null,
    toolCount: resolved.toolCount,
    attemptId: running?.id ?? null,
    currentStep: resolved.currentStep,
    contextTokens: running ? (parseUsage(running.usage)?.contextTokens ?? null) : null,
    contextWindow: resolved.contextWindow,
    skipReason: resolved.skipReason,
    verifiedRef: latestVerifiedRef(runs.at(-1)),
    hasCandidate: resolved.hasCandidate,
  };
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

/** A running Run projected onto its Activity-snapshot process, given the live
 * Runner snapshot (null when it has left the registry) and the store-derived
 * Workspace name, tracker URL, context window, and Cost. */
export function attemptProcessToApi(input: {
  run: AttemptRow;
  task: Pick<TaskRow, 'prompt' | 'workspaceId' | 'harness' | 'model' | 'isolationMode' | 'trackerRef' | 'state'>;
  snapshot: AttemptUsageSnapshot | null;
  workspaceName: string;
  trackerUrl: string | null;
  contextWindow: number | null;
  cost: Cost | null;
}): ApiActivityProcess {
  const { run, task, snapshot } = input;
  return {
    type: 'attempt',
    attemptId: run.id,
    conversationId: null,
    taskId: run.taskId,
    title: firstLineTitle(task.prompt) ?? `Task ${run.taskId}`,
    workspaceId: atRestWorkspaceId(task.workspaceId),
    workspaceName: input.workspaceName,
    harness: task.harness,
    model: task.model,
    state: run.state,
    isolation: task.isolationMode,
    startedAt: run.startedAt,
    trackerRef: task.trackerRef,
    trackerUrl: input.trackerUrl,
    escalated: task.state === 'escalated',
    usage: snapshot?.usage ?? null,
    contextTokens: snapshot?.contextTokens ?? null,
    contextWindow: input.contextWindow,
    activity: snapshot?.activity ?? null,
    tree: snapshot?.tree ?? null,
    cost: input.cost,
  };
}

/** A warm Conversation projected onto its Activity-snapshot process. A
 * Conversation has no live tailer, so `tree`/`activity` are null and its
 * Usage/context come from the row; the title and Cost are resolved by the
 * builder. */
export function conversationProcessToApi(input: {
  conversation: ConversationRow;
  title: string;
  workspaceName: string;
  contextWindow: number | null;
  cost: Cost | null;
}): ApiActivityProcess {
  const { conversation } = input;
  return {
    type: 'chat',
    attemptId: null,
    conversationId: conversation.id,
    taskId: null,
    title: input.title,
    workspaceId: atRestWorkspaceId(conversation.workspaceId),
    workspaceName: input.workspaceName,
    harness: conversation.harness,
    model: conversation.model,
    state: conversation.state,
    isolation: 'direct',
    startedAt: conversation.createdAt,
    trackerRef: null,
    trackerUrl: null,
    escalated: false,
    usage: parseUsage(conversation.usage),
    contextTokens: conversation.contextTokens,
    contextWindow: input.contextWindow,
    activity: null,
    tree: null,
    cost: input.cost,
  };
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

export function deriveConversationTitle(firstTurnText: string | null): string | null {
  return firstLineTitle(firstTurnText);
}

/** A Conversation row projected onto its API shape, given the builder-resolved
 * title, Cost, and per-model context-window / cache-TTL facts. Running
 * Usage/Cost are derived on read (issue 12); the title falls back to one
 * derived from the first Turn (issue 15); honest degradation when the model is
 * unconfigured (null, never a fake percentage). */
export function conversationToApiDto(
  conversation: ConversationRow,
  resolved: {
    title: string | null;
    cost: Cost | null;
    contextWindow: number | null;
    cacheTtlSeconds: number | null;
  },
): ApiConversation {
  const { usage: rawUsage, ...rest } = conversation;
  return {
    ...rest,
    workspaceId: atRestWorkspaceId(conversation.workspaceId),
    title: resolved.title,
    usage: parseUsage(rawUsage),
    cost: resolved.cost,
    contextTokens: conversation.contextTokens,
    contextWindow: resolved.contextWindow,
    cacheTtlSeconds: resolved.cacheTtlSeconds,
  };
}
