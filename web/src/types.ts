import type { TrackerResolveFailureCode } from '../../src/tracker/adapter.js';
import type { PromptFragmentOverrides, PromptFragments } from '../../src/domain/prompt-fragments.js';
import type { Verdict } from '../../src/verification/critic-schema.js';

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
export type StepType = 'rebase' | 'implementation' | 'verification' | 'review';
export type StepState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled';

export interface Step {
  id: number;
  attemptId: number;
  type: StepType;
  position: number;
  state: StepState;
  command: string | null;
  verdict: string | null;
  logLocator: string | null;
  startedAt: number | null;
  endedAt: number | null;
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
  /** Branch tip this attempt's verification proved; null until verification ran. */
  verifiedSha: string | null;
  /** Why this attempt handed the ticket to a human; null unless it escalated. */
  escalationReason: string | null;
  /** Read-time command and critic outcomes for this Attempt. */
  verifierStatuses: VerifierStatus[];
  continuation: {
    path: 'continued-session' | 'new-session-condensed';
    reason: 'continued-within-limits' | 'context-tokens' | 'session-cold' | 'missing-context-tokens' | 'missing-warm-window';
    contextTokens: number | null;
    contextReuseTokenLimit: number;
    lastActiveAt: number;
    lastActiveAgeMs: number;
    warmWindowMs: number | null;
  } | null;
  steps: Step[];
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

/** A Verification mechanism: a command verifier runs an
 * argv check against a frozen candidate; a critic verifier is a read-only
 * agent reviewer. Mirrors the server's `VERIFICATION_MECHANISMS`. */
export type VerificationMechanism = 'critic' | 'command';

/** One verifier category's current read-time status, including categories that did not run. */
export interface VerifierStatus {
  mechanism: VerificationMechanism;
  verifier?: string;
  state: 'passed' | 'failed' | 'inconclusive' | 'skipped' | 'disabled' | 'unrunnable' | 'planned' | 'running';
  reason: string | null;
  /** The ordered command plan; `command` mechanism only. */
  commands?: string[];
  /** The resolved review harness that will drive the critic; `critic` mechanism
   * only. Labels the running critic before its persisted attempt row exists. */
  harness?: string | null;
}

/** One persisted Verification-attempt event, as
 * `GET /api/attempts/:id/verification-attempts` serves it — mirrors the server's
 * `VerificationAttemptRow` (`domain/verification-attempts.ts`). A Task's
 * self-heal retries append further attempts for the same `mechanism`, so the
 * log is append-only and `seq`-ordered; the latest attempt per mechanism is
 * the one that currently governs the Verification outcome (see
 * `verification-attempts-model.ts`). */
export interface VerificationAttempt {
  id: number;
  /** The Attempt this row is keyed to. */
  attemptId: number;
  seq: number;
  ts: number;
  mechanism: VerificationMechanism;
  inputOid: string;
  verdict: Verdict;
  summary: string;
  output: string;
  /** Archive locator of the critic's Resolved Prompt — read it with
   * `api.resolvedPrompt(attemptId, promptLocator)`; null for a command verifier
   * and for rows with no archived prompt. */
  promptLocator: string | null;
  /** The critic harness that drove this attempt (may differ from the builder's);
   * null for a command verifier or a pre-feature row. */
  harness: string | null;
  /** Whether a critic-session transcript can be read for this attempt
   * — fetch it with `api.criticLog(id)`. */
  hasTranscript: boolean;
  /** The command output was capped; the full text is served by `api.verificationOutputUrl(id)`. */
  outputTruncated: boolean;
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
  | 'verification'
  | 'guardrail'
  | 'operator-reject'
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
export type Workflow = 'wayfinder' | 'implement';
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
}

export type VerifyResult = { ok: true; identity: string } | { ok: false; reason: string };

export type TrackerSource = 'configured' | 'detected' | 'code-repository';

/** A Workspace: a named Working Directory, unique by absolute path. */
export interface Workspace extends PromptFragmentOverrides {
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
  taskPreMergeCommands: CommandOverlayEntry[] | null;
  taskPreMergeCritics: TaskCriticOverlayEntry[] | null;
  taskPostMergeCommands: CommandOverlayEntry[] | null;
  taskPostMergeCritics: TaskCriticOverlayEntry[] | null;
  epicPreMergeCommands: CommandOverlayEntry[] | null;
  epicPreMergeCritics: EpicCriticOverlayEntry[] | null;
  /** Routing Label overlay; `null` inherits every global Routing Label in order. */
  routingLabels: RoutingLabelOverlayEntry[] | null;
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
  /** Drive overrides, decomposed into independently-inheritable
   * fields; each `null` inherits the matching global `config.drive.*`. */
  drivePrompt: string | null;
  driveUnattendedReminder: string | null;
  driveContinuePrompt: string | null;
  driveCommitNudge: string | null;
  driveMergeFate: 'auto-merge' | 'open-PR' | 'artifact' | null;
  driveContinueAttempts: number | null;
  /** Task Prompt override; `null` inherits `config.taskPrompt`. */
  taskPrompt: string | null;
  /** Pause message override; `null` inherits `config.pauseMessage`. */
  pauseMessage: string | null;
  mergeConflictPrompt: string | null;
  mergeEpicConflictPrompt: string | null;
  mergeEpicRefreshPrompt: string | null;
  verifyEpicResolveSuffix: string | null;
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

/** An agent critic verifier: a read-only reviewer with
 * its own prompt and model. Mirrors `verificationCriticSchema`. */
export interface TaskVerificationCritic {
  /** Stable identity, independent of `name` (not guaranteed unique). */
  id: string;
  /** Operator-facing label; the critic's row title in settings. */
  name: string;
  issuePrompt: string;
  noIssuePrompt: string;
  model: string;
  /** Reviewer harness; omitted = reuse the builder task's harness. */
  harness?: string;
  /** Hard timeout in seconds for the critic's review turn (default 300). */
  timeoutSeconds: number;
}

export interface EpicVerificationCritic {
  /** Stable identity, independent of `name` (not guaranteed unique). */
  id: string;
  /** Operator-facing label; the critic's row title in settings. */
  name: string;
  prompt: string;
  model: string;
  /** Reviewer harness; omitted = reuse the builder task's harness. */
  harness?: string;
  /** Hard timeout in seconds for the critic's review turn (default 300). */
  timeoutSeconds: number;
}

export interface TaskVerificationStage {
  commands: VerificationCommand[];
  critics: TaskVerificationCritic[];
}

export interface EpicVerificationStage {
  commands: VerificationCommand[];
  critics: EpicVerificationCritic[];
}

/**
 * A Workspace's additive command overlay entry (ADR-0037): a `global` entry
 * reorders/disables a global command by `ref` (its id) without editing it; a
 * `local` entry inlines a Workspace-owned command, fully editable.
 */
export type CommandOverlayEntry =
  | { kind: 'global'; ref: string; enabled: boolean }
  | { kind: 'local'; enabled: boolean; command: VerificationCommand };

/** The task-critic counterpart of {@link CommandOverlayEntry}. */
export type TaskCriticOverlayEntry =
  | { kind: 'global'; ref: string; enabled: boolean }
  | { kind: 'local'; enabled: boolean; critic: TaskVerificationCritic };

/** The epic-critic counterpart of {@link CommandOverlayEntry}. */
export type EpicCriticOverlayEntry =
  | { kind: 'global'; ref: string; enabled: boolean }
  | { kind: 'local'; enabled: boolean; critic: EpicVerificationCritic };

/** A Workspace Routing Label overlay entry; a `global` entry's `ref` is the global label, lowercased. */
export type RoutingLabelOverlayEntry =
  | { kind: 'global'; ref: string; enabled: boolean }
  | { kind: 'local'; enabled: boolean; routingLabel: { label: string; harness: string; model: string } };

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

export interface Task {
  id: number;
  /** The full prompt is served only on the item GET (`GET /api/tasks/:id`) and
   * the WS `task_changed` broadcast, never on a lean list row
   * — hence optional. List surfaces render {@link Task.summary} instead. */
  prompt?: string;
  /** The prompt's first line, bounded server-side: the card title
   * every list surface renders, so the Board never processes the full prompt.
   * Present on both list rows and the item GET. */
  summary: string;
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
  routing: { label: string; applied: boolean } | null;
  state: TaskState;
  /** Why the ticket is `escalated` — the trigger's recorded reason; null in every other state. */
  escalationReason: string | null;
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
  /** Mirrored role: which workflow the tracker labelled it; null on native Tasks. */
  workflow: Workflow | null;
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
  /** The running run's current Attempt Step, for the
   * Board's Active-card status badge; null unless the Task is working, or
   * between Steps (e.g. mid-merge). */
  currentStep: StepType | null;
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
  steps: Step[];
  /** Every command and critic record from this whole-Epic verification. */
  verificationAttempts: VerificationAttempt[];
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
  };
  /** The default Harness and model a new Conversation ("chat") starts with,
   * separate from the Task defaults. Global-default with a per-Workspace
   * override, resolved server-side at Conversation-create time. */
  chat: {
    harness: string;
    model: string;
  };
  routingLabels: { label: string; harness: string; model: string }[];
  autoRunner: { enabled: boolean; maxConcurrentAttempts: number };
  agentMessages: { enabled: boolean; sendCap: number };
  /** Per-stage command and critic verifier lists. */
  verify: {
    task: { preMerge: TaskVerificationStage; postMerge: TaskVerificationStage };
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
    mergeFate: 'auto-merge' | 'open-PR' | 'artifact';
    /** How many times an Attempt that ended its turn without finish/escalate is re-prompted to continue before it is treated as unresolved and verified. 0 keeps single-turn behaviour. */
    continueAttempts: number;
  };
  /** Merge-conflict resolver prompts, with {turn}/{taskBranch}/{baseBranch}/{paths}/{fragment.conflictResolution} placeholders. */
  merge: { postMergeCheck: boolean; conflictPrompt: string; epicConflictPrompt: string; epicRefreshPrompt: string };
  /** Maximum implementation attempts before the ticket is escalated. */
  maxAttempts: number;
  /** Reuse a warm Session into the next attempt while its context occupancy stays
   * below this many tokens; at or above it, start a condensed new Session. */
  contextReuseTokenLimit: number;
  editor: {
    maxFileSizeBytes: number;
  };
  /** The Task Prompt template for native Attempts, with {prompt}/{id}/{workingDir}/{harness}/{model} placeholders. */
  taskPrompt: string;
  pauseMessage: string;
  /** Shared Prompt Fragments, referenced from prompts as `{fragment.<name>}`. */
  promptFragments: PromptFragments;
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
