import type { Verdict } from './verification-model.js';

/** The stored Ticket states (ADR-0041); blocked-ness and agent-workability are derived, never stored. */
export const TASK_STATES = ['draft', 'ready', 'working', 'escalated', 'done', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** The Run phase machine (ADR reliability-design §0.2, issue #114/#171), in
 * traversal order; mirrors the server's `RUN_PHASES` (`domain/run-phases.ts`). */
export const RUN_PHASES = ['executing', 'validating', 'verifying', 'landing', 'terminal'] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export type AttemptState = 'running' | 'passed' | 'failed' | 'escalated' | 'cancelled';
export type AttemptTaskType = 'rebase' | 'implementation' | 'verification' | 'review';
export type AttemptTaskState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled';

export interface AttemptTask {
  id: number;
  attemptId: number;
  type: AttemptTaskType;
  position: number;
  state: AttemptTaskState;
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
  continuation: {
    path: 'continued-session' | 'new-session-condensed';
    reason: 'continued-within-limits' | 'context-usage' | 'session-cold' | 'missing-context-usage' | 'missing-warm-window';
    contextUsage: number | null;
    contextReuseThreshold: number;
    lastActiveAt: number;
    lastActiveAgeMs: number;
    warmWindowMs: number | null;
  } | null;
  tasks: AttemptTask[];
}

/** A budget dimension a Guardrail can trip on (ADR-0019, issue #171); mirrors
 * the server's `GUARDRAIL_DIMENSIONS` (`db/schema.ts`). */
export type GuardrailDimension = 'wall-clock' | 'tokens' | 'cost' | 'progress' | 'tool-timeout';

/** One persisted Guardrail-trip event (issue #171), as `GET
 * /api/runs/:id/guardrail-events` serves it — mirrors the server's
 * `GuardrailEventRow` (`domain/guardrail-events.ts`). `limitValue`/
 * `observedValue` are in the dimension's own unit (ms for wall-clock and
 * tool-timeout, tokens for tokens, USD for cost, a sentinel 0/count for
 * progress); `payload` carries dimension-specific evidence. */
export interface GuardrailEvent {
  id: number;
  runId: number;
  seq: number;
  ts: number;
  dimension: GuardrailDimension;
  phase: RunPhase;
  limitValue: number;
  observedValue: number;
  configSource: 'default' | 'workspace';
  payload: unknown;
}

/** A Verification mechanism (ADR-0021, issue #132): a command verifier runs an
 * argv check against a frozen candidate; a critic verifier is a read-only
 * agent reviewer. Mirrors the server's `VERIFICATION_MECHANISMS`. */
export type VerificationMechanism = 'critic' | 'command';

/** One persisted Verification-attempt event (issue #169, part of #109), as
 * `GET /api/runs/:id/verification-attempts` serves it — mirrors the server's
 * `VerificationAttemptRow` (`domain/verification-attempts.ts`). A Run's
 * self-heal retries append further attempts for the same `mechanism`, so the
 * log is append-only and `seq`-ordered; the latest attempt per mechanism is
 * the one that currently governs the Verification outcome (see
 * `verification-attempts-model.ts`). */
export interface VerificationAttempt {
  id: number;
  runId: number;
  seq: number;
  ts: number;
  mechanism: VerificationMechanism;
  inputOid: string;
  verdict: Verdict;
  summary: string;
  output: string;
  phase: RunPhase;
  mutated: boolean;
  /** Whether a critic-session transcript can be read for this attempt
   * (ADR-0040) — fetch it with `api.criticLog(id)`. */
  hasTranscript: boolean;
}

/** One chronological audit record from the ticket-wide lifecycle projection. */
export interface TicketTimelineEvent {
  runId: number | null;
  ts: number;
  kind:
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
  data: unknown;
}

/** Tracker mirroring (issue #30): a Task is authored here or a 1:1 projection of a tracker issue. */
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

/** One immediate child directory from `GET /api/fs` (issue #62). */
export interface FsEntry {
  name: string;
  /** Absolute path — feed straight back as `?path=` to descend into it. */
  path: string;
}

/** The immediate child directories of one path, for the lazy directory picker (issue #62). */
export interface FsListing {
  /** The absolute path that was browsed (the resolved home when none was given). */
  path: string;
  /** The parent directory's absolute path, or `null` at the filesystem root. */
  parent: string | null;
  entries: FsEntry[];
}

/**
 * A Workspace's Resolved Tracker (issue #83), as the API flattens it: a display
 * `label` when resolved, else a coded `reason` it can't. A discriminated union so
 * `ok` narrows which fields are present, matching the flat JSON on the wire.
 */
export type ResolvedTracker =
  | { ok: true; label: string; code: null; reason: null }
  | { ok: false; label: null; code: string; reason: string };

/** A Workspace (ADR-0008): a named Working Directory, unique by absolute path. */
export interface Workspace {
  id: number;
  name: string;
  workingDir: string;
  trackerEnabled: boolean;
  trackerPollIntervalSeconds: number;
  /** The {@link ResolvedTracker} (issue #83); `null` when tracking is off. */
  resolvedTracker: ResolvedTracker | null;
  /** Per-workspace setting overrides (ADR-0012, issue #64). `null` inherits the
   * global default; a value overrides it. Resolved at read time (issue #60). */
  harness: string | null;
  model: string | null;
  /** Chat defaults (ADR-0012); `null` inherits `config.chat.*`. */
  chatHarness: string | null;
  chatModel: string | null;
  isolationMode: 'direct' | 'worktree' | null;
  priority: 'high' | 'normal' | 'low' | null;
  maxConcurrentRuns: number | null;
  autoRunnerEnabled: boolean | null;
  /** Per-workspace attempt cap; null inherits `config.maxAttempts`. */
  maxAttempts: number | null;
  contextReuseThreshold: number | null;
  /** Verification overrides (ADR-0021, issues #132/#138/#165/#174), tri-state for
   * the command and critic: `null` inherits the global `config.verify` default,
   * {@link VerifierOff} explicitly disables the verifier for this Workspace, and a
   * configured object overrides it. Both read back as the shape they were PATCHed
   * as. */
  verificationCommand: VerificationCommand | VerifierOff | null;
  verificationCritic: VerificationCritic | VerifierOff | null;
  /** Guardrail overrides (ADR-0019, issue #166); `null` inherits
   * `config.guardrails.{budget,progress}`. The budget reads back as the parsed
   * object shape it was PATCHed as. */
  guardrailBudget: BudgetGuardrail | null;
  guardrailProgress: boolean | null;
  createdAt: number;
  updatedAt: number;
}

/** A command verifier (ADR-0021, issue #132): an argv-based check run against a
 * frozen candidate in a disposable checkout. Mirrors `verificationCommandSchema`. */
export interface VerificationCommand {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  timeoutSeconds: number;
}

/** An agent critic verifier (ADR-0021, issue #132): a read-only reviewer with
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

/** The sentinel a Workspace stores to force a verifier off for itself (issue
 * #174), distinct from inheriting the global default. Mirrors `verifierOffSchema`. */
export interface VerifierOff {
  off: true;
}

/** The budget Guardrail (ADR-0019): a mandatory wall-clock bound per afk Run
 * plus optional token and cost caps (`null` = that cap is off). */
export interface BudgetGuardrail {
  wallClockMinutes: number;
  tokens: number | null;
  costUsd: number | null;
}

export interface Task {
  id: number;
  prompt: string;
  /** The owning Workspace (ADR-0008). */
  workspaceId: number;
  /** Effective (resolved) Task defaults: a pinned override, else the
   * Workspace override, else the global default (ADR-0012). `overrides` says
   * which of these were pinned vs inherited. */
  harness: string;
  model: string;
  workingDir: string;
  isolationMode: 'direct' | 'worktree';
  /** Explicit base branch a worktree Run is cut from and lands back onto
   * (issue #157, ADR-0024); null resolves at spawn to the working dir's
   * current branch. */
  baseBranch: string | null;
  priority: 'high' | 'normal' | 'low';
  /** The four defaults as stored: `null` ⇒ inherited (tracks the Workspace/
   * global default), a value ⇒ pinned to this Task. The editor seeds its
   * inherit/override toggles from these. */
  overrides: {
    harness: string | null;
    model: string | null;
    isolationMode: 'direct' | 'worktree' | null;
    priority: 'high' | 'normal' | 'low' | null;
  };
  state: TaskState;
  /** Why the ticket is `escalated` — the trigger's recorded reason (ADR-0041); null in every other state. */
  escalationReason: string | null;
  /** Feedback held for the next same-ticket Attempt, if any. */
  feedback: string | null;
  createdAt: number;
  updatedAt: number;
  dependsOn: number[];
  dependents: number[];
  /** Ready, and at least one blocker is escalated or cancelled — it will not unblock on its own. */
  blockedOnFailed: boolean;
  /** Blocker edges whose blocker is not done; blocked-ness is this count, never a state (ADR-0041). */
  openBlockerCount: number;
  /** ADR-0041's derived flag: opted in (mirrored: `ready-for-agent`, not an Epic container) and no open blockers. */
  agentWorkable: boolean;
  /** A mirrored ticket Harmonic never works (no `ready-for-agent`, an Epic container, a human wayfinder kind); independent of blockers. */
  humanOnly: boolean;
  /** Summed over ALL runs, retries and failed attempts included. */
  cost: Cost | null;
  /** native = authored here; mirrored = a projection of a tracker issue (issue #30). */
  origin: TaskOrigin;
  /** The mirrored issue's number; null on native Tasks. */
  trackerRef: number | null;
  /** Mirrored role: which workflow the tracker labelled it; null on native Tasks. */
  workflow: Workflow | null;
  /** Mirrored role: the wayfinder decision kind; null on native/implement Tasks. */
  wayfinderType: WayfinderType | null;
  /** The parent Map's tracker ref; null when unmapped or native. */
  mapRef: number | null;
  /** The mirrored issue's tracker URL, from the last poll; null on native Tasks or before a poll (issue #35). */
  url: string | null;
  /** The parent Map's title, resolved from mapRef; null when unmapped or before a poll (issue #34). */
  mapTitle: string | null;
  /** The latest run's branch (worktree mode only); null in direct mode or before any run. */
  branch: string | null;
  /** The latest run's `git diff --stat`, snapshotted at landing; null until then or in direct mode. */
  stat: string | null;
  /** The running run's `startedAt`; null unless the Task is working (issue #100). */
  runStartedAt: number | null;
  /** Total tool-call count of the running run; null unless the Task is working (issue #100). */
  toolCount: number | null;
  /** The running run's id, so the board can match the `run_usage` firehose to this card; null unless the Task is working (issue #100). */
  runId: number | null;
  /** The running run's phase, for the Board's Active-card status badge; null unless the Task is working (or a pre-phase-machine run). */
  phase: RunPhase | null;
  /** The running run's context-window occupancy in tokens; null unless running (or unreported). Live via the run_usage firehose (issue #52). */
  contextTokens: number | null;
  /** The model's effective context window; null when unknown. The board card shows `ctx %` = contextTokens/contextWindow (issue #52). */
  contextWindow: number | null;
  /** The latest run's verified branch head ref (issue #134's Run `candidateRef`),
   * surfaced so an escalated Task shows whether Accept has work to land; null
   * when no run has produced a candidate yet. */
  candidateRef: string | null;
  /** Transient House-Rule reason a `ready` Task is being skipped for a held
   * Work Context lease (issue #171, e.g. "Work Context held by task 12
   * (working)"); null normally, including once the Task starts working. */
  skipReason: string | null;
}

/** Aggregate token counters on a `Run`'s usage snapshot, as the ticket UI reads
 * them; all optional/nullable because a source may report only some counters. */
export interface RunUsageTotals {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  /** Harness-native spend units (e.g. Copilot AI Units); absent when the harness has none. */
  aiUnits?: number | null;
}

export interface Run {
  id: number;
  taskId: number;
  attempt: number;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  /** Phase within the Run lifecycle; `null` for pre-feature Runs (issue #114). */
  phase: RunPhase | null;
  reason: string | null;
  stopReason: string | null;
  sessionId: string | null;
  /** The exact prompt text sent to the harness for this Run; null for
   * pre-feature Runs and while a Run is still starting up. */
  prompt: string | null;
  branch: string | null;
  baseBranch: string | null;
  usage: {
    totals: RunUsageTotals | null;
    models: Record<string, Record<string, number>>;
    toolCalls: Record<string, number>;
    source: string | null;
  } | null;
  cost: Cost | null;
  startedAt: number;
  finishedAt: number | null;
}

/** A Task's continuation preview (issue #170), as `GET
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
      /** The condensed path's cost signal (issue #177): a fresh Session
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

export interface RunEvent {
  id: number;
  runId: number;
  seq: number;
  ts: number;
  type: 'session_update' | 'permission_request' | 'lifecycle';
  payload: any;
}

/** A renderer-compatible event parsed from a native harness transcript. */
export interface RunLogEvent {
  id: number;
  /** Present for live WebSocket events; REST transcript hydration is already scoped by URL. */
  runId?: number;
  seq: number;
  ts: number;
  type: 'session_update';
  payload: { sessionUpdate: string; [key: string]: unknown };
}

/**
 * A Conversation: an interactive, multi-turn live chat the operator drives
 * with an agent Harness over ACP — a sibling to Task, not a queued unit of
 * work. `title` is null until named/derived (issue #15); a fresh skeleton
 * conversation may carry a null title indefinitely.
 */
export interface Conversation {
  id: number;
  title: string | null;
  /** The owning Workspace (ADR-0008). */
  workspaceId: number;
  harness: string;
  model: string;
  workingDir: string;
  state: 'active' | 'ended';
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  /** Running usage accumulated across this Conversation's Turns (issue #12);
   * null before any usage has landed. */
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
   * `cost` (issue #12). */
  cost: Cost | null;
  /** The latest Turn's input-side token footprint (context fill); null when
   * unknown (issue #12). */
  contextTokens: number | null;
  /** The model's configured context window; null when unconfigured — the
   * telemetry strip shows raw tokens instead of a fabricated percentage
   * (issue #12). */
  contextWindow: number | null;
  /** The model's configured cache TTL, in seconds; null when unconfigured —
   * the telemetry strip never shows the cold-cache estimate in that case
   * (issue #12). */
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
 * One selectable resolution to a pending ACP permission request (issue #11's
 * LOCKED contract). `allow_always`/`reject_always` persist beyond this one
 * tool call within the harness session; the "always allow in {dir}" variant
 * is issue #13 and deliberately out of scope here — only the options the
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
 * A persistent auto-approval escalation (issue #13 / ADR-0007): matching
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

/** Usage aggregate for a Run or Conversation (server `RunUsage`) — rolled up over the whole Process Tree. */
export interface RunUsage {
  /** Per-model breakdown (session-log fallback; ACP only reports aggregates). */
  models: Record<string, ModelUsage>;
  /** Per-agent-type breakdown (root session + each Subagent type); absent when the harness parsed no Process Tree. */
  agents?: Record<string, ModelUsage>;
  /** Output tokens and API-equivalent cost attributed from parseable turns. */
  toolTokens?: Record<string, { outputTokens: number; cost?: number }>;
  /** Parsed output from turns that did not call a tool. */
  reasoning?: { outputTokens: number; cost?: number };
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
   * Activity drill-in frames its transcript on (issue #53); null for the root. */
  toolUseId: string | null;
  children: ProcessNode[];
}
export type ProcessTree = ProcessNode;

/**
 * One live process in the instance-wide Activity snapshot (issue #52,
 * `GET /api/activity`): an in-flight Run or a warm Conversation, joined with
 * its latest Usage, context fill, and derived Cost. `startedAt` is the source
 * of truth for elapsed — the client ticks it live. A Conversation's
 * `tree`/`activity` are null (no live tailer) and its `escalated` is always false.
 */
export interface ActivityProcess {
  type: 'run' | 'chat';
  runId: number | null;
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
  /** The mirrored issue's tracker URL — the row's ticket deep-link (issue #55); null on native Tasks, Conversations, or before a poll. */
  trackerUrl: string | null;
  /** True when the Task is escalated (ADR-0041) — the "Needs you" signal; always false for a Conversation. */
  escalated: boolean;
  usage: RunUsage | null;
  contextTokens: number | null;
  /** The model's configured context window; null when unconfigured (percentage suppressed). */
  contextWindow: number | null;
  /** One-line "what the agent is doing now" (Runs only); null for a Conversation. */
  activity: string | null;
  tree: ProcessTree | null;
  cost: Cost | null;
}

/**
 * The live `run_usage` firehose delta (ADR 0010): a Run's latest live-usage
 * snapshot plus Cost derived on read. The Activity view merges it into the
 * matching row so tokens, context fill, cost, and the activity line tick live
 * between snapshot polls.
 */
export interface RunUsageEvent {
  runId: number;
  usage: RunUsage;
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
  };
  /** The default Harness and model a new Conversation ("chat") starts with,
   * separate from the Task defaults. Global-default with a per-Workspace
   * override (ADR-0012), resolved server-side at Conversation-create time. */
  chat: {
    harness: string;
    model: string;
  };
  autoRunner: { enabled: boolean; maxConcurrentRuns: number };
  /** Ordered verification commands and the optional review task. */
  verify: {
    commands: VerificationCommand[];
    review: VerificationReview;
  };
  /** Run Guardrails (ADR-0019): the global-default budget bounds and progress
   * toggle a Workspace inherits until it overrides them (issue #166).
   * `toolTimeoutMinutes` is global-only (no per-Workspace override). */
  guardrails: { budget: BudgetGuardrail; progress: boolean; toolTimeoutMinutes: number };
  /** How mirrored Tasks are driven (issue #33): prompt and branch fate. */
  drive: {
    /** The Drive Prompt template, with {skill}/{ref}/{url}/{title}/{body} placeholders. The default omits {title}/{body} — the agent fetches the issue itself. */
    prompt: string;
    /** Appended to every auto-driven turn, with {taskId} placeholder. */
    unattendedReminder: string;
    /** The re-prompt nudge sent when a turn ends without finish/escalate, with {taskId} placeholder. */
    continuePrompt: string;
    mergeFate: 'auto-merge' | 'open-PR' | 'artifact';
  };
  /** Maximum implementation attempts before the ticket is escalated. */
  maxAttempts: number;
  /** The Task Prompt template for native Runs, with {prompt}/{id}/{workingDir}/{harness}/{model} placeholders. */
  taskPrompt: string;
}
