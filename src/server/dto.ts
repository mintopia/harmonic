import type {
  AttemptRow,
  TaskAttemptRow,
  AttemptState,
  WorkflowStepOutcome,
  WorkflowStepRunRow,
  ConversationRow,
  ConversationState,
  TaskRow,
  NotificationRow,
  MergeStatus,
} from '../db/schema.js';
import type { TaskWithDeps } from '../domain/tasks.js';
import { classifierRouteOf, type AttemptClassifier, type TaskClassifier, type TaskRouting } from '../domain/task-routing.js';
import type { PersistedAttemptEvent } from '../domain/attempts.js';
import type { IsolationMode, Priority } from '../config.js';
import type { Ticket, TrackerRef } from '../tracker/adapter.js';
import type { ScheduledJobSnapshot } from '../scheduler/scheduler.js';
import { worktreeId, type WorktreeInventoryEntry } from '../domain/worktree-inventory.js';
import { stepRunKind, type StepRunKind } from '../domain/step-run-kind.js';
import type { WorkflowStepOutputs } from '../domain/workflow-step-runs.js';
import { parseCost, sumCosts, type Cost } from '../domain/pricing.js';
import type { AttemptUsage, AttemptUsageSnapshot, ProcessTree } from '../execution/usage.js';
import type { OperationEvent, OperationSnapshot } from '../telemetry/operations.js';
import { z } from 'zod';
import type { AdvertisedCommand } from '../execution/conversation-driver.js';
import type { ResolvedGuardrails } from '../domain/setting-override.js';
import { wallClockBudgetMs } from '../domain/guardrail-budget.js';
import { firstLineTitle } from '../domain/task-title.js';

export { firstLineTitle, taskDisplayTitle } from '../domain/task-title.js';

export const parseUsage = (raw: string | null): AttemptUsage | null => (raw ? (JSON.parse(raw) as AttemptUsage) : null);
export { parseCost };

/** `workspaceId` is nullable only because SQLite can't ADD COLUMN NOT NULL without a default; every row has one at rest. */
export const atRestWorkspaceId = (workspaceId: number | null): number => workspaceId!;

export interface ApiNotification {
  id: number;
  severity: NotificationRow['severity'];
  title: string;
  detail: string | null;
  workspaceId: number | null;
  taskId: number | null;
  createdAt: number;
  readAt: number | null;
  read: boolean;
}

export const notificationToApi = (row: NotificationRow): ApiNotification => ({
  id: row.id,
  severity: row.severity,
  title: row.title,
  detail: row.detail,
  workspaceId: row.workspaceId,
  taskId: row.taskId,
  createdAt: row.createdAt,
  readAt: row.readAt,
  read: row.readAt !== null,
});

export const scheduledJobsToApi = (jobs: ScheduledJobSnapshot[]): ScheduledJobSnapshot[] => jobs;

export const worktreesToApi = (worktrees: readonly WorktreeInventoryEntry[]) =>
  worktrees.map((worktree) => ({ id: worktreeId(worktree), ...worktree }));

export type ApiStepRunState = WorkflowStepOutcome | 'running' | 'interrupted';

export interface ApiStepRun {
  id: number;
  attemptId: number | null;
  stepId: string;
  action: string;
  kind: StepRunKind;
  /** The `attempts:` block Pass this run belongs to, 1-based; null outside the block. */
  pass: number | null;
  position: number;
  /** `running` has neither outcome nor end time; `interrupted` has an end time but no outcome (process death). */
  state: ApiStepRunState;
  outcome: WorkflowStepOutcome | null;
  summary: string | null;
  /** What the pinned workflow says the step runs: the command, the prompt name, or the critic model. */
  detail: string | null;
  condition: string | null;
  outputs: WorkflowStepOutputs;
  hasPrompt: boolean;
  sessionRowId: number | null;
  harness: string | null;
  model: string | null;
  cost: Cost | null;
  startedAt: number;
  endedAt: number | null;
}

export function stepRunState(row: Pick<WorkflowStepRunRow, 'outcome' | 'endedAt'>): ApiStepRunState {
  return row.outcome ?? (row.endedAt === null ? 'running' : 'interrupted');
}

export function parseStepRunOutputs(raw: string | null): WorkflowStepOutputs {
  return raw === null ? { stdout: '', exitCode: null } : (JSON.parse(raw) as WorkflowStepOutputs);
}

export function stepRunToApi(row: WorkflowStepRunRow, extra: { info?: { detail: string | null; condition: string | null } | undefined; cost: Cost | null }): ApiStepRun {
  return {
    id: row.id,
    attemptId: row.attemptId,
    stepId: row.stepId,
    action: row.action,
    kind: stepRunKind(row.action),
    pass: row.attempt,
    position: row.position,
    state: stepRunState(row),
    outcome: row.outcome,
    summary: row.summary,
    detail: extra.info?.detail ?? null,
    condition: extra.info?.condition ?? null,
    outputs: parseStepRunOutputs(row.outputs),
    hasPrompt: row.resolvedPrompt !== null,
    sessionRowId: row.sessionRowId,
    harness: row.harness,
    model: row.model,
    cost: extra.cost,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

export interface ApiAttempt {
  id: number;
  taskId: number;
  number: number;
  state: AttemptRow['state'];
  startedAt: number;
  endedAt: number | null;
  feedback: string | null;
  escalationReason: string | null;
  workingDir: string | null;
  continuation: z.infer<typeof attemptContinuationSchema> | null;
  /** The Harness and Model this Attempt started on; null for Attempts that predate the record. */
  harness: string | null;
  model: string | null;
  /** The Route Classifier's decision for this Attempt; null when it was not consulted. */
  classifier: AttemptClassifier | null;
  /** The Route Classifier call's own Cost and the Models it ran on, separate from the Attempt's Cost; null when the call reported no usage. */
  routing: { cost: Cost | null; models: string[] } | null;
  stepRuns: ApiStepRun[];
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
}

export function attemptToTimelineApi(
  attempt: TaskAttemptRow,
  stepRuns: ApiStepRun[],
  workingDir: string | null,
): ApiAttempt {
  const escalationReason = attempt.state === 'escalated' ? attempt.reason : null;
  return {
    id: attempt.id,
    taskId: attempt.taskId,
    number: attempt.number,
    state: attempt.state,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    feedback: attempt.feedback,
    escalationReason,
    workingDir,
    continuation: continuationToApi(attempt.continuation),
    harness: attempt.harness,
    model: attempt.model,
    classifier: attempt.routeKind
      ? {
          kind: attempt.routeKind === 'classifier' ? 'routed' : 'abstained',
          optionId: attempt.routeOption,
          reason: attempt.routeReason,
          position: attempt.routeOptionPosition,
          optionCount: attempt.routeOptionCount,
        }
      : null,
    routing: attempt.routingUsage ? { cost: parseCost(attempt.routingCost), models: Object.keys(parseUsage(attempt.routingUsage)?.models ?? {}) } : null,
    stepRuns,
  };
}

export type TicketTimelineKind =
  | 'attempt-started'
  | 'attempt-finished'
  | 'lifecycle'
  | 'step-run'
  | 'guardrail'
  | 'operator-retry'
  | 'agent-message'
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
  /** The PR/MR the open-PR Merge Fate opened for this Attempt; null when none. */
  pullRequestUrl: string | null;
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

/** An Epic-owned Attempt's durable execution and cost facts.  Unlike a Task
 * Attempt it has no Task-specific branch, verifier, or continuation fields. */
export type ApiEpicAttempt = {
  id: number;
  number: number;
  state: AttemptRow['state'];
  reason: string | null;
  usage: AttemptUsage | null;
  cost: Cost | null;
  toolCalls: number;
  contextTokens: number | null;
  startedAt: number;
  endedAt: number | null;
  stepRuns: ApiStepRun[];
  /** Each Resolved Prompt this Epic Attempt sent to a resolver, read via `GET …/epics/:ref/resolved-prompt`. */
  resolverPrompts: ApiEpicResolverPrompt[];
};

export type ApiEpicResolverPrompt = {
  kind: 'merge-conflict' | 'verification' | 'refresh';
  locator: string;
  promptIndex: number;
  ts: number;
};

/** The archived resolver prompts among an Epic Attempt's lifecycle events, in order. */
export function epicResolverPrompts(events: readonly PersistedAttemptEvent[]): ApiEpicResolverPrompt[] {
  return events.flatMap<ApiEpicResolverPrompt>((event) => {
    const payload = event.type === 'lifecycle' ? (event.payload as { event?: unknown; kind?: unknown; locator?: unknown; promptIndex?: unknown } | null) : null;
    if (typeof payload?.locator !== 'string' || typeof payload.promptIndex !== 'number') return [];
    if (payload.event === 'merge-conflict-resolve') return [{ kind: 'merge-conflict', locator: payload.locator, promptIndex: payload.promptIndex, ts: event.ts }];
    if (payload.event === 'epic-resolve') return [{ kind: payload.kind === 'refresh' ? 'refresh' : 'verification', locator: payload.locator, promptIndex: payload.promptIndex, ts: event.ts }];
    return [];
  });
}

function apiAttemptState(state: AttemptState): ApiAttemptSummary['state'] {
  if (state === 'passed') return 'completed';
  if (state === 'escalated') return 'failed';
  return state;
}

/** An `AttemptRow` projected onto its public wire summary, given the Attempt's
 * already summed tool-call total (its native aggregate). */
export function attemptToApiSummary(run: TaskAttemptRow, toolCalls: number, contextWindow: number | null = null): ApiAttemptSummary {
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
    pullRequestUrl: run.pullRequestUrl,
    usage: parseUsage(run.usage),
    cost: parseCost(run.cost),
    toolCalls,
    contextTokens: liveContextTokens(run.liveUsage),
    contextWindow,
    startedAt: run.startedAt,
    finishedAt: run.endedAt,
  };
}

/** Project the owner-neutral execution facts of an Epic Attempt for its timeline. */
export function epicAttemptToApi(
  run: AttemptRow,
  toolCalls: number,
  stepRuns: ApiStepRun[],
  cost: Cost | null,
  events: readonly PersistedAttemptEvent[],
): ApiEpicAttempt {
  return {
    id: run.id,
    number: run.number,
    state: run.state,
    reason: run.detail ?? run.reason,
    usage: parseUsage(run.usage),
    cost,
    toolCalls,
    contextTokens: liveContextTokens(run.liveUsage),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    stepRuns,
    resolverPrompts: epicResolverPrompts(events),
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

export interface ApiCurrentStep {
  stepId: string;
  action: string;
  kind: StepRunKind;
}

export type ApiTask = Omit<TaskWithDeps, 'workspaceId' | 'modelOptionOverrides' | 'isolationMode' | 'priority' | 'overrides' | 'archiveId' | 'workflowRequested' | 'classifierEnabled' | 'workflowRoutingUsage' | 'workflowRoutingCost' | TrackerFactColumns> & {
  workspaceId: number;
  /** Ticket-scoped Model Option overrides; empty when none. */
  modelOptionOverrides: Array<{ id: string; harness: string; model: string }>;
  /** Resolved effective value; always one of `ISOLATION_MODES` (`config.ts`) at rest. */
  isolationMode: IsolationMode;
  /** Resolved effective value; always one of `PRIORITIES` (`config.ts`) at rest. */
  priority: Priority;
  overrides: Omit<TaskWithDeps['overrides'], 'isolationMode' | 'priority'> & {
    isolationMode: IsolationMode | null;
    priority: Priority | null;
  };
  /** Derived from the running step run (`merging`); null at rest. */
  mergeStatus: MergeStatus | null;
  /** Cost of the workflow classifier call that chose or declined this Ticket's workflow; null when it was not consulted. */
  workflowRouting: { cost: Cost | null } | null;
  /** The Routing Label matching a mirrored Ticket; `applied` is false when an operator's Harness/Model override wins. Null when none matches. */
  routing: TaskRouting | null;
  /** What the Route Classifier did for this Ticket; null when it did not decide (a Routing Label won, the classifier is off, or no Attempt consulted it). */
  classifier: TaskClassifier | null;
  /** The prompt's first line, bounded; the full `prompt` is item-GET-only. */
  summary: string;
  cost: Cost | null;
  /** The mirrored issue's tracker URL, from the last poll's scan; null on native Tasks or before a poll. */
  url: string | null;
  /** The parent Map's title, resolved from mapRef against the last poll's scan; null when unmapped or before a poll. */
  mapTitle: string | null;
  /** The display name of the tracker a mirrored Task came from (e.g. GitHub); null on native Tasks or when the Workspace's tracker is unresolved. */
  trackerLabel: string | null;
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
  /** The running Attempt's running step run; null unless the Task is running, or between steps. */
  currentStep: ApiCurrentStep | null;
  /** The running attempt's context-window occupancy in tokens; null unless running (or unreported). */
  contextTokens: number | null;
  /** The model's effective context window; null when unknown. */
  contextWindow: number | null;
  /** Why the scheduler is skipping this Task (dependency, capacity, disabled Workspace, missing integration branch); null when not waiting. */
  skipReason: string | null;
  /** The Kubernetes Execution Target this Ticket waits for, with its load and the Ticket's place in line; null when not waiting on one. */
  targetWait: { target: string; disabled: boolean; running: number; limit: number | null; position: number } | null;
  /** The latest attempt's verified-head ref; null when no attempt has produced one. */
  verifiedRef: string | null;
  /** Whether the branch holds commits ahead of base an Accept could merge. */
  hasCandidate: boolean;
  /** Epoch ms; null unless working with a budgeted running Attempt. */
  wallClockDeadline: number | null;
};

/** Every {@link ApiTask} field except `prompt`; list surfaces render {@link ApiTask.summary} instead. */
export type ApiTaskListRow = Omit<ApiTask, 'prompt'>;

/** An Epic container in a Tasks list: it has no Task id, so it is keyed by `trackerRef`. */
export type ApiEpicListRow = Omit<ApiTaskListRow, 'id' | 'trackerRef'> & { trackerRef: TrackerRef };

/** A Tasks-list item: a Task row (has `id`) or an Epic row (no `id`). */
export type ApiTaskListItem = ApiTaskListRow | ApiEpicListRow;

export const isEpicListRow = (row: ApiTaskListItem): row is ApiEpicListRow => !('id' in row);

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
export function epicToListRow(ticket: Ticket, workspaceId: number): ApiEpicListRow {
  const created = Date.parse(ticket.createdAt) || 0;
  return {
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
    escalationCause: null,
    mergeStatus: null,
    ticketClosePending: false,
    feedback: null,
    continuationChoice: null,
    origin: 'mirrored',
    trackerRef: ticket.ref,
    issueWorkflow: null,
    workflowRef: null,
    workflowChosen: null,
    workflowLabel: null,
    execution: null,
    workflowReason: null,
    workflowRouting: null,
    workflowVarOverrides: null,
    workflowVars: null,
    wayfinderType: null,
    mapRef: null,
    createdAt: created,
    updatedAt: created,
    dependsOn: [],
    dependents: [],
    blockedOnFailed: false,
    openBlockerCount: 0,
    epicBlockers: [],
    agentWorkable: false,
    humanOnly: true,
    isEpic: true,
    overrides: { harness: null, model: null, isolationMode: null, priority: null, conflictResolveTurns: null },
    modelOptionOverrides: [],
    routing: null,
    classifier: null,
    summary: ticket.title,
    cost: null,
    url: ticket.url,
    mapTitle: null,
    trackerLabel: null,
    branch: null,
    stat: null,
    runStartedAt: null,
    toolCount: null,
    attemptId: null,
    currentStep: null,
    contextTokens: null,
    contextWindow: null,
    skipReason: null,
    targetWait: null,
    verifiedRef: null,
    hasCandidate: false,
    wallClockDeadline: null,
  };
}

function stripTrackerFactCols(task: Omit<TaskWithDeps, 'classifierEnabled'>): Omit<TaskWithDeps, TrackerFactColumns | 'archiveId' | 'workflowRequested' | 'classifierEnabled' | 'workflowRoutingUsage' | 'workflowRoutingCost'> {
  const {
    archiveId,
    workflowRequested,
    workflowRoutingUsage,
    workflowRoutingCost,
    trackerState, trackerParent, trackerBlockedBy, trackerLabels,
    trackerTitle, trackerBody, trackerUrl, trackerCreatedAt,
    ...rest
  } = task;
  return rest;
}

/** The ref an operator Accept would merge; null for a direct Attempt, whose work is already on the base branch. */
export function latestVerifiedRef(run: AttemptRow | undefined): string | null {
  if (!run) return null;
  return run.verifiedHeadOid && run.branch ? run.branch : null;
}

/** `startedAt` is rewritten on resume, so paused time is excluded. */
export function wallClockDeadlineOf(run: AttemptRow | undefined): number | null {
  if (!run?.guardrailConfig) return null;
  let config: ResolvedGuardrails;
  try {
    config = JSON.parse(run.guardrailConfig) as ResolvedGuardrails;
  } catch {
    return null;
  }
  if (!config.budget) return null;
  return run.startedAt + wallClockBudgetMs(config.budget);
}

/** A Task projected onto its API shape from its batched Attempts and the builder-resolved values. */
export function taskToApiDto(
  task: TaskWithDeps,
  runs: AttemptRow[],
  resolved: {
    toolCount: number | null;
    currentStep: ApiCurrentStep | null;
    criticCost?: Cost | null;
    hasCandidate: boolean;
    url: string | null;
    mapTitle: string | null;
    trackerLabel: string | null;
    skipReason: string | null;
    targetWait: ApiTask['targetWait'];
    contextWindow: number | null;
  },
): ApiTask {
  const running = runs.find((r) => r.state === 'running');
  const { classifierEnabled, ...rest } = task;
  return {
    ...stripTrackerFactCols(rest),
    workflowRouting: task.workflowRoutingUsage ? { cost: parseCost(task.workflowRoutingCost) } : null,
    classifier: classifierRouteOf({
      enabled: classifierEnabled,
      labelMatched: task.routing !== null,
      operatorSet: task.overrides.harness !== null || task.overrides.model !== null,
      latest: runs.at(-1),
    }),
    isolationMode: task.isolationMode as IsolationMode,
    priority: task.priority as Priority,
    overrides: {
      ...task.overrides,
      isolationMode: task.overrides.isolationMode as IsolationMode | null,
      priority: task.overrides.priority as Priority | null,
    },
    modelOptionOverrides: task.modelOptionOverrides ?? [],
    workspaceId: atRestWorkspaceId(task.workspaceId),
    summary: summarize(task.prompt),
    cost: sumCosts([...runs.map((run) => parseCost(run.cost)), resolved.criticCost ?? null]),
    mergeStatus: resolved.currentStep?.action === 'merge' ? 'merging' : null,
    url: resolved.url,
    mapTitle: resolved.mapTitle,
    trackerLabel: resolved.trackerLabel,
    branch: runs.at(-1)?.branch ?? null,
    stat: runs.at(-1)?.stat ?? null,
    runStartedAt: running?.startedAt ?? null,
    toolCount: resolved.toolCount,
    attemptId: running?.id ?? null,
    currentStep: resolved.currentStep,
    contextTokens: running ? (parseUsage(running.usage)?.contextTokens ?? null) : null,
    contextWindow: resolved.contextWindow,
    skipReason: resolved.skipReason,
    targetWait: resolved.targetWait,
    verifiedRef: latestVerifiedRef(runs.at(-1)),
    hasCandidate: resolved.hasCandidate,
    wallClockDeadline: task.state === 'working' ? wallClockDeadlineOf(running) : null,
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
  trackerRef: TrackerRef | null;
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

/** A running whole-Epic verification projected into the shared Activity feed. */
export function epicAttemptProcessToApi(input: {
  run: AttemptRow;
  workspaceId: number;
  workspaceName: string;
  epicRef: TrackerRef;
  harness: string;
  model: string;
  trackerUrl: string | null;
}): ApiActivityProcess {
  const { run } = input;
  return {
    type: 'attempt',
    attemptId: run.id,
    conversationId: null,
    taskId: null,
    title: `Epic #${input.epicRef} verification`,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    harness: input.harness,
    model: input.model,
    state: run.state,
    isolation: 'worktree',
    startedAt: run.startedAt,
    trackerRef: input.epicRef,
    trackerUrl: input.trackerUrl,
    escalated: false,
    usage: parseUsage(run.usage),
    contextTokens: liveContextTokens(run.liveUsage),
    contextWindow: null,
    activity: 'Verifying integration',
    tree: null,
    cost: parseCost(run.cost),
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
  /** The harness cache's warm duration in seconds, derived from current configuration. */
  cacheWarmSeconds: number | null;
  coldResume: boolean;
  commands: AdvertisedCommand[];
  commandPrefix: string;
};

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
    cacheWarmSeconds: number | null;
    coldResume?: boolean;
    commands?: AdvertisedCommand[];
    commandPrefix: string;
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
    cacheWarmSeconds: resolved.cacheWarmSeconds,
    coldResume: resolved.coldResume ?? false,
    commands: resolved.commands ?? [],
    commandPrefix: resolved.commandPrefix,
  };
}
