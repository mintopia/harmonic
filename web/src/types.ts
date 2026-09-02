import type { Verdict } from '../../src/verification/critic-schema.js';

/** The stored Ticket states; blocked-ness and agent-workability are derived, never stored. */
export const TASK_STATES = ['draft', 'ready', 'working', 'escalated', 'done', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const MERGE_STATUSES = ['merging', 'resolving-conflicts'] as const;
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
  /** Read-time command and critic outcomes for this attempt's owning Run. */
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
  state: 'passed' | 'failed' | 'inconclusive' | 'skipped' | 'disabled' | 'unrunnable' | 'planned' | 'running';
  reason: string | null;
  /** The ordered command plan; `command` mechanism only. */
  commands?: string[];
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
  /** The exact prompt sent to the critic for this attempt; null for a command
   * verifier (which sends no prompt) and pre-feature rows. */
  prompt: string | null;
  /** Whether a critic-session transcript can be read for this attempt
   * — fetch it with `api.criticLog(id)`. */
  hasTranscript: boolean;
}

/** One chronological audit record from the ticket-wide lifecycle projection. */
export type TicketTimelineKind =
  | 'attempt-started'
  | 'attempt-finished'
  | 'lifecycle'
  | 'verification'
  | 'guardrail'
  | 'escalation'
  | 'operator-accept'
  | 'operator-reject'
  | 'fact';

/** One chronological audit record from the ticket-wide lifecycle projection. */
export type TicketTimelineEvent = {
  [K in TicketTimelineKind]: { attemptId: number | null; ts: number; kind: K; data: unknown };
}[TicketTimelineKind];

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
  ref: number;
  title: string;
  url: string;
  /** Tracker refs of the mirrored Tasks under this Map. */
  taskRefs: number[];
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

/**
 * A Workspace's Resolved Tracker, as the API flattens it: a display
 * `label` when resolved, else a coded `reason` it can't. A discriminated union so
 * `ok` narrows which fields are present, matching the flat JSON on the wire.
 */
export type ResolvedTracker =
  | { ok: true; label: string; code: null; reason: null }
  | { ok: false; label: null; code: string; reason: string };

/** A Workspace: a named Working Directory, unique by absolute path. */
export interface Workspace {
  id: number;
  name: string;
  workingDir: string;
  trackerEnabled: boolean;
  trackerPollIntervalSeconds: number;
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
  /** Per-workspace attempt cap; null inherits `config.maxAttempts`. */
  maxAttempts: number | null;
  contextReuseTokenLimit: number | null;
  /** Verification overrides. The
   * command verifier is list-grain, exactly mirroring the global editor: `null`
   * inherits the global `config.verify.commands` list, an empty array turns
   * verification off for this Workspace (no commands run here), and a
   * non-empty array overrides the whole ordered list. It reads back as the
   * shape it was PATCHed as. */
  verificationCommand: VerificationCommand[] | null;
  /**
   * Critic-review override, decomposed into four
   * independently-inheritable scalars: null inherits the matching global
   * `config.verify.review.*`, a value overrides it. "Off" is `reviewEnabled:false`.
   */
  reviewEnabled: boolean | null;
  reviewPrompt: string | null;
  reviewModel: string | null;
  reviewHarness: string | null;
  /** Guardrail overrides; `null` inherits
   * `config.guardrails.{budget,progress}`. The budget reads back as the parsed
   * object shape it was PATCHed as. */
  guardrailBudget: BudgetGuardrail | null;
  guardrailProgress: boolean | null;
  /** Tool-timeout override; `null` inherits `config.guardrails.toolTimeoutMinutes`. */
  toolTimeoutMinutes: number | null;
  /** Drive overrides, decomposed into independently-inheritable
   * fields; each `null` inherits the matching global `config.drive.*`. */
  drivePrompt: string | null;
  driveUnattendedReminder: string | null;
  driveContinuePrompt: string | null;
  driveMergeFate: 'auto-merge' | 'open-PR' | 'artifact' | null;
  driveContinueAttempts: number | null;
  /** Task Prompt override; `null` inherits `config.taskPrompt`. */
  taskPrompt: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A command verifier: an argv-based check run against a
 * frozen candidate in a disposable checkout. Mirrors `verificationCommandSchema`. */
export interface VerificationCommand {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  timeoutSeconds: number;
}

/** An agent critic verifier: a read-only reviewer with
 * its own prompt and model. Mirrors `verificationCriticSchema`. */
export interface VerificationCritic {
  prompt: string;
  model: string;
  /** Reviewer harness; omitted = reuse the builder task's harness. */
  harness?: string;
}

/** The optional review task that runs after every verification command passes. */
export interface VerificationReview {
  enabled: boolean;
  prompt?: string;
  model?: string;
  harness?: string;
}

/** The budget Guardrail: a mandatory wall-clock bound per afk Run
 * plus optional token and cost caps (`null` = that cap is off). */
export interface BudgetGuardrail {
  wallClockMinutes: number;
  tokens: number | null;
  costUsd: number | null;
}

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
  /** Explicit base branch a worktree Run is cut from and merges back onto
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
  state: TaskState;
  /** Why the ticket is `escalated` — the trigger's recorded reason; null in every other state. */
  escalationReason: string | null;
  /** Live merge indicator, orthogonal to `state`: 'merging' while the candidate merges onto base, 'resolving-conflicts' once that merge conflicts a human must settle; null at rest. */
  mergeStatus: MergeStatus | null;
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
  trackerRef: number | null;
  /** Mirrored role: which workflow the tracker labelled it; null on native Tasks. */
  workflow: Workflow | null;
  /** Mirrored role: the wayfinder decision kind; null on native/implement Tasks. */
  wayfinderType: WayfinderType | null;
  /** The parent Map's tracker ref; null when unmapped or native. */
  mapRef: number | null;
  /** The mirrored issue's tracker URL, from the last poll; null on native Tasks or before a poll. */
  url: string | null;
  /** The parent Map's title, resolved from mapRef; null when unmapped or before a poll. */
  mapTitle: string | null;
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
  /** The exact prompt text sent to the harness for this Attempt; null for
   * pre-feature Attempts and while an Attempt is still starting up. */
  prompt: string | null;
  branch: string | null;
  baseBranch: string | null;
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
  payload: any;
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
  /** The model's configured cache TTL, in seconds; null when unconfigured —
   * the telemetry strip never shows the cold-cache estimate in that case
   *. */
  cacheTtlSeconds: number | null;
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
  type: 'session_update' | 'permission_request' | 'lifecycle' | 'user_turn';
  payload: any;
}

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
  models: string[];
  defaultModel: string;
  sessionLogDir?: string;
}

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

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

/** Usage aggregate for a Run or Conversation (server `AttemptUsage`) — rolled up over the whole Process Tree. */
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
  status: ProcessStatus;
  depth: number;
  /** For a Subagent, the spawning `Agent`/`Task` tool-use id — the key the
   * Activity drill-in frames its transcript on; null for the root. */
  toolUseId: string | null;
  children: ProcessNode[];
}
export type ProcessTree = ProcessNode;

/**
 * One live process in the instance-wide Activity snapshot (
 * `GET /api/activity`): an in-flight Run or a warm Conversation, joined with
 * its latest Usage, context fill, and derived Cost. `startedAt` is the source
 * of truth for elapsed — the client ticks it live. A Conversation's
 * `tree`/`activity` are null (no live tailer) and its `escalated` is always false.
 */
export interface ActivityProcess {
  type: 'attempt' | 'chat';
  attemptId: number | null;
  conversationId: number | null;
  taskId: number | null;
  /** Display title: a Run's Task prompt first line, a Conversation's title. */
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
  trackerRef: number | null;
  /** The mirrored issue's tracker URL — the row's ticket deep-link; null on native Tasks, Conversations, or before a poll. */
  trackerUrl: string | null;
  /** True when the Task is escalated — the "Needs you" signal; always false for a Conversation. */
  escalated: boolean;
  usage: AttemptUsage | null;
  contextTokens: number | null;
  /** The model's configured context window; null when unconfigured (percentage suppressed). */
  contextWindow: number | null;
  /** One-line "what the agent is doing now" (Runs only); null for a Conversation. */
  activity: string | null;
  tree: ProcessTree | null;
  cost: Cost | null;
}

/**
 * The live `attempt_usage` firehose delta: a Run's latest live-usage
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

export interface AppConfig {
  /** Operator display name for this instance; empty string means unnamed (UI falls back to "Harmonic"). */
  name: string;
  harnesses: Record<string, HarnessConfig>;
  prices: Record<string, ModelPrice>;
  defaults: {
    harness: string;
    workingDir: string;
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
  autoRunner: { enabled: boolean; maxConcurrentAttempts: number };
  /** Ordered verification commands and the optional review task. */
  verify: {
    commands: VerificationCommand[];
    review: VerificationReview;
  };
  /** Run Guardrails: the global-default budget bounds, progress
   * toggle, and tool-timeout a Workspace inherits until it overrides them. */
  guardrails: { budget: BudgetGuardrail; progress: boolean; toolTimeoutMinutes: number };
  /** How mirrored Tasks are driven: prompt and branch fate. */
  drive: {
    /** The Drive Prompt template, with {skill}/{ref}/{url}/{title}/{body} placeholders. The default omits {title}/{body} — the agent fetches the issue itself. */
    prompt: string;
    /** Appended to every auto-driven turn, with {taskId} placeholder. */
    unattendedReminder: string;
    /** The re-prompt nudge sent when a turn ends without finish/escalate, with {taskId} placeholder. */
    continuePrompt: string;
    mergeFate: 'auto-merge' | 'open-PR' | 'artifact';
    /** How many times a Run that ended its turn without finish/escalate is re-prompted to continue before it is treated as unresolved and verified. 0 keeps single-turn behaviour. */
    continueAttempts: number;
  };
  /** Maximum implementation attempts before the ticket is escalated. */
  maxAttempts: number;
  /** Reuse a warm Session into the next attempt while its context occupancy stays
   * below this many tokens; at or above it, start a condensed new Session. */
  contextReuseTokenLimit: number;
  /** The Task Prompt template for native Runs, with {prompt}/{id}/{workingDir}/{harness}/{model} placeholders. */
  taskPrompt: string;
}
