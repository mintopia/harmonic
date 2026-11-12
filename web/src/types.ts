import type { TrackerResolveFailureCode } from '../../src/tracker/adapter.js';
import type { AttemptClassifier, EscalationCause, TaskClassifier, TaskRouting } from '../../src/domain/task-routing.js';

/** The stored Ticket states; blocked-ness and agent-workability are derived, never stored. */
export const TASK_STATES = ['draft', 'ready', 'working', 'paused', 'escalated', 'done', 'cancelled'] as const;
/** An opaque tracker ticket ref (`185`, `PROJ-185`): never parse or do arithmetic on it; compare with ===. */
export type TrackerRef = string;

export type TaskState = (typeof TASK_STATES)[number];

export interface UpdateState {
  currentVersion: string;
  availableVersion: string | null;
  armedVersion: string | null;
  upgradingVersion: string | null;
  dismissedVersion: string | null;
  migrationRequired: boolean;
  guardMissing: boolean;
  mode: {
    kind: 'systemd' | 'initd' | 'migration-required' | 'external';
    instruction?: { kind: 'command'; command: string } | { kind: 'manual'; instructions: string };
  };
  failed: { targetVersion: string; reason: string; at: string } | null;
  idle: {
    runningAttempts: number;
    mergingOrIntegrating: boolean;
    conversationMidTurn: boolean;
  };
}

export const MERGE_STATUSES = ['verifying', 'merging', 'resolving-conflicts'] as const;
export type MergeStatus = (typeof MERGE_STATUSES)[number];

export type AttemptState = 'running' | 'passed' | 'failed' | 'escalated' | 'cancelled';

export type WorkflowChosen = 'explicit' | 'label' | 'classifier' | 'workspace' | 'global';
export type WorkflowStepOutcome = 'pass' | 'fail' | 'inconclusive' | 'conflict' | 'skipped';

export interface WorkflowIssue {
  message: string;
  line: number;
  column: number;
}

export type WorkflowDocument = Pick<WorkflowLibraryEntry, 'name' | 'description' | 'version'> & { text: string };

export interface EpicWorkflowRef {
  name: string;
  version: number;
  chosen: 'workspace' | 'global';
}

export interface WorkflowTemplate {
  name: string;
  description: string;
  subject: 'ticket' | 'epic';
  text: string;
}

export interface WorkflowLibraryEntry {
  name: string;
  description: string;
  subject: 'ticket' | 'epic';
  version: number;
  inUse: { tickets: number; running: number; workspaces: number };
  assignedAs: Array<{ kind: 'global-default' | 'workspace-default' | 'label'; label?: string }>;
}

export interface TaskWorkflowVars {
  workflowRef: string | null;
  workflow: string | null;
  vars: {
    name: string;
    default: string | number | boolean;
    workspace: string | number | boolean | null;
    ticket: string | number | boolean | null;
    value: string | number | boolean;
    source: 'default' | 'workspace' | 'ticket';
  }[];
  snapshot: Record<string, string | number | boolean> | null;
}

export interface StepCheckpoint {
  branch: string;
  sha: string | null;
  forced: boolean;
  unchanged?: boolean;
  files?: number;
  error?: string;
}

export type StepRunKind = 'rebase' | 'agent' | 'check' | 'critic' | 'publish' | 'tracker' | 'cleanup' | 'marker';
/** running = no outcome and no end time; interrupted = end time but no outcome (process death). */
export type StepRunState = WorkflowStepOutcome | 'running' | 'interrupted';

export interface StepRunOutputs {
  stdout: string;
  exitCode: number | null;
  baseSha?: string;
  conflictedFiles?: string[];
  url?: string;
  number?: number;
  branch?: string;
  verdict?: 'pass' | 'fail' | 'inconclusive';
  reason?: string;
  findings?: string[];
  checkpoint?: StepCheckpoint;
}

/** One execution of one workflow step within an Attempt. */
export interface StepRun {
  id: number;
  attemptId: number | null;
  stepId: string;
  action: string;
  kind: StepRunKind;
  /** The `attempts:` block Pass, 1-based; null outside the block. */
  pass: number | null;
  position: number;
  state: StepRunState;
  outcome: WorkflowStepOutcome | null;
  summary: string | null;
  detail: string | null;
  condition: string | null;
  outputs: StepRunOutputs;
  hasPrompt: boolean;
  sessionRowId: number | null;
  harness: string | null;
  model: string | null;
  cost: Cost | null;
  startedAt: number;
  endedAt: number | null;
}

export interface TaskExecution {
  target: string;
  podName: string | null;
  podState: 'pending' | 'running' | 'deleted' | 'lost';
  namespace: string;
  image: string;
  source: 'workflow' | 'step';
}

export interface WorkflowStepRun {
  id: number;
  attemptId: number | null;
  kind: StepRunKind;
  sessionRowId: number | null;
  stepId: string;
  action: string;
  position: number;
  /** The `attempts:` block pass (1-based); null outside the block. */
  attempt: number | null;
  /** null while the step is still running. */
  outcome: WorkflowStepOutcome | null;
  summary: string | null;
  resolvedPrompt: string | null;
  outputs: StepRunOutputs;
  startedAt: number | null;
  endedAt: number | null;
}

export interface WorkflowStepsResponse {
  workflowRef: string | null;
  workflowChosen: WorkflowChosen | null;
  outline: { id: string; children: string[] }[];
  cleanupCount: number;
  /** What the pinned workflow says each step is, by step id; children and cleanup steps included. */
  stepInfo?: Record<string, { uses: string; detail: string | null; condition: string | null }>;
  blockStepIds?: string[];
  cleanupIds?: string[];
  maxAttempts?: number | null;
  latestVersion: number | null;
  steps: WorkflowStepRun[];
}

export interface Attempt {
  id: number;
  taskId: number;
  number: number;
  state: AttemptState;
  startedAt: number;
  endedAt: number | null;
  /** The failure feedback this attempt closed with — what the next attempt was told to fix. */
  feedback: string | null;
  /** Why this attempt handed the ticket to a human; null unless it escalated. */
  escalationReason: string | null;
  /** The folder the agent worked in (its managed worktree); null in direct mode, where the Task's workingDir applies. */
  workingDir: string | null;
  continuation: {
    path: 'continued-session' | 'new-session-condensed';
    reason: 'continued-within-limits' | 'context-tokens' | 'session-cold' | 'missing-context-tokens' | 'missing-warm-window';
    contextTokens: number | null;
    contextReuseTokenLimit: number;
    lastActiveAt: number;
    lastActiveAgeMs: number;
    warmWindowMs: number | null;
  } | null;
  /** The Harness and Model this Attempt started on; null for Attempts that predate the record. */
  harness: string | null;
  model: string | null;
  /** The Route Classifier's decision for this Attempt; null when it was not consulted. */
  classifier: AttemptClassifier | null;
  /** The Route Classifier call's own Cost and the Models it ran on, separate from the Attempt's Cost; null when the call reported no usage. */
  routing: { cost: Cost | null; models: string[] } | null;
  stepRuns: StepRun[];
}

/** A budget dimension a Guardrail can trip on; mirrors
 * the server's `GUARDRAIL_DIMENSIONS` (`db/schema.ts`). */
export type GuardrailDimension = 'wall-clock' | 'tokens' | 'cost' | 'progress' | 'tool-timeout';

/** One persisted Guardrail-trip event, as `GET
 * /api/attempts/:id/guardrail-events` serves it — mirrors the server's
 * `GuardrailEventRow` (`domain/guardrail-events.ts`). `limitValue`/
 * `observedValue` are in the dimension's own unit (ms for wall-clock and
 * tool-timeout, tokens for tokens, USD for cost, a sentinel 0/count for
 * progress); `payload` carries dimension-specific evidence. */
export interface GuardrailEvent {
  id: number;
  /** The Attempt this event is keyed to. */
  attemptId: number;
  seq: number;
  ts: number;
  dimension: GuardrailDimension;
  limitValue: number;
  observedValue: number;
  configSource: 'default' | 'workspace';
  payload: unknown;
}

export type ExportDestinationKind = 'directory' | 's3';

export interface ExportDestinationStatus {
  destination: ExportDestinationKind;
  location: string | null;
  status: 'succeeded' | 'failed';
  lastAttemptAt: string;
  file: string | null;
  error: string | null;
  retry: { count: number; max: number; nextRetryAt: string | null; exhausted: boolean } | null;
}

export interface ExportDelivery {
  status: 'succeeded' | 'failed';
  at: string;
  error: string | null;
  retry: number;
  nextRetryAt: string | null;
}

/** `GET /api/export/destinations`: the last delivery per Destination; absent when it never delivered. */
export type ExportDeliveryState = Partial<Record<ExportDestinationKind, ExportDelivery>>;

export interface ExportSummary {
  name: string | null;
  disposition: string;
  builtAt: string;
  bytes: number | null;
  partial: boolean;
  redactions: Record<string, number> | null;
  destinations: ExportDestinationStatus[];
}

/** `GET /api/tasks/:id/export`. */
export interface TaskExportStatus {
  exportable: boolean;
  latest: ExportSummary | null;
  earlier: ExportSummary[];
}

export interface TaskExportAgainResult {
  outcomes: { destination: ExportDestinationKind; status: 'succeeded' | 'failed'; file: string | null; error: string | null }[];
  export: TaskExportStatus;
}

/** One chronological audit record from the ticket-wide lifecycle projection. */
export type TicketTimelineKind =
  | 'attempt-started'
  | 'attempt-finished'
  | 'lifecycle'
  | 'step-run'
  | 'guardrail'
  | 'operator-retry'
  | 'agent-message'
  | 'fact';

/** One chronological audit record from the ticket-wide lifecycle projection. */
export type TicketTimelineEvent = {
  [K in TicketTimelineKind]: { attemptId: number | null; ts: number; kind: K; data: unknown };
}[TicketTimelineKind];

export type AgentMessageReceipt = 'queued' | 'delivered' | 'held' | 'refused';

export interface AgentMessageRecipient {
  taskId: number;
  receipt: AgentMessageReceipt;
  mode?: 'mid-turn' | 'next-turn';
  deliveredAt?: number;
  reason?: string;
  deleted: boolean;
}

export interface AgentMessage {
  messageId: string;
  role: string;
  parts: { kind: 'text'; text: string }[];
  replyTo: string | null;
  threadId: string;
  senderTaskId: number;
  senderDeleted: boolean;
  senderAttemptId: number;
  senderAttemptNumber: number | null;
  workspaceId: number;
  createdAt: number;
  recipients: AgentMessageRecipient[];
}

export interface AgentMessageThreadParticipant {
  taskId: number;
  title: string | null;
  harness: string | null;
  epicId: TrackerRef | null;
  deleted: boolean;
  model: string | null;
  state: TaskState | null;
  betweenAttempts: boolean;
  attemptNumber: number | null;
  sends: number;
  sendCap: number;
  lastMessageAt: number | null;
}

export interface AgentMessageThread {
  threadId: string;
  workspaceId: number;
  workspaceName: string;
  latestAt: number;
  live: boolean;
  messages: AgentMessage[];
  participants: AgentMessageThreadParticipant[];
}

/** Tracker mirroring: a Task is authored here or a 1:1 projection of a tracker issue. */
export type TaskOrigin = 'native' | 'mirrored';
export type IssueWorkflow = 'wayfinder' | 'implement';
export type WayfinderType = 'research' | 'prototype' | 'grilling' | 'task';

/** Dollar value of Usage, computed server-side on read — never stored. */
export interface Cost {
  /** Sum over priced models; null when nothing could be priced. */
  totalUsd: number | null;
  /** $ per model; null for models without a price entry. */
  byModel: Record<string, number | null>;
  /** True when some tokens could not be priced — the total is a floor. */
  incomplete: boolean;
}

/**
 * A derived Map rollup as `GET /api/maps` serves it — the
 * server's `mapSchema`: a `wayfinder:map` issue paired with its member Tasks and
 * per-state counts. Query-time, not stored; kept in lockstep with the route.
 */
export interface MapRollup {
  workspaceId: number;
  ref: TrackerRef;
  title: string;
  url: string;
  /** Tracker refs of the mirrored Tasks under this Map. */
  taskRefs: TrackerRef[];
  /** Task count per state present under this Map. */
  counts: Record<string, number>;
}

/** One immediate child directory from `GET /api/fs`. */
export interface FsEntry {
  name: string;
  /** Absolute path — feed straight back as `?path=` to descend into it. */
  path: string;
}

/** The immediate child directories of one path, for the lazy directory picker. */
export interface FsListing {
  /** The absolute path that was browsed (the resolved home when none was given). */
  path: string;
  /** The parent directory's absolute path, or `null` at the filesystem root. */
  parent: string | null;
  entries: FsEntry[];
}

export interface ClassifierEndpoint {
  baseUrl: string;
  model: string;
  apiKeySecret: string;
}

export interface ModelOption {
  id: string;
  harness: string;
  model: string;
  description: string;
  disabled?: boolean;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  excluded: boolean;
}

export interface WorkspaceFileListing {
  path: string;
  entries: WorkspaceFileEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface WorkspaceFile {
  text: string | null;
  mime: string;
  size: number;
  isBinary: boolean;
  isTooLarge: boolean;
}

export type NotificationSeverity = 'failure' | 'escalation' | 'merge' | 'export';

export interface Notification {
  id: number;
  severity: NotificationSeverity;
  title: string;
  detail: string | null;
  workspaceId: number | null;
  taskId: number | null;
  createdAt: number;
  readAt: number | null;
  read: boolean;
}

export type GitStatusCode = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

export interface GitStatusEntry {
  path: string;
  indexStatus: GitStatusCode;
  worktreeStatus: GitStatusCode;
}

/**
 * A Workspace's Resolved Tracker, as the API flattens it: a display
 * `label` when resolved, else a coded `reason` it can't. A discriminated union so
 * `ok` narrows which fields are present, matching the flat JSON on the wire.
 */
export type ResolvedTracker =
  | { ok: true; label: string; kind: string; source: TrackerSource; code: null; reason: null }
  | { ok: false; label: null; kind: null; source: null; code: TrackerResolveFailureCode; reason: string };

export interface JSONSchemaObject {
  type?: string;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

export interface JSONSchemaProperty {
  type?: string | string[];
  enum?: unknown[];
  title?: string;
  description?: string;
  default?: unknown;
  minimum?: number;
  [key: string]: unknown;
}

export interface TrackerKindInfo {
  id: string;
  label: string;
  secretNames: string[];
  settingsSchema: JSONSchemaObject;
  capabilities: Record<string, unknown>;
}

export type CodeRepositoryKind = 'github' | 'gitlab' | 'forgejo' | 'git';

export interface TrackerDetection {
  detectedTracker: { name: string; kind: string | null } | null;
  detectedCodeRepository: CodeRepositoryKind | null;
  repoDocTriageLabels: NonNullable<Workspace['triageLabels']>;
}

export type VerifyResult = { ok: true; identity: string } | { ok: false; reason: string };

export type TrackerSource = 'configured' | 'detected' | 'code-repository';

/** A Workspace: a named Working Directory, unique by absolute path. */
export interface Workspace {
  id: number;
  name: string;
  workingDir: string;
  color: string;
  trackerEnabled: boolean;
  trackerPollIntervalSeconds: number;
  excludedDirectories: string[];
  /** The {@link ResolvedTracker}; `null` when tracking is off. */
  resolvedTracker: ResolvedTracker | null;
  /** Per-workspace setting overrides. `null` inherits the
   * global default; a value overrides it. Resolved at read time. */
  harness: string | null;
  model: string | null;
  /** Chat defaults; `null` inherits `config.chat.*`. */
  chatHarness: string | null;
  chatModel: string | null;
  isolationMode: 'direct' | 'worktree' | null;
  priority: 'high' | 'normal' | 'low' | null;
  /** Conflict-resolve bound; `null` inherits `config.defaults.*`. */
  conflictResolveTurns: number | null;
  maxConcurrentAttempts: number | null;
  autoRunnerEnabled: boolean | null;
  agentMessagesEnabled: boolean | null;
  agentMessagesSendCap: number | null;
  /** Agent Messages on for this Workspace after Baseline → Global → Workspace resolution. */
  effectiveAgentMessagesEnabled: boolean;
  /** Per-workspace attempt cap; null inherits `config.maxAttempts`. */
  maxAttempts: number | null;
  contextReuseTokenLimit: number | null;
  /** Routing Label overlay; `null` inherits every global Routing Label in order. */
  routingLabels: RoutingLabelOverlayEntry[] | null;
  /** `local` is always available; null inherits every enabled target. */
  executionTargets: string[] | null;
  workflow: string | null;
  epicWorkflow?: string | null;
  workflowLabels: WorkflowLabelOverlayEntry[] | null;
  workflowVars?: Record<string, Record<string, string | number | boolean>> | null;
  /** Model Option overlay; `null` inherits every global Model Option in order, enabled. */
  modelOptions: ModelOptionOverlayEntry[] | null;
  classifierEnabled: boolean | null;
  workflowClassifierEnabled?: boolean | null;
  classifierBackend: 'typesafe' | 'openai-compatible' | 'harness' | null;
  classifierTimeoutSeconds: number | null;
  classifierTypesafeModel: string | null;
  classifierTypesafeSecret: string | null;
  /** Harness and Model the Harness backend runs on; `null` uses the Workspace default. */
  classifierHarness: string | null;
  classifierModel: string | null;
  /** OpenAI-compatible endpoint for the Route Classifier; the API key lives in a Secret named by `apiKeySecret`. */
  classifierEndpoint: ClassifierEndpoint | null;
  /** Guardrail overrides; `null` inherits
   * `config.guardrails.{budget,progress}`. The budget reads back as the parsed
   * object shape it was PATCHed as. */
  guardrailBudget: BudgetGuardrail | null;
  guardrailProgress: boolean | null;
  exportEnabled: boolean | null;
  exportDirectoryPath: string | null;
  exportS3Endpoint: string | null;
  exportS3Region: string | null;
  exportS3Bucket: string | null;
  exportS3Prefix: string | null;
  exportS3ForcePathStyle: boolean | null;
  exportS3AccessKeyId: string | null;
  exportS3SecretAccessKey: string | null;
  exportRedactPatterns: { id: string; regex: string }[] | null;
  exportIncludeStates: ExportState[] | null;
  configuredTracker: { kind: string; settings?: Record<string, unknown> } | null;
  codeRepository: 'github' | 'gitlab' | 'forgejo' | 'git' | null;
  triageLabels: Partial<Record<'readyForAgent' | 'readyForHuman' | 'epic' | 'wayfinderMap', string>> | null;
  archiveRetentionDays: number | null;
  archiveRetentionMaxTotalMB: number | null;
  /** Tool-timeout override; `null` inherits `config.guardrails.toolTimeoutMinutes`. */
  toolTimeoutMinutes: number | null;
  /** Pause message override; `null` inherits `config.pauseMessage`. */
  pauseMessage: string | null;
  mergeEpicConflictPrompt: string | null;
  mergeEpicRefreshPrompt: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A command verifier: an argv-based check run against a
 * frozen candidate in a disposable checkout. Mirrors `verificationCommandSchema`. */
export interface VerificationCommand {
  /** Stable identity, independent of argv; assigned once, never editable. */
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  timeoutSeconds: number;
}

export interface EpicVerificationCritic {
  /** Stable identity, independent of `name` (not guaranteed unique). */
  id: string;
  /** Operator-facing label; the critic's row title in settings. */
  name: string;
  prompt: string;
  model: string;
  harness: string;
  /** Hard timeout in seconds for the critic's review turn (default 300). */
  timeoutSeconds: number;
}

export interface EpicVerificationStage {
  commands: VerificationCommand[];
  critics: EpicVerificationCritic[];
}

/** A Workspace Routing Label overlay entry; a `global` entry's `ref` is the global label, lowercased. */
export type RoutingLabelOverlayEntry =
  | { kind: 'global'; ref: string; enabled: boolean }
  | { kind: 'local'; enabled: boolean; routingLabel: { label: string; harness: string; model: string } };

export type WorkflowLabelOverlayEntry =
  | { kind: 'global'; ref: string; enabled: boolean }
  | { kind: 'local'; enabled: boolean; workflowLabel: { label: string; workflow: string } };

/** A Workspace Model Option overlay entry; a `global` entry's `ref` is the global option's code. */
export type ModelOptionOverlayEntry =
  | { kind: 'global'; ref: string; enabled: boolean }
  | { kind: 'local'; enabled: boolean; modelOption: ModelOption };

/** The budget Guardrail: a mandatory wall-clock bound per afk Attempt
 * plus optional token and cost caps (`null` = that cap is off). */
export interface BudgetGuardrail {
  wallClockMinutes: number;
  tokens: number | null;
  costUsd: number | null;
}

/** An Epic container in the Tasks table: no Task id, keyed by `trackerRef`. */
export type EpicListRow = Omit<Task, 'id' | 'prompt' | 'trackerRef'> & { trackerRef: TrackerRef };

/** A Tasks-table item: a Task row (has `id`) or an Epic row (no `id`). */
export type TaskListItem = Task | EpicListRow;

export const isEpicListRow = (row: TaskListItem): row is EpicListRow => !('id' in row);

export interface EpicBlocker {
  ref: string;
  kind: 'epic' | 'task';
  heldEpic: string;
  cycle: boolean;
}

export interface Task {
  id: number;
  /** Where the Ticket runs when it is not local; null for a local Ticket. */
  execution?: TaskExecution | null;
  /** The full prompt is served only on the item GET (`GET /api/tasks/:id`) and
   * the WS `task_changed` broadcast, never on a lean list row
   * — hence optional. List surfaces render {@link Task.summary} instead. */
  prompt?: string;
  /** The prompt's first line, bounded server-side: the card title
   * every list surface renders, so the Board never processes the full prompt.
   * Present on both list rows and the item GET. */
  summary: string;
  /** Ticket-scoped Model Option overrides (Ticket > Workspace > global); empty when none. */
  modelOptionOverrides: { id: string; harness: string; model: string }[];
  /** The owning Workspace. */
  workspaceId: number;
  /** Effective (resolved) Task defaults: a pinned override, else the
   * Workspace override, else the global default. `overrides` says
   * which of these were pinned vs inherited. */
  harness: string;
  model: string;
  workingDir: string;
  isolationMode: 'direct' | 'worktree';
  /** Explicit base branch a worktree Attempt is cut from and merges back onto
   *; null resolves at spawn to the working dir's
   * current branch. */
  baseBranch: string | null;
  priority: 'high' | 'normal' | 'low';
  /** Resolved conflict-resolve bound. */
  conflictResolveTurns: number;
  /** The defaults as stored: `null` ⇒ inherited (tracks the Workspace/
   * global default), a value ⇒ pinned to this Task. The editor seeds its
   * inherit/override toggles from these. */
  overrides: {
    harness: string | null;
    model: string | null;
    isolationMode: 'direct' | 'worktree' | null;
    priority: 'high' | 'normal' | 'low' | null;
    conflictResolveTurns: number | null;
  };
  /** The Routing Label matching a mirrored Ticket; `applied` is false when an operator's Harness/Model override wins. */
  routing: TaskRouting | null;
  /** What the Route Classifier did for this Ticket; null when it did not decide. */
  classifier: TaskClassifier | null;
  state: TaskState;
  /** Why the ticket is `escalated` — the trigger's recorded reason; null in every other state. */
  escalationReason: string | null;
  /** The machine-readable cause behind `escalationReason`, when it has one; null otherwise. */
  escalationCause: EscalationCause | null;
  /** Live merge indicator, orthogonal to `state`: 'merging' while the candidate merges onto base, 'resolving-conflicts' once that merge conflicts a human must settle; null at rest. */
  mergeStatus: MergeStatus | null;
  /** Merged, but the tracker ticket close is outstanding. */
  ticketClosePending: boolean;
  /** Feedback held for the next same-ticket Attempt, if any. */
  feedback: string | null;
  createdAt: number;
  updatedAt: number;
  dependsOn: number[];
  dependents: number[];
  /** Ready, and at least one blocker is escalated or cancelled — it will not unblock on its own. */
  blockedOnFailed: boolean;
  /** Blocker edges whose blocker is not done; blocked-ness is this count, never a state. */
  openBlockerCount: number;
  epicBlockers: EpicBlocker[];
  /** Derived flag: opted in (mirrored: `ready-for-agent`, not an Epic container) and no open blockers. */
  agentWorkable: boolean;
  /** A mirrored ticket Harmonic never works (no `ready-for-agent`, an Epic container, a human wayfinder kind); independent of blockers. */
  humanOnly: boolean;
  /** This ticket is an Epic container — some other mirrored ticket names it as its parent. Lets list surfaces mark and link it as an Epic, closed ones included. */
  isEpic: boolean;
  /** Summed over ALL runs, retries and failed attempts included. */
  cost: Cost | null;
  /** native = authored here; mirrored = a projection of a tracker issue. */
  origin: TaskOrigin;
  /** The mirrored issue's number; null on native Tasks. */
  trackerRef: TrackerRef | null;
  /** Mirrored role: which Issue Workflow the tracker labelled it; null on native Tasks. */
  issueWorkflow: IssueWorkflow | null;
  /** `name@version` of the workflow pinned when the Ticket started; null on Tickets on today's path. */
  workflowRef: string | null;
  workflowChosen: WorkflowChosen | null;
  workflowLabel?: string | null;
  /** The Workflow classifier's one-line reason when workflowChosen is 'classifier'; otherwise null. */
  workflowReason?: string | null;
  /** Mirrored role: the wayfinder decision kind; null on native/implement Tasks. */
  wayfinderType: WayfinderType | null;
  /** The parent Map's tracker ref; null when unmapped or native. */
  mapRef: TrackerRef | null;
  /** The mirrored issue's tracker URL, from the last poll; null on native Tasks or before a poll. */
  url: string | null;
  /** The parent Map's title, resolved from mapRef; null when unmapped or before a poll. */
  mapTitle: string | null;
  /** The display name of the tracker a mirrored Task came from; null on native Tasks or an unresolved tracker. */
  trackerLabel: string | null;
  /** The latest run's branch (worktree mode only); null in direct mode or before any run. */
  branch: string | null;
  /** The latest run's `git diff --stat`, snapshotted at merging; null until then or in direct mode. */
  stat: string | null;
  /** The running run's `startedAt`; null unless the Task is working. */
  runStartedAt: number | null;
  /** Total tool-call count of the running run; null unless the Task is working. */
  toolCount: number | null;
  /** The running run's id, so the board can match the `attempt_usage` firehose to this card; null unless the Task is working. */
  attemptId: number | null;
  /** The running Attempt's running step run; null unless a step is executing. */
  currentStep: { stepId: string; action: string; kind: StepRunKind } | null;
  /** The running run's context-window occupancy in tokens; null unless running (or unreported). Live via the attempt_usage firehose. */
  contextTokens: number | null;
  /** The model's effective context window; null when unknown. The board card shows `ctx %` = contextTokens/contextWindow. */
  contextWindow: number | null;
  /** The latest run's verified branch head ref;
   * null when no attempt has produced a verified head yet. Whether Accept has
   * work to merge is `hasCandidate`, not this. */
  verifiedRef: string | null;
  /** Whether the branch holds a candidate (commits ahead of base) an Accept could merge. */
  hasCandidate: boolean;
  /** Transient scheduler-pick skip reason for a `ready` Task whose Work
   * Context is already occupied (e.g. "Work Context held by task
   * 12 (working)"); null normally, including once the Task starts working. */
  skipReason: string | null;
  /** The Kubernetes Execution Target this Ticket waits for; null when it waits on none. */
  targetWait: { target: string; disabled: boolean; running: number; limit: number | null; position: number } | null;
  /** Epoch ms; null unless working with a budgeted running Attempt. */
  wallClockDeadline: number | null;
}

/** Aggregate token counters on an Attempt's usage snapshot, as the ticket UI
 * reads them; all optional/nullable because a source may report only some counters. */
export interface AttemptUsageTotals {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  /** Harness-native spend units (e.g. Copilot AI Units); absent when the harness has none. */
  aiUnits?: number | null;
}

/** The lean Attempt summary as `GET /api/tasks/:id/attempts`, `GET
 * /api/attempts/:id`, and the WS `attempt_changed` payload serve it (server
 * `attemptSchema`); distinct from the timeline's step-bearing {@link Attempt}. */
export interface AttemptSummary {
  id: number;
  taskId: number;
  number: number;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  reason: string | null;
  stopReason: string | null;
  sessionId: string | null;
  /** Legacy: the prompt stored on Attempts that predate the Archive-only Resolved Prompt read; null on every newer Attempt, whose prompts the transcript reads from the Archive. */
  prompt: string | null;
  branch: string | null;
  baseBranch: string | null;
  /** The PR/MR the open-PR Merge Fate opened for this Attempt; null when none was opened. */
  pullRequestUrl: string | null;
  usage: {
    totals: AttemptUsageTotals | null;
    models: Record<string, ModelUsage>;
    /** Per-agent-type breakdown (root session + each Subagent type); absent when
     * the harness parsed no Process Tree, or on Attempts recorded before it existed. */
    agents?: Record<string, ModelUsage>;
    /** Output tokens and API-equivalent cost attributed per tool; absent
     * on an ACP-only harness that reports no parseable turns. */
    toolTokens?: Record<string, ToolTokenAttribution>;
    /** Output tokens (and cost) from turns that called no tool; absent likewise. */
    reasoning?: ToolTokenAttribution;
    toolCalls: Record<string, number>;
    source: string | null;
  } | null;
  cost: Cost | null;
  /** Total tool calls this Attempt's session made.
   * Always present on the wire; optional here so partial test fixtures need not
   * set it, and every reader floors it with `?? 0`. */
  toolCalls?: number;
  /** The root session's latest context-window fill and the model's window
   * (config override, else shipped default); null when unknown. */
  contextTokens?: number | null;
  contextWindow?: number | null;
  startedAt: number;
  finishedAt: number | null;
}

/** The owner-neutral execution facts in an Epic's Attempt timeline. */
export interface EpicAttempt {
  id: number;
  number: number;
  state: AttemptState;
  reason: string | null;
  usage: AttemptUsage | null;
  cost: Cost | null;
  toolCalls: number;
  contextTokens: number | null;
  startedAt: number;
  endedAt: number | null;
  stepRuns: StepRun[];
  /** Resolved Prompts this Attempt sent to Epic resolvers, oldest first. */
  resolverPrompts: EpicResolverPrompt[];
}

export interface EpicResolverPrompt {
  kind: 'merge-conflict' | 'verification' | 'refresh';
  locator: string;
  promptIndex: number;
  ts: number;
}

/** A Task's continuation preview, as `GET
 * /api/tasks/:id/continuation` serves it: whether the Task has a live Session
 * to continue, and if so the two re-attempt paths on offer — resume the same
 * Session/conversation in full, or start a new Session on a condensed
 * conversation. `available:false` means there's no live Session (a plain
 * re-attempt, unchanged). */
export type ContinuationPreview =
  | { available: false }
  | {
      available: true;
      /** The pre-selected path: continue the same Session, or start a fresh one —
       * decided from warmth AND context size. */
      recommended: 'continue' | 'fresh';
      /** Why `recommended` was chosen, for the one-line reason shown to the operator. */
      reason: 'continued-within-limits' | 'context-tokens' | 'session-cold' | 'missing-context-tokens';
      /** The resumable Attempt's context-window occupancy in raw tokens; null when unknown. */
      contextTokens: number | null;
      /** At or above this occupancy, a fresh Session is recommended over continuing. */
      contextReuseTokenLimit: number;
      continueFull: {
        session: 'same';
        conversation: 'full';
        estimate: {
          band: 'warm' | 'cold' | 'unknown';
          warm: boolean;
          warmthKnown: boolean;
          estimatedWarmUntil: number | null;
          msSinceActive: number;
          msUntilCold: number | null;
          /** Human-legible cost sentence for the operator. */
          note: string;
        };
      };
      /** The condensed path's cost signal: a fresh Session
       * re-primed from a summary, its `band` computed **relative to** the full
       * continuation (`estimateCondensedContinuationCost`). `cold` (amber,
       * "pricier") only when the full path is a warm cache hit that beats a cold
       * summary re-prime; otherwise `warm` (calm, cheaper). `note` is the
       * operator-legible one-liner. */
      startCondensed: {
        session: 'new';
        conversation: 'condensed';
        estimate: {
          band: 'warm' | 'cold' | 'unknown';
          note: string;
        };
      };
    };

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk';

export interface DiffLine {
  kind: DiffLineKind;
  /** Pre-image line number; null on an added or hunk-header line. */
  oldLn: number | null;
  /** Post-image line number; null on a deleted or hunk-header line. */
  newLn: number | null;
  /** The line's content, without the leading +/-/space diff marker. */
  text: string;
}

export interface DiffFile {
  path: string;
  status: 'M' | 'A' | 'D';
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export interface AttemptEvent {
  id: number;
  /** The Attempt this event is keyed to (`attempt_events.attempt_id`). */
  attemptId: number;
  seq: number;
  ts: number;
  type: 'session_update' | 'permission_request' | 'lifecycle';
  payload: unknown;
}

/** A renderer-compatible event parsed from a native harness transcript. */
export interface AttemptLogEvent {
  id: number;
  /** Present for live WebSocket events; REST transcript hydration is already scoped by URL. */
  attemptId?: number;
  /** Set once the server tags live events with their step run. */
  stepRunId?: number;
  seq: number;
  ts: number;
  type: 'session_update';
  payload: { sessionUpdate: string; [key: string]: unknown };
}

/**
 * A Conversation: an interactive, multi-turn live chat the operator drives
 * with an agent Harness over ACP — a sibling to Task, not a queued unit of
 * work. `title` is null until named/derived; a fresh skeleton
 * conversation may carry a null title indefinitely.
 */
export interface Conversation {
  id: number;
  title: string | null;
  /** The owning Workspace. */
  workspaceId: number;
  harness: string;
  model: string;
  workingDir: string;
  permissionMode: 'ask' | 'automatic';
  state: 'active' | 'ended';
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  /** Running usage accumulated across this Conversation's Turns;
   * null before any usage has merged. */
  usage: {
    totals: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number | null;
    } | null;
    models: Record<string, Record<string, number>>;
    toolCalls: Record<string, number>;
    source: string | null;
  } | null;
  /** Derived from `usage` + configured prices; honest-incomplete like Task's
   * `cost`. */
  cost: Cost | null;
  /** The latest Turn's input-side token footprint (context fill); null when
   * unknown. */
  contextTokens: number | null;
  /** The model's configured context window; null when unconfigured — the
   * telemetry strip shows raw tokens instead of a fabricated percentage
   *. */
  contextWindow: number | null;
  /** The configured harness cache warm period, in seconds. */
  cacheWarmSeconds: number | null;
  coldResume?: boolean;
  commands?: AdvertisedCommand[];
  commandPrefix?: string;
}

export interface AdvertisedCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/**
 * Byte-identical in shape to RunEvent, but keyed by conversationId and
 * adding a 'user_turn' type for the operator's own message (payload:
 * `{ text: string }`) — the boundary the transcript segments turns on.
 */
export interface ConversationEvent {
  id: number;
  conversationId: number;
  seq: number;
  ts: number;
  type: 'session_update' | 'permission_request' | 'elicitation_request' | 'lifecycle' | 'user_turn';
  payload: unknown;
}

/** One choice in a `select`/`multiselect` elicitation field. `value` is what
 * the answer records; `preview` is optional rich focus content. */
export interface ElicitationOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

/** One question in a form elicitation, already parsed from ACP's JSON-Schema
 * into a render-ready shape (see src/acp/elicitation-request.ts). */
export interface ElicitationField {
  key: string;
  title?: string;
  description?: string;
  kind: 'select' | 'multiselect' | 'text' | 'boolean';
  options?: ElicitationOption[];
  optional: boolean;
}

/** The structured question a Harness is blocked on, carried on the
 * `elicitation_request` WS message and, once answered, on the resolving
 * `conversation_event`'s payload (`{ request, answer, reqId }`). */
export interface ElicitationFormRequest {
  message: string;
  toolCallId?: string;
  fields: ElicitationField[];
}

/** The operator's answer to a form elicitation, sent to the answer endpoint. */
export type ElicitationAnswer =
  | { action: 'accept'; content: Record<string, string | string[] | boolean> }
  | { action: 'decline' }
  | { action: 'cancel' };

/**
 * One selectable resolution to a pending ACP permission request.
 * `allow_always`/`reject_always` persist beyond this one
 * tool call within the harness session; only the options the
 * ACP request actually offers are ever rendered.
 */
export interface PermissionAcpRequestOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

/** The ACP permission request the Harness is blocked on, carried verbatim
 * on the `permission_request` WS message and, once answered, on the
 * resolving `conversation_event`'s payload (`{ request, outcome, reqId }`). */
export interface PermissionAcpRequest {
  sessionId: string;
  toolCall?: { toolCallId?: string; title?: string; kind?: string };
  options: PermissionAcpRequestOption[];
}

/**
 * A persistent auto-approval escalation: matching
 * future permission requests — same tool `kind` + Working Directory, any
 * Conversation — resolve server-side with no prompt. Operator-visible and
 * revocable in Settings; deleting one makes matching requests prompt again.
 */
export interface PermissionRule {
  id: number;
  kind: string;
  workingDir: string;
  createdAt: number;
}

export interface Channel {
  id: number;
  name: string;
  type: 'discord' | 'slack' | 'webhook' | 'email';
  config: Record<string, any>;
  events: string[];
}

export interface HarnessConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  models: ModelCatalogEntry[];
  defaultModel: string;
  cacheWarmSeconds: number;
  permissionMode?: string;
  sessionLogDir?: string;
}

export interface ModelCatalogEntry {
  id: string;
  price?: ModelPrice;
  contextWindow?: number;
}

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface HarnessProvider { id: string; label: string; authed: boolean; }
export interface DiscoveredHarnessModel { id: string; label: string; price?: ModelPrice; contextWindow?: number; }

/** Per-model token counters (server `ModelUsage`) — the four counters Cost prices, plus optional harness-native spend. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Harness-native spend units (e.g. Copilot AI Units); absent when the harness has none. */
  aiUnits?: number;
}

/** Output tokens (and API-equivalent cost) attributed to one tool or the
 * reasoning bucket; `cost` is absent when the tokens are unpriced. */
export interface ToolTokenAttribution {
  outputTokens: number;
  cost?: number;
}

/** Usage aggregate for an Attempt or Conversation (server `AttemptUsage`) — rolled up over the whole Process Tree. */
export interface AttemptUsage {
  /** Per-model breakdown (session-log fallback; ACP only reports aggregates). */
  models: Record<string, ModelUsage>;
  /** Per-agent-type breakdown (root session + each Subagent type); absent when the harness parsed no Process Tree. */
  agents?: Record<string, ModelUsage>;
  /** Output tokens and API-equivalent cost attributed from parseable turns. */
  toolTokens?: Record<string, ToolTokenAttribution>;
  /** Parsed output from turns that did not call a tool. */
  reasoning?: ToolTokenAttribution;
  /** Aggregate token counts; null when no source reported tokens. */
  totals: (ModelUsage & { totalTokens: number | null }) | null;
  /** Tool-call tallies from the process's events. */
  toolCalls: Record<string, number>;
  source: 'acp' | 'session-log' | 'combined' | null;
}

export type ProcessStatus = 'active' | 'inactive' | 'hidden';

/** One node of a Process Tree (server `ProcessNode`): the root session or a recursive Subagent, with its *own* tokens. */
export interface ProcessNode {
  id: string;
  name: string;
  model: string;
  usage: ModelUsage;
  contextTokens: number | null;
  lastTool: string | null;
  status: ProcessStatus;
  depth: number;
  toolUseId: string | null;
  children: ProcessNode[];
}
export type ProcessTree = ProcessNode;

/**
 * One live process in the instance-wide Activity snapshot (
 * `GET /api/activity`): an in-flight Attempt or a warm Conversation, joined with
 * its latest Usage, context fill, and derived Cost. `startedAt` is the source
 * of truth for elapsed — the client ticks it live. A Conversation's
 * `tree`/`activity` are null (no live tailer) and its `escalated` is always false.
 */
export interface ActivityProcess {
  type: 'attempt' | 'chat';
  attemptId: number | null;
  conversationId: number | null;
  taskId: number | null;
  /** Display title: an Attempt's Task prompt first line, a Conversation's title. */
  title: string;
  workspaceId: number;
  /** The owning Workspace's name — the view spans Workspaces. */
  workspaceName: string;
  harness: string;
  model: string;
  /** A running Run's RunState, or a warm Conversation's ConversationState. */
  state: string;
  isolation: string;
  /** Epoch ms the process started; the client derives elapsed from it. */
  startedAt: number;
  trackerRef: TrackerRef | null;
  /** The mirrored issue's tracker URL — the row's ticket deep-link; null on native Tasks, Conversations, or before a poll. */
  trackerUrl: string | null;
  /** True when the Task is escalated — the "Needs you" signal; always false for a Conversation. */
  escalated: boolean;
  usage: AttemptUsage | null;
  contextTokens: number | null;
  /** The model's configured context window; null when unconfigured (percentage suppressed). */
  contextWindow: number | null;
  /** One-line "what the agent is doing now" (Attempts only); null for a Conversation. */
  activity: string | null;
  tree: ProcessTree | null;
  cost: Cost | null;
}

/**
 * The live `attempt_usage` firehose delta: an Attempt's latest live-usage
 * snapshot plus Cost derived on read. The Activity view merges it into the
 * matching row so tokens, context fill, cost, and the activity line tick live
 * between snapshot polls.
 */
export interface AttemptUsageEvent {
  attemptId: number;
  usage: AttemptUsage;
  contextTokens: number | null;
  activity: string | null;
  tree: ProcessTree;
  cost: Cost | null;
}

/**
 * One Attempt as a fleet-Timeline span (`GET /api/timeline`): its lane (harness),
 * outcome, and the window it occupied. Reads persisted history, so it spans
 * finished work the live Activity snapshot no longer retains. A still-running
 * Attempt has a null `endedAt`; the Timeline extends its bar to now.
 */
export interface TimelineAttempt {
  taskId: number;
  attemptId: number;
  number: number;
  title: string;
  harness: string;
  model: string;
  /** An AttemptState: 'running' | 'passed' | 'failed' | 'escalated' | 'cancelled'. */
  state: string;
  trackerRef: TrackerRef | null;
  startedAt: number;
  endedAt: number | null;
  /** Frozen Cost for a finished Attempt; null while running or when nothing was priceable. */
  cost: Cost | null;
  workspace: Pick<Workspace, 'id' | 'name' | 'color'>;
}

export interface TimelineResponse {
  attempts: TimelineAttempt[];
  from: number;
  to: number;
}

export interface AppConfig {
  /** Operator display name for this instance; empty string means unnamed (UI falls back to "Harmonic"). */
  name: string;
  harnesses: Record<string, HarnessConfig>;
  defaults: {
    harness: string;
    isolationMode: 'direct' | 'worktree';
    priority: 'high' | 'normal' | 'low';
    /** Conflict-resolve bound. */
    conflictResolveTurns: number;
    workflow: string | null;
    epicWorkflow: string | null;
  };
  /** The default Harness and model a new Conversation ("chat") starts with,
   * separate from the Task defaults. Global-default with a per-Workspace
   * override, resolved server-side at Conversation-create time. */
  chat: {
    harness: string;
    model: string;
  };
  /** Folders hidden from the Files browser and directory pickers; seeds each new Workspace. */
  excludedDirectories: string[];
  routingLabels: { label: string; harness: string; model: string }[];
  workflowLabels: { label: string; workflow: string }[];
  modelOptions: ModelOption[];
  autoRunner: { enabled: boolean; maxConcurrentAttempts: number };
  agentMessages: { enabled: boolean; sendCap: number };
  /** Global classifier defaults; a Workspace's own `classifier*` values win. */
  classifier: {
    workflowEnabled: boolean;
    enabled: boolean;
    backend: 'typesafe' | 'openai-compatible' | 'harness';
    timeoutSeconds: number;
    typesafeModel: string;
    typesafeSecret: string | null;
    harness: string | null;
    model: string | null;
  };
  /** Per-stage command and critic verifier lists. */
  verify: {
    epic: { preMerge: EpicVerificationStage; resolvePrompt: string; resolveSuffix: string };
  };
  /** Attempt Guardrails: the global-default budget bounds, progress
   * toggle, and tool-timeout a Workspace inherits until it overrides them. */
  guardrails: { budget: BudgetGuardrail; progress: boolean; toolTimeoutMinutes: number };
  /** How mirrored Tasks are driven: prompt and branch fate. */
  drive: {
    /** The Drive Prompt template, with {taskId}/{skill}/{ref}/{url}/{title}/{description} placeholders. The default omits {title}/{description} — the agent fetches the issue itself. */
    prompt: string;
    /** Appended to every auto-driven turn, with {taskId} placeholder. */
    unattendedReminder: string;
    /** The re-prompt nudge sent when a turn ends without finish/escalate, with {taskId} placeholder. */
    continuePrompt: string;
    /** Sent when an Attempt ends its turn with uncommitted changes. No placeholders. */
    commitNudge: string;
  };
  /** Merge-conflict resolver prompts, with {turn}/{taskBranch}/{baseBranch}/{paths}/${{ prompts.conflictResolution }} placeholders. */
  merge: { postMergeCheck: boolean; conflictPrompt: string; epicConflictPrompt: string; epicRefreshPrompt: string };
  /** Reuse a warm Session into the next attempt while its context occupancy stays
   * below this many tokens; at or above it, start a condensed new Session. */
  contextReuseTokenLimit: number;
  editor: {
    maxFileSizeBytes: number;
  };
  /** The Task Prompt template for native Attempts, with {prompt}/{id}/{workingDir}/{harness}/{model} placeholders. */
  taskPrompt: string;
  pauseMessage: string;
  archive: { retain: { days: number | null; maxTotalMB: number | null } };
  /** S3 credentials arrive masked (`********`) when set; writing the mask back keeps the stored value. */
  export: {
    enabled: boolean;
    includeStates: ExportState[];
    directory: { path: string | null };
    s3: {
      endpoint: string | null;
      region: string | null;
      bucket: string | null;
      prefix: string;
      forcePathStyle: boolean;
      accessKeyId: string | null;
      secretAccessKey: string | null;
    };
    redact: { patterns: { id: string; regex: string }[] };
  };
}

export type ExportState = 'done' | 'cancelled' | 'deleted';

export interface ExportDestinationTestResult {
  destination: 'directory' | 's3';
  ok: boolean;
  error?: string;
  testedAt: string;
}

export interface ConfigLayers {
  baseline: AppConfig;
  global: AppConfig;
  harnessPermissionModes: Record<string, { modes: Record<string, string>; defaultMode: string }>;
}

export type CredentialHarness = 'claude' | 'codex' | 'copilot' | 'opencode';
export type CredentialKind = 'oauth-token' | 'api-key';

export interface TargetCredential {
  harness: CredentialHarness;
  kind: CredentialKind;
  harnessConfigured: boolean;
  set: boolean;
  secretName: string;
  updatedAt: string | null;
}

export interface ExecutionTarget {
  name: string;
  builtIn: boolean;
  enabled: boolean;
  authMethod: 'kubeconfig' | 'in-cluster' | null;
  namespace: string | null;
  defaultImage: string | null;
  cpu: string | null;
  memory: string | null;
  concurrencyLimit: number | null;
  repositoryProxyUrl: string | null;
  kubeconfig: { set: boolean; secretName: string | null; updatedAt: number | null } | null;
  proxyKey: { set: boolean; secretName: string; rotatedAt: number | null } | null;
  credentials: TargetCredential[];
  running: number;
  waiting: number;
  createdAt: number | null;
  updatedAt: number | null;
}

export type ExecutionTargetFields = Pick<ExecutionTarget, 'enabled' | 'authMethod' | 'namespace' | 'defaultImage' | 'cpu' | 'memory' | 'concurrencyLimit' | 'repositoryProxyUrl'>;

export interface ExecutionTargetBody {
  name: string;
  enabled: boolean;
  authMethod: 'kubeconfig' | 'in-cluster';
  namespace: string;
  defaultImage: string;
  cpu: string;
  memory: string;
  concurrencyLimit: number;
  repositoryProxyUrl: string;
}

export interface ProxyKeyRotation {
  key: string;
  rotatedAt: number;
  revokedRunning: number;
}

export type ProxyKeyCheck = 'agrees' | 'rejected' | 'unreachable';

export interface DeletionImpact {
  running: number;
  waiting: number;
  total: number;
}

export type ConnectionOutcome = 'connected' | 'unauthorized' | 'namespace-not-found' | 'unreachable' | 'invalid-kubeconfig';

export interface ConnectionTestResult {
  ok: boolean;
  outcome: ConnectionOutcome;
  message: string;
  podCount?: number;
  namespace: string;
  secretName: string | null;
}

export interface ConnectionTestRequest {
  name?: string;
  authMethod: 'kubeconfig' | 'in-cluster';
  namespace: string;
  kubeconfig?: string;
}

export interface WorkspaceTargetItem {
  name: string;
  builtIn: boolean;
  globallyEnabled: boolean;
  allowed: boolean;
  effective: boolean;
  ineffectiveReason: string | null;
  refusal: string | null;
}

export interface WorkspaceTargets {
  restricted: boolean;
  codeRepository: string | null;
  isolationMode: 'direct' | 'worktree';
  targets: WorkspaceTargetItem[];
}

export interface Prompt {
  code: string;
  description: string;
  text: string;
  bundled: boolean;
  resolved: string;
  usedBy: string[];
  usedBySteps: PromptStepUse[];
  updatedAt: string | null;
}

export interface PromptStepUse {
  workflow: string;
  stepId: string;
}
