import { sqliteTable, integer, text, primaryKey, index, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Verdict } from '../verification/critic-schema.js';
import type { TicketRef, TicketState } from '../tracker/adapter.js';

/** A Task is either authored here or a 1:1 projection of a tracker issue. */
export const TASK_ORIGINS = ['native', 'mirrored'] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];
export const WORKFLOWS = ['wayfinder', 'implement'] as const;
export type Workflow = (typeof WORKFLOWS)[number];
export const WAYFINDER_TYPES = ['research', 'prototype', 'grilling', 'task'] as const;
export type WayfinderType = (typeof WAYFINDER_TYPES)[number];

/** A mirrored issue's last successful scan, persisted verbatim; a field-for-field subset of the tracker `Ticket`. */
export interface TrackerFacts {
  state: TicketState;
  parent: number | null;
  blockedBy: TicketRef[];
  labels: string[];
  title: string;
  body: string;
  url: string;
  createdAt: string;
}

/** The stored Ticket states. Blocked-ness and agent-workability are derived, never stored. */
export const TASK_STATES = ['draft', 'ready', 'working', 'escalated', 'done', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** A named Working Directory, unique by absolute path. Its setting overrides live in the YAML settings file, not here. */
export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  workingDir: text('working_dir').notNull(),
  trackerEnabled: integer('tracker_enabled', { mode: 'boolean' }).notNull().default(false),
  trackerPollIntervalSeconds: integer('tracker_poll_interval_seconds').notNull().default(60),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  uniqueIndex('workspaces_working_dir_idx').on(t.workingDir),
]);

export type WorkspaceIdentityRow = typeof workspaces.$inferSelect;
/** Identity columns plus the setting overrides `WorkspaceService` composes in on read; `null` on an override field means inherit the global default. */
export type WorkspaceRow = WorkspaceIdentityRow & {
  harness: string | null; model: string | null; chatHarness: string | null; chatModel: string | null;
  isolationMode: string | null; priority: string | null;
  conflictResolveTurns: number | null; maxConcurrentAttempts: number | null; autoRunnerEnabled: boolean | null;
  maxAttempts: number | null; contextReuseTokenLimit: number | null; verificationCommand: string | null;
  reviewEnabled: boolean | null; reviewPrompt: string | null; reviewModel: string | null; reviewHarness: string | null;
  guardrailBudget: string | null; guardrailProgress: boolean | null; toolTimeoutMinutes: number | null;
  drivePrompt: string | null; driveUnattendedReminder: string | null; driveContinuePrompt: string | null;
  driveMergeFate: string | null; driveContinueAttempts: number | null; taskPrompt: string | null;
};

/** `jobKey` is the job name plus optional Workspace id, so SQLite's NULL-distinct unique semantics can't duplicate global job rows. */
export const scheduledJobs = sqliteTable('scheduled_jobs', {
  jobKey: text('job_key').primaryKey(),
  name: text('name').notNull(),
  workspaceId: integer('workspace_id').references(() => workspaces.id),
  lastRunAt: integer('last_run_at'),
  lastStatus: text('last_status').$type<'ok' | 'error'>(),
  lastDurationMs: integer('last_duration_ms'),
  lastError: text('last_error'),
});

export type ScheduledJobRow = typeof scheduledJobs.$inferSelect;

export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  prompt: text('prompt').notNull(),
  harness: text('harness'),
  model: text('model'),
  workingDir: text('working_dir').notNull(),
  isolationMode: text('isolation_mode'),
  priority: text('priority'),
  conflictResolveTurns: integer('conflict_resolve_turns'),
  state: text('state').$type<TaskState>().notNull(),
  /** Nullable only because SQLite can't ADD COLUMN NOT NULL without a default; every insert sets it. */
  workspaceId: integer('workspace_id').references(() => workspaces.id),
  /** Reviewer feedback that seeded this re-attempt, stored in full, separate from the prompt. */
  feedback: text('feedback'),
  /** Null ⇒ `'full'` (re-bind the warm Session and replay the conversation); `'condensed'` dispatches a fresh Session carrying only the reviewer feedback. */
  continuationChoice: text('continuation_choice').$type<'full' | 'condensed'>(),
  origin: text('origin').$type<TaskOrigin>().notNull().default('native'),
  /** The mirrored issue's portable number; the upsert key. Null on native Tasks. */
  trackerRef: integer('tracker_ref'),
  /** wayfinder (charting) | implement (build tickets). Derived from labels. */
  workflow: text('workflow').$type<Workflow>(),
  /** research/prototype/grilling/task; null for implement and native Tasks. */
  wayfinderType: text('wayfinder_type').$type<WayfinderType>(),
  /** Why the Ticket is `escalated`; null otherwise. */
  escalationReason: text('escalation_reason'),
  /** The parent Map issue's number, for the query-time Map rollup. Not a Dependency edge. */
  mapRef: integer('map_ref'),
  /** Null ⇒ resolved at spawn to the working dir's current branch. */
  baseBranch: text('base_branch'),
  /** The ticket's open/closed axis at last scan; null on native Tasks. Distinct from `state`, the Task's execution state. */
  trackerState: text('tracker_state').$type<TicketState>(),
  /** The ticket's parent pointer at last scan (the raw `#<n>` fact; `mapRef` is the derived Map rollup key). */
  trackerParent: integer('tracker_parent'),
  trackerBlockedBy: text('tracker_blocked_by', { mode: 'json' }).$type<TicketRef[]>(),
  trackerLabels: text('tracker_labels', { mode: 'json' }).$type<string[]>(),
  /** The ticket's title at last scan, verbatim (`prompt` is the derived title+body blend). */
  trackerTitle: text('tracker_title'),
  trackerBody: text('tracker_body'),
  trackerUrl: text('tracker_url'),
  trackerCreatedAt: text('tracker_created_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  // SQLite treats NULLs as distinct, so native Tasks (null trackerRef) are unconstrained.
  uniqueIndex('tasks_tracker_ref_idx').on(t.workspaceId, t.trackerRef),
  index('tasks_workspace_id_idx').on(t.workspaceId),
]);

/** Tombstone for a Dismissed mirrored Task: `mirrorScan` skips re-mirroring this (workspaceId, trackerRef). Deleting the row un-dismisses. */
export const trackerDismissals = sqliteTable('tracker_dismissals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id').references(() => workspaces.id),
  trackerRef: integer('tracker_ref').notNull(),
  dismissedAt: integer('dismissed_at').notNull(),
}, (t) => [
  uniqueIndex('tracker_dismissals_ws_ref_idx').on(t.workspaceId, t.trackerRef),
]);
export type TrackerDismissalRow = typeof trackerDismissals.$inferSelect;

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** A blocker edge: `taskId` cannot be worked until `blockerId` completes. */
export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id),
    dependsOnId: integer('depends_on_id')
      .notNull()
      .references(() => tasks.id),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnId] }),
    index('task_dependencies_depends_on_id_idx').on(t.dependsOnId),
  ],
);

/** One pass through a Ticket's implement → verify loop. */
export const ATTEMPT_STATES = ['running', 'passed', 'failed', 'escalated', 'cancelled'] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];
export const STEP_TYPES = ['rebase', 'implementation', 'verification', 'review'] as const;
export type StepType = (typeof STEP_TYPES)[number];
export const STEP_STATES = ['pending', 'running', 'passed', 'failed', 'skipped', 'cancelled'] as const;
export type StepState = (typeof STEP_STATES)[number];

export const attempts = sqliteTable('attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id').notNull().references(() => tasks.id),
  number: integer('number').notNull(),
  state: text('state').$type<AttemptState>().notNull().default('running'),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  /** Feedback from the failure that led to the following attempt. */
  feedback: text('feedback'),
  continuation: text('continuation'),
  /** The ending-signal kind: 'escalate' | 'failed' | 'process-death' | 'operator-cancel' | 'operator-accept' | 'guardrail-trip' | 'agent-finish/unresolved'. Free text lives in {@link detail}. */
  reason: text('reason'),
  /** ACP stopReason from the session/prompt result. */
  stopReason: text('stop_reason'),
  sessionId: text('session_id'),
  /** The `sessions.id` this Attempt is bound to; null until the harness session is created. */
  sessionRowId: integer('session_row_id').references((): AnySQLiteColumn => sessions.id),
  /** The exact prompt text sent to the harness; null until the prompt turn is sent. */
  prompt: text('prompt'),
  /** Worktree mode: the attempt's branch and the branch it was cut from. */
  branch: text('branch'),
  baseBranch: text('base_branch'),
  /** Immutable revisions for the settled worktree diff. They outlive the
   * attempt branch, which merging or cleanup can advance or delete. */
  diffBaseOid: text('diff_base_oid'),
  diffHeadOid: text('diff_head_oid'),
  /** `git diff --stat` snapshot taken at settle; null in direct mode or before settle. */
  stat: text('stat'),
  /** The branch-head OID captured at implementation end; null when nothing is verifiable. */
  verifiedHeadOid: text('verified_head_oid'),
  /** The private ref (`refs/harmonic/direct/attempt-<id>`) a direct Attempt's head is pinned to; null for worktree Attempts. */
  verifiedRef: text('verified_ref'),
  /** JSON: aggregate usage from the ACP prompt result. */
  usage: text('usage'),
  /** JSON: Cost frozen when the final Usage is recorded. */
  cost: text('cost'),
  /** JSON: latest live-usage snapshot, overwritten on a coarse cadence and on finish. */
  liveUsage: text('live_usage'),
  /** JSON: `ResolvedGuardrails` snapshotted at Attempt start; a later config change never alters it. */
  guardrailConfig: text('guardrail_config'),
  /** JSON: `PriceTable` snapshotted at Attempt start. */
  priceTable: text('price_table'),
  /** Free-text detail behind {@link reason}; null while running or when the kind needs none. */
  detail: text('detail'),
}, (t) => [uniqueIndex('attempts_task_number_unique').on(t.taskId, t.number)]);
export type AttemptRow = typeof attempts.$inferSelect;

/** Individually visible work within an Attempt. `logLocator` points to its transcript/output. */
export const steps = sqliteTable('steps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  attemptId: integer('attempt_id').notNull().references(() => attempts.id),
  type: text('type').$type<StepType>().notNull(),
  position: integer('position').notNull(),
  state: text('state').$type<StepState>().notNull().default('pending'),
  command: text('command'),
  verdict: text('verdict'),
  logLocator: text('log_locator'),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
}, (t) => [uniqueIndex('steps_attempt_position_unique').on(t.attemptId, t.position)]);
export type StepRow = typeof steps.$inferSelect;

/** Per-Attempt tool-call counts; Task and Epic totals are derived on read. */
export const attemptToolCalls = sqliteTable(
  'attempt_tool_calls',
  {
    attemptId: integer('attempt_id')
      .notNull()
      .references(() => attempts.id),
    toolName: text('tool_name').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.attemptId, t.toolName] })],
);
export type AttemptToolCallRow = typeof attemptToolCalls.$inferSelect;

/** Lifecycle events and permission requests only; the `session_update` firehose is never persisted. */
export const attemptEvents = sqliteTable('attempt_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  attemptId: integer('attempt_id')
    .notNull()
    .references(() => attempts.id),
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  /** 'permission_request' | 'lifecycle' */
  type: text('type').notNull(),
  /** JSON payload. */
  payload: text('payload').notNull(),
});

export const CONVERSATION_STATES = ['active', 'ended'] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

/** An interactive, multi-turn exchange the operator drives with a Harness over ACP. Direct mode only; never queued or reviewed. */
export const conversations = sqliteTable('conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Operator-set title; null falls back to a title derived from the first Turn. */
  title: text('title'),
  harness: text('harness').notNull(),
  model: text('model').notNull(),
  workingDir: text('working_dir').notNull(),
  workspaceId: integer('workspace_id').references(() => workspaces.id),
  state: text('state').$type<ConversationState>().notNull(),
  /** The warm ACP session id, set once the harness spawns; null before the first Turn. */
  sessionId: text('session_id'),
  /** JSON: running Usage accumulated across Turns; null before any usage. */
  usage: text('usage'),
  /** The latest Turn's input-side token footprint, for context-window fill. */
  contextTokens: integer('context_tokens'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  endedAt: integer('ended_at'),
});

/** A Conversation's event stream; payloads share the `attempt_events` shape so the renderer is shared. */
export const conversationEvents = sqliteTable(
  'conversation_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id),
    seq: integer('seq').notNull(),
    ts: integer('ts').notNull(),
    /** 'session_update' | 'permission_request' | 'lifecycle' | 'user_turn' */
    type: text('type').notNull(),
    /** JSON payload — for session_update, the ACP `update` object verbatim; for user_turn, `{ text }`. */
    payload: text('payload').notNull(),
  },
  (t) => [index('conversation_events_conversation_id_idx').on(t.conversationId)],
);

/** Auto-answers a Harness's permission request in any Conversation when the tool kind and Working Directory match; operator-visible and revocable. */
export const permissionRules = sqliteTable(
  'permission_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** ACP tool kind (read / edit / execute / fetch). */
    kind: text('kind').notNull(),
    workingDir: text('working_dir').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('permission_rules_kind_dir_idx').on(t.kind, t.workingDir)],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationEventRow = typeof conversationEvents.$inferSelect;
export type PermissionRuleRow = typeof permissionRules.$inferSelect;

export const CHANNEL_TYPES = ['discord', 'slack', 'webhook', 'email'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const channels = sqliteTable('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').$type<ChannelType>().notNull(),
  /** JSON: type-specific delivery config (url/secret/smtp/from/to). */
  config: text('config').notNull(),
  /** JSON: subscribed notification event types. */
  events: text('events').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Per-task override: this task announces its events to this channel. */
export const taskChannels = sqliteTable(
  'task_channels',
  {
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.channelId] })],
);

export type ChannelRow = typeof channels.$inferSelect;

export const apiKeys = sqliteTable('api_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** sha256 hex of the bearer token; the token itself is never stored. */
  tokenHash: text('token_hash').notNull(),
  /** First characters of the token, for display. */
  prefix: text('prefix').notNull(),
  /** 'full' / 'read' for operator keys; 'attempt' / 'conversation' for ephemeral scoped keys. */
  scope: text('scope').notNull().default('full'),
  attemptId: integer('attempt_id'),
  /** The Conversation a 'conversation'-scoped key belongs to; its lifetime follows the Conversation's. */
  conversationId: integer('conversation_id'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  revokedAt: integer('revoked_at'),
});

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/** The raw `tasks` row: the inheritable Task-default overrides read back nullable (`null` ⇒ inherit). */
export type RawTaskRow = typeof tasks.$inferSelect;
/** A `tasks` row as every consumer sees it: the inheritable defaults
 * already resolved to their effective values (never null). */
export type TaskRow = Omit<
  RawTaskRow,
  'harness' | 'model' | 'isolationMode' | 'priority' | 'conflictResolveTurns'
> & {
  harness: string;
  model: string;
  isolationMode: string;
  priority: string;
  conflictResolveTurns: number;
};

/** Persisted facts for tracker containers that deliberately have no Task row, currently Maps. */
export const trackerContainers = sqliteTable('tracker_containers', {
  workspaceId: integer('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  trackerRef: integer('tracker_ref').notNull(),
  trackerState: text('tracker_state').$type<TicketState>().notNull(),
  trackerParent: integer('tracker_parent'),
  trackerBlockedBy: text('tracker_blocked_by', { mode: 'json' }).$type<TicketRef[]>().notNull(),
  trackerLabels: text('tracker_labels', { mode: 'json' }).$type<string[]>().notNull(),
  trackerTitle: text('tracker_title').notNull(),
  trackerBody: text('tracker_body').notNull(),
  trackerUrl: text('tracker_url').notNull(),
  trackerCreatedAt: text('tracker_created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.trackerRef] })]);
export type TrackerContainerRow = typeof trackerContainers.$inferSelect;

/** Re-derived every scan: `map` = the `wayfinder:map` container; `spec` = a container whose body carries a spec; `epic` = a plain parent/child container. */
export const STORED_EPIC_KINDS = ['map', 'spec', 'epic'] as const;
export type StoredEpicKind = (typeof STORED_EPIC_KINDS)[number];

/** `open` while the Epic is live; `integrated` once its branch is merged to base (or a no-op finish settles it). */
export const EPIC_LIFECYCLE_STATES = ['open', 'integrated'] as const;
export type EpicLifecycleState = (typeof EPIC_LIFECYCLE_STATES)[number];

/** The leaf-most Epic as a stored resource, keyed `(workspaceId, trackerRef)`; survives the tracker issue closing, removed only on Dismiss. `mergeCommit`/`memberRefs` are null while live. */
export const epics = sqliteTable('epics', {
  workspaceId: integer('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  trackerRef: integer('tracker_ref').notNull(),
  kind: text('kind').$type<StoredEpicKind>().notNull(),
  /** The integration merge-commit hash; null while live and on a no-op finish (branch already matched base). */
  mergeCommit: text('merge_commit'),
  state: text('state').$type<EpicLifecycleState>().notNull(),
  /** Member refs snapshotted at integration (JSON int array); null while live. */
  memberRefs: text('member_refs', { mode: 'json' }).$type<number[]>(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.trackerRef] })]);
export type EpicRow = typeof epics.$inferSelect;

export type AttemptEventRow = typeof attemptEvents.$inferSelect;

export const VERIFICATION_MECHANISMS = ['critic', 'command'] as const;
export type VerificationMechanism = (typeof VERIFICATION_MECHANISMS)[number];

/** Append-only log of Verification attempts, one total order per Attempt via `seq`. `inputOid` is per-row because an Attempt can be re-verified against more than one head. */
export const verificationAttempts = sqliteTable('verification_attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  attemptId: integer('attempt_id')
    .notNull()
    .references(() => attempts.id),
  /** Monotonic per-Attempt sequence (1-based). */
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  mechanism: text('mechanism').$type<VerificationMechanism>().notNull(),
  inputOid: text('input_oid').notNull(),
  /** 'pass' | 'fail' | 'inconclusive' (`verification/critic-schema.ts`'s `Verdict`). */
  verdict: text('verdict').$type<Verdict>().notNull(),
  summary: text('summary').notNull(),
  /** Raw verifier output (the critic's agent text), capped by the caller. */
  output: text('output').notNull(),
  /** Locator for the critic's native harness transcript; null for the command verifier or a harness with no native JSONL. Server-only. */
  transcriptPath: text('transcript_path'),
  /** The critic harness id that produced {@link transcriptPath}; may differ from the builder's. */
  harness: text('harness'),
}, (t) => [
  uniqueIndex('verification_attempts_attempt_seq_unique').on(t.attemptId, t.seq),
]);

export type VerificationAttemptRow = typeof verificationAttempts.$inferSelect;

/** Cost `limit_value`/`observed_value` are stored in micro-USD (USD × 1e6); the human USD floats ride in `payload`. */
export const GUARDRAIL_DIMENSIONS = ['wall-clock', 'tokens', 'cost', 'progress', 'tool-timeout'] as const;
export type GuardrailDimension = (typeof GUARDRAIL_DIMENSIONS)[number];

/** Where the tripped limit resolved from: a Workspace override or the global default. */
export const GUARDRAIL_CONFIG_SOURCES = ['default', 'workspace'] as const;
export type GuardrailConfigSource = (typeof GUARDRAIL_CONFIG_SOURCES)[number];

/** Append-only Guardrail-trip log, one total order per Attempt via `seq`. `limitValue`/`observedValue` share the dimension's unit. */
export const guardrailEvents = sqliteTable('guardrail_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  attemptId: integer('attempt_id')
    .notNull()
    .references(() => attempts.id),
  /** Monotonic per-Attempt sequence (1-based). */
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  dimension: text('dimension').$type<GuardrailDimension>().notNull(),
  /** The configured bound that was crossed, in the dimension's unit (ms for wall-clock). */
  limitValue: integer('limit_value').notNull(),
  /** The observed value at trip, same unit as `limitValue`. */
  observedValue: integer('observed_value').notNull(),
  configSource: text('config_source').$type<GuardrailConfigSource>().notNull(),
  /** JSON payload — any extra evidence; `'{}'` when none. */
  payload: text('payload').notNull().default('{}'),
}, (t) => [
  uniqueIndex('guardrail_events_attempt_seq_unique').on(t.attemptId, t.seq),
]);

export type GuardrailEventRow = typeof guardrailEvents.$inferSelect;

/** `active` — a live Attempt owns it; `idle` — retained under `retireDeadline`; `retiring` — worktree removal in progress; `retired` — terminal. Retirement is the sole owner of builder-worktree removal. */
export const SESSION_STATUSES = ['active', 'idle', 'retiring', 'retired'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** `merged`; `operator-disposition` (cancel / Close); `retention-ttl`; `task-active` (idle with no deadline — the worktree is retained across Attempts). */
export const SESSION_RETIRE_REASONS = ['merged', 'operator-disposition', 'retention-ttl', 'task-active'] as const;
export type SessionRetireReason = (typeof SESSION_RETIRE_REASONS)[number];

/** One ACP conversation with a Harness, persisted on every dispatch. Uniqueness is on `(harness, harnessSessionId)`. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    harness: text('harness').notNull(),
    /** The harness's own ACP session id; the resume handle. */
    harnessSessionId: text('harness_session_id').notNull(),
    model: text('model').notNull(),
    cwd: text('cwd').notNull(),
    workspaceId: integer('workspace_id').references(() => workspaces.id),
    /** Absolute native JSONL path; null when the harness exposes none. */
    transcriptPath: text('transcript_path'),
    /** JSON array: the `session/new` mcpServers templates with every secret stripped; credentials are minted fresh at dispatch. */
    mcpTemplates: text('mcp_templates').notNull().default('[]'),
    /** The ACP permission mode in effect; null when none was set. */
    permissionMode: text('permission_mode'),
    /** JSON: the harness's `initialize` result verbatim; `'{}'` when none. */
    capabilitySnapshot: text('capability_snapshot').notNull().default('{}'),
    /** Denormalized from `capabilitySnapshot.agentCapabilities.loadSession`. */
    supportsLoadSession: integer('supports_load_session', { mode: 'boolean' }).notNull().default(false),
    /** The adapter/config version (e.g. `claude@1`); part of the resume compatibility matrix. */
    adapterVersion: text('adapter_version'),
    status: text('status').$type<SessionStatus>().notNull().default('active'),
    lastActiveAt: integer('last_active_at').notNull(),
    /** Estimated epoch ms until the provider prompt-cache goes cold (Claude ~1h); a cost estimate, never a correctness TTL. Null when unknown. */
    estimatedWarmUntil: integer('estimated_warm_until'),
    /** The builder worktree this Session owns; null for direct-mode / non-git Sessions. */
    worktreePath: text('worktree_path'),
    worktreeRepoDir: text('worktree_repo_dir'),
    /** Why this Session retired, or while `idle` the reason its deadline will retire it under; null while `active`. */
    retireReason: text('retire_reason').$type<SessionRetireReason>(),
    /** Why a `session/load` resume was declined; null until a reload declines. */
    resumeIncompatibilityReason: text('resume_incompatibility_reason'),
    resumeIncompatibilityDetail: text('resume_incompatibility_detail'),
    /** Epoch ms an `idle` Session's retention window lapses; null on `idle` means retire only on an explicit operator disposition. */
    retireDeadline: integer('retire_deadline'),
    retiredAt: integer('retired_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('sessions_harness_session_unique').on(t.harness, t.harnessSessionId)],
);

export type SessionRow = typeof sessions.$inferSelect;
