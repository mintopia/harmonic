export const TASK_STATES = [
  'draft',
  'blocked',
  'ready',
  'running',
  'awaiting-review',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Tracker mirroring (issue #30): a Task is authored here or a 1:1 projection of a tracker issue. */
export type TaskOrigin = 'native' | 'mirrored';
export type Workflow = 'wayfinder' | 'implement';
export type WayfinderType = 'research' | 'prototype' | 'grilling' | 'task';
/** afk = Harmonic auto-runs it; hitl = a human drives it. */
export type Drive = 'afk' | 'hitl';

/** Dollar value of Usage, computed server-side on read — never stored. */
export interface Cost {
  /** Sum over priced models; null when nothing could be priced. */
  totalUsd: number | null;
  /** $ per model; null for models without a price entry. */
  byModel: Record<string, number | null>;
  /** True when some tokens could not be priced — the total is a floor. */
  incomplete: boolean;
}

export interface Task {
  id: number;
  prompt: string;
  harness: string;
  model: string;
  workingDir: string;
  isolationMode: 'direct' | 'worktree';
  priority: 'high' | 'normal' | 'low';
  state: TaskState;
  /** The original this task re-attempts, or null. */
  reattemptOf: number | null;
  /** Reviewer feedback that seeded this re-attempt, in full; null otherwise. */
  feedback: string | null;
  createdAt: number;
  updatedAt: number;
  dependsOn: number[];
  dependents: number[];
  blockedOnFailed: boolean;
  /** Task ids that re-attempt this one (reverse of reattemptOf). */
  reattempts: number[];
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
  /** Mirrored role: afk (Harmonic drives) | hitl (you drive); null on native Tasks. */
  drive: Drive | null;
  /** True when an afk Run escalated to a human at runtime (issue #33). */
  escalated: boolean;
  /** The parent Map's tracker ref; null when unmapped or native. */
  mapRef: number | null;
  /** The mirrored issue's tracker URL, from the last poll; null on native Tasks or before a poll (issue #35). */
  url: string | null;
  /** The parent Map's title, resolved from mapRef; null when unmapped or before a poll (issue #34). */
  mapTitle: string | null;
  /** The latest run's branch (worktree mode only); null in direct mode or before any run. */
  branch: string | null;
  /** The latest run's `git diff --stat`, snapshotted at settle; null until then or in direct mode. */
  stat: string | null;
}

export interface Run {
  id: number;
  taskId: number;
  attempt: number;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  reason: string | null;
  stopReason: string | null;
  sessionId: string | null;
  branch: string | null;
  baseBranch: string | null;
  usage: {
    totals: Record<string, number | null> | null;
    models: Record<string, Record<string, number>>;
    toolCalls: Record<string, number>;
    source: string | null;
  } | null;
  cost: Cost | null;
  review: 'accepted' | 'rejected' | null;
  reviewFeedback: string | null;
  reviewedAt: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface RunEvent {
  id: number;
  runId: number;
  seq: number;
  ts: number;
  type: 'session_update' | 'permission_request' | 'lifecycle';
  payload: any;
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

export interface AppConfig {
  harnesses: Record<string, HarnessConfig>;
  prices: Record<string, ModelPrice>;
  defaults: {
    harness: string;
    workingDir: string;
    isolationMode: 'direct' | 'worktree';
    priority: 'high' | 'normal' | 'low';
  };
  autoRunner: { enabled: boolean; maxConcurrentRuns: number };
  /** Poll the working directory's issue tracker and mirror issues onto the board (issue #30). */
  tracker: { enabled: boolean; pollIntervalSeconds: number };
  /** How afk mirrored Tasks are driven (issue #33): the prompt template, branch fate, and retry cap. */
  drive: {
    /** The Drive Prompt template, with {skill}/{ref}/{url}/{title}/{body} placeholders. */
    prompt: string;
    mergeFate: 'auto-merge' | 'open-PR' | 'artifact';
    autoRetry: number;
  };
  agentReview: boolean;
}
