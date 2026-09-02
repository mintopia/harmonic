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
import type { IsolationMode, Priority } from '../config.js';
import type { Ticket } from '../tracker/adapter.js';
import type { ScheduledJobSnapshot } from '../scheduler/scheduler.js';
import type { FlaggedWorktree } from '../domain/flagged-worktrees.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import { verifierStatuses, type VerifierStatus } from '../domain/verifier-status.js';
import { sumCosts, type Cost } from '../domain/pricing.js';
import type { AttemptUsage, AttemptUsageSnapshot, ProcessTree } from '../execution/usage.js';
import type { OperationEvent, OperationSnapshot } from '../telemetry/operations.js';
import { z } from 'zod';

export const parseUsage = (raw: string | null): AttemptUsage | null => (raw ? (JSON.parse(raw) as AttemptUsage) : null);
export const parseCost = (raw: string | null): Cost | null => (raw ? (JSON.parse(raw) as Cost) : null);

/** `workspaceId` is nullable only because SQLite can't ADD COLUMN NOT NULL without a default; every row has one at rest. */
export const atRestWorkspaceId = (workspaceId: number | null): number => workspaceId!;

export const scheduledJobsToApi = (jobs: ScheduledJobSnapshot[]): ScheduledJobSnapshot[] => jobs;

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

/** The latest passing verification attempt's `inputOid`; null when nothing passed. */
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

/** The public Attempt wire shape; `finishedAt` and the 4-value `state` are projections, not column dumps. */
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
  /** Total tool calls this Attempt's session made. */
  toolCalls: number;
  /** The root session's latest context-window fill (its last live-usage
   * snapshot) and the model's window; null when unknown. */
  contextTokens: number | null;
  contextWindow: number | null;
  startedAt: number;
  finishedAt: number | null;
};

function apiAttemptState(state: AttemptState): ApiAttemptSummary['state'] {
  if (state === 'passed') return 'completed';
  if (state === 'escalated') return 'failed';
  return state;
}

/** An `AttemptRow` projected onto its public wire summary, given the Attempt's
 * already summed tool-call total (its native aggregate). */
export function attemptToApiSummary(run: AttemptRow, toolCalls: number, contextWindow: number | null = null): ApiAttemptSummary {
  return {
    id: run.id,
    taskId: run.taskId,
    number: run.number,
    state: apiAttemptState(run.state),
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
    contextTokens: liveContextTokens(run.liveUsage),
    contextWindow,
    startedAt: run.startedAt,
    finishedAt: run.endedAt,
  };
}

/** The `contextTokens` of an Attempt's persisted live-usage snapshot (ADR 0010), if any. */
function liveContextTokens(liveUsage: string | null): number | null {
  if (!liveUsage) return null;
  try {
    const snapshot = JSON.parse(liveUsage) as { contextTokens?: unknown };
    return typeof snapshot.contextTokens === 'number' ? snapshot.contextTokens : null;
  } catch {
    return null;
  }
}

/** The firehose shape of a live-usage snapshot (ADR 0010): the persisted
 * snapshot plus Cost derived from its Usage on read, like every other Cost. */
export type ApiAttemptUsage = AttemptUsageSnapshot & { cost: Cost | null };

type TrackerFactColumns =
  | 'trackerState'
  | 'trackerParent'
  | 'trackerBlockedBy'
  | 'trackerLabels'
  | 'trackerTitle'
  | 'trackerBody'
  | 'trackerUrl'
  | 'trackerCreatedAt';

export type ApiTask = Omit<TaskWithDeps, 'workspaceId' | 'isolationMode' | 'priority' | 'overrides' | TrackerFactColumns> & {
  workspaceId: number;
  /** Resolved effective value; always one of `ISOLATION_MODES` (`config.ts`) at rest. */
  isolationMode: IsolationMode;
  /** Resolved effective value; always one of `PRIORITIES` (`config.ts`) at rest. */
  priority: Priority;
  overrides: Omit<TaskWithDeps['overrides'], 'isolationMode' | 'priority'> & {
    isolationMode: IsolationMode | null;
    priority: Priority | null;
  };
  /** The prompt's first line, bounded; the full `prompt` is item-GET-only. */
  summary: string;
  cost: Cost | null;
  /** The mirrored issue's tracker URL, from the last poll's scan; null on native Tasks or before a poll. */
  url: string | null;
  /** The parent Map's title, resolved from mapRef against the last poll's scan; null when unmapped or before a poll. */
  mapTitle: string | null;
  /** The latest attempt's branch (worktree mode only); null in direct mode or before any attempt. */
  branch: string | null;
  /** The latest attempt's `git diff --stat`, snapshotted at settle; null until then or in direct mode. */
  stat: string | null;
  /** The running attempt's `startedAt`; null unless the Task is running. */
  runStartedAt: number | null;
  /** Total tool-call count of the running attempt; null unless the Task is running. */
  toolCount: number | null;
  /** The running attempt's id, so the board can match the `attempt_usage` firehose to this card; null unless running. */
  attemptId: number | null;
  /** The running attempt's current Step; null unless the Task is running, or between Steps. */
  currentStep: StepType | null;
  /** The running attempt's context-window occupancy in tokens; null unless running (or unreported). */
  contextTokens: number | null;
  /** The model's effective context window; null when unknown. */
  contextWindow: number | null;
  /** Why the scheduler is skipping this Task (dependency, capacity, disabled Workspace, missing integration branch); null when not waiting. */
  skipReason: string | null;
  /** The latest attempt's verified-head ref; null when no attempt has produced one. */
  verifiedRef: string | null;
  /** Whether the branch holds commits ahead of base an Accept could merge. */
  hasCandidate: boolean;
};

/** Every {@link ApiTask} field except `prompt`; list surfaces render {@link ApiTask.summary} instead. */
export type ApiTaskListRow = Omit<ApiTask, 'prompt'>;

const SUMMARY_MAX = 200;

/** The prompt's first non-empty line, bounded to {@link SUMMARY_MAX}. */
export function summarize(prompt: string): string {
  const firstLine = prompt.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
  return firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX - 1)}…` : firstLine;
}

/** Drop `prompt` to make a lean list row. */
export function toListRow({ prompt: _prompt, ...row }: ApiTask): ApiTaskListRow {
  return row;
}

/** Project an Epic's container ticket into a Tasks-list row; only ref, title, url, and createdAt carry real data. */
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
    mergeStatus: null,
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

function stripTrackerFactCols(task: TaskWithDeps): Omit<TaskWithDeps, TrackerFactColumns> {
  const {
    trackerState, trackerParent, trackerBlockedBy, trackerLabels,
    trackerTitle, trackerBody, trackerUrl, trackerCreatedAt,
    ...rest
  } = task;
  return rest;
}

/** The ref an operator Accept would merge; null for a direct Attempt, whose work is already on the base branch. */
export function latestVerifiedRef(run: AttemptRow | undefined): string | null {
  if (!run) return null;
  return run.verifiedRef ?? (run.verifiedHeadOid && run.branch ? run.branch : null);
}

/** A Task projected onto its API shape from its batched Attempts and the builder-resolved values. */
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
    // Resolved from `config.ts`'s ISOLATION_MODES/PRIORITIES at every write site; TaskRow widens them to `string`.
    isolationMode: task.isolationMode as IsolationMode,
    priority: task.priority as Priority,
    overrides: {
      ...task.overrides,
      isolationMode: task.overrides.isolationMode as IsolationMode | null,
      priority: task.overrides.priority as Priority | null,
    },
    workspaceId: atRestWorkspaceId(task.workspaceId),
    summary: summarize(task.prompt),
    cost: sumCosts(runs.map((run) => parseCost(run.cost))),
    url: resolved.url,
    mapTitle: resolved.mapTitle,
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

/** Cost of an arbitrary set of Attempts, summed from their frozen values. */
export function costOfAttempts(runs: AttemptRow[]): Cost | null {
  return sumCosts(runs.map((run) => parseCost(run.cost)));
}

/** One live process in the Activity snapshot; see `activitySnapshot`. */
export interface ApiActivityProcess {
  type: 'attempt' | 'chat';
  /** The Attempt's id (type `attempt`), else null. */
  attemptId: number | null;
  /** The Conversation's id (type `chat`), else null. */
  conversationId: number | null;
  /** The owning Task's id (type `attempt`), else null. */
  taskId: number | null;
  /** The process's display title: an Attempt's Task prompt first line, a Conversation's title. */
  title: string;
  workspaceId: number;
  /** The owning Workspace's name; the Activity view spans Workspaces. */
  workspaceName: string;
  harness: string;
  model: string;
  /** A running Attempt's AttemptState, or a warm Conversation's ConversationState. */
  state: AttemptState | ConversationState;
  /** Isolation Mode: `worktree`/`direct` for an Attempt; always `direct` for a Conversation. */
  isolation: string;
  /** Epoch ms the process started; the client derives elapsed from it. */
  startedAt: number;
  /** The mirrored issue's tracker ref (an Attempt's Task); null on native Tasks and Conversations. */
  trackerRef: number | null;
  /** The mirrored issue's tracker URL; null on native Tasks, Conversations, or before a poll. */
  trackerUrl: string | null;
  /** True when the Task is escalated; always false for a Conversation. */
  escalated: boolean;
  usage: AttemptUsage | null;
  contextTokens: number | null;
  /** The model's configured context window; null when unconfigured (the gauge then shows raw tokens). */
  contextWindow: number | null;
  /** One-line current-activity (Attempts only); null for a Conversation. */
  activity: string | null;
  /** The process's Process Tree (Attempts only); null for a Conversation. */
  tree: ProcessTree | null;
  cost: Cost | null;
}

/** A running Attempt projected onto its Activity-snapshot process. */
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

/** A warm Conversation projected onto its Activity-snapshot process; `tree`/`activity` are null. */
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
  /** Running Usage accumulated across Turns; null before any usage. */
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

const DERIVED_TITLE_MAX = 80;

/** First non-empty line of `text`, clamped to `DERIVED_TITLE_MAX` with an ellipsis; null when blank. */
export function firstLineTitle(text: string | null): string | null {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim();
  if (!line) return null;
  return line.length > DERIVED_TITLE_MAX ? `${line.slice(0, DERIVED_TITLE_MAX - 1).trimEnd()}…` : line;
}

export function deriveConversationTitle(firstTurnText: string | null): string | null {
  return firstLineTitle(firstTurnText);
}

/** A Conversation row projected onto its API shape from the builder-resolved title, Cost, and per-model facts. */
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
