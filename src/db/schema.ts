import { sqliteTable, integer, text, primaryKey, index, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
// Type-only import (erased at compile) so the db layer can brand
// `verification_attempts.verdict` without a runtime db→domain import cycle
// (domain/verification-attempts.ts already imports this schema): the canonical verdict
// enum so the column is literal-typed like `mechanism`.
import type { Verdict } from '../verification/critic-schema.js';
// Type-only import (erased at compile): brands the durable tracker-fact columns
// on `tasks` with the tracker's own normalised shapes, so the persisted facts
// stay literally the `Ticket` fields — no redefinition to drift against. The
// import is `type`-only, so no runtime db→tracker edge is emitted.
import type { TicketRef, TicketState } from '../tracker/adapter.js';

/** Tracker mirroring (issue #30). A Task is either authored here or a 1:1 projection of a tracker issue. */
export const TASK_ORIGINS = ['native', 'mirrored'] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];
export const WORKFLOWS = ['wayfinder', 'implement'] as const;
export type Workflow = (typeof WORKFLOWS)[number];
export const WAYFINDER_TYPES = ['research', 'prototype', 'grilling', 'task'] as const;
export type WayfinderType = (typeof WAYFINDER_TYPES)[number];

/**
 * The durable per-issue tracker facts (issue #233, ADR-0030 "expand"): the
 * normalised shape of a mirrored issue's last successful scan, persisted so the
 * facts survive a restart instead of living only in the ephemeral in-memory
 * scan. Field-for-field a subset of the tracker `Ticket` — persisted verbatim.
 * Epic and Map derivation read these persisted facts (issue #234).
 */
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

/** The stored Ticket states (ADR-0041). Blocked-ness and agent-workability are derived, never stored. */
export const TASK_STATES = ['draft', 'ready', 'working', 'escalated', 'done', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * A Workspace (ADR-0008): a named Working Directory, unique by absolute
 * path. Owns a board of Tasks/Conversations. Its tracker mirroring is
 * per-Workspace (issue #45): each tracker-enabled Workspace polls its own
 * Working Directory on its own interval into its own board.
 *
 * Setting Overrides (ADR-0012, issue #59) no longer live as columns here
 * (issue #391, ADR-0009): the overridable execution settings — Task defaults,
 * chat defaults, the concurrency cap, Auto-Runner enable, the verifier/review/
 * guardrail/drive overrides — now live in the YAML settings file alongside the
 * global config, keyed by this Workspace's id (`SettingsStore`). `null` there
 * still means *inherit* the global default; a non-null value still overrides
 * it. `WorkspaceService` composes them onto this identity row at read time
 * (see `WorkspaceRow` below) so downstream field access is unchanged.
 */
export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  workingDir: text('working_dir').notNull(),
  /** Tracker mirroring for this Workspace (issue #45). Off ⇒ no poll loop. */
  trackerEnabled: integer('tracker_enabled', { mode: 'boolean' }).notNull().default(false),
  /** How often this Workspace's poll loop scans its repo, in seconds. */
  trackerPollIntervalSeconds: integer('tracker_poll_interval_seconds').notNull().default(60),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  uniqueIndex('workspaces_working_dir_idx').on(t.workingDir),
]);

export type WorkspaceIdentityRow = typeof workspaces.$inferSelect;
/**
 * A Workspace as consumed across the app: DB identity columns plus its setting
 * overrides composed in from the YAML settings file (ADR-0009). `WorkspaceService`
 * is the sole producer — it overlays overrides onto the identity row on read, so
 * downstream field access (`.harness`, `.verificationCommand`, …) is unchanged.
 * `null` on any override field means *inherit* the global default.
 */
export type WorkspaceRow = WorkspaceIdentityRow & {
  harness: string | null; model: string | null; chatHarness: string | null; chatModel: string | null;
  isolationMode: string | null; priority: string | null;
  conflictResolveTurns: number | null; maxConcurrentRuns: number | null; autoRunnerEnabled: boolean | null;
  maxAttempts: number | null; contextReuseTokenLimit: number | null; verificationCommand: string | null;
  reviewEnabled: boolean | null; reviewPrompt: string | null; reviewModel: string | null; reviewHarness: string | null;
  guardrailBudget: string | null; guardrailProgress: boolean | null; toolTimeoutMinutes: number | null;
  drivePrompt: string | null; driveUnattendedReminder: string | null; driveContinuePrompt: string | null;
  driveMergeFate: string | null; driveContinueAttempts: number | null; taskPrompt: string | null;
};

/**
 * Durable bookkeeping for recurring Scheduled Jobs (ADR-0010). `jobKey` is a
 * canonical identity assembled from the job name and optional Workspace id;
 * it avoids SQLite's NULL-unique semantics making global job rows duplicate.
 */
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
  // --- Task-default overrides (ADR-0012). Nullable: `null` ⇒ *inherit* this
  // Task's Workspace override → the global default, resolved at read time by
  // TaskService (setting-override.ts's `resolve`). A non-null value pins the
  // Task. So a later Workspace/global default change follows every not-yet-
  // pinned Task — the public `TaskRow` these read back as always resolved. ---
  harness: text('harness'),
  model: text('model'),
  workingDir: text('working_dir').notNull(),
  isolationMode: text('isolation_mode'),
  priority: text('priority'),
  /** Conflict-resolve-turn bound override (ADR-0046); null inherits `config.defaults.conflictResolveTurns`. */
  conflictResolveTurns: integer('conflict_resolve_turns'),
  state: text('state').$type<TaskState>().notNull(),
  /** The owning Workspace (ADR-0008). Nullable at the SQL level only because
   * SQLite can't add a NOT NULL column with no default to an existing table;
   * every insert path sets it and the boot-time backfill (db/index.ts) fills
   * pre-Workspace rows, so it is never actually null at rest. */
  workspaceId: integer('workspace_id').references(() => workspaces.id),
  /** Reviewer feedback that seeded this re-attempt, stored in full, separate from the prompt. */
  feedback: text('feedback'),
  /**
   * How a re-attempt continues the rejected Run's Session (issue #170). Null on
   * originals and on re-attempts created before the operator was offered the
   * choice ⇒ treated as `'full'` (the historical behaviour: re-bind the warm
   * Session and replay the whole conversation). `'condensed'` opts out of that
   * bind, so the re-attempt dispatches into a fresh Session carrying only the
   * reviewer feedback in its prompt — cheaper, no full replay. Read by the
   * Runner's `bindContinuationIfEligible`; the choice the operator makes in the
   * reject dialog, wired to `planSessionContinuation`. */
  continuationChoice: text('continuation_choice').$type<'full' | 'condensed'>(),
  // --- Tracker mirroring (issue #30). Null/default on native Tasks. ---
  /** native (authored here) | mirrored (1:1 projection of a tracker issue). */
  origin: text('origin').$type<TaskOrigin>().notNull().default('native'),
  /** The mirrored issue's portable number; the upsert key. Null on native Tasks. */
  trackerRef: integer('tracker_ref'),
  /** wayfinder (charting) | implement (build tickets). Derived from labels. */
  workflow: text('workflow').$type<Workflow>(),
  /** research/prototype/grilling/task; null for implement and native Tasks. */
  wayfinderType: text('wayfinder_type').$type<WayfinderType>(),
  /** Why the Ticket is `escalated` (ADR-0041): the trigger's reason, recorded by every path into that state; null otherwise. */
  escalationReason: text('escalation_reason'),
  /** The parent Map issue's number, for the query-time Map rollup. Not a Dependency edge. */
  mapRef: integer('map_ref'),
  /**
   * Explicit base branch a worktree Run is cut from and merges back onto
   * (issue #157, ADR-0024). Null ⇒ resolves at spawn to the working dir's
   * current branch — today's behaviour, unchanged. This is the *expand* half
   * of an expand/contract that later lets an Epic point its members at a
   * shared integration branch. Not an inheritable default (there is no
   * Workspace/global "default branch" to inherit from — the fallback is a
   * runtime `git` query, not a config value), so it stays a plain pass-through
   * column read straight off `TaskRow`.
   */
  baseBranch: text('base_branch'),
  // --- Durable tracker facts (issue #233, ADR-0030 "expand"). The last
  // successful scan's normalised facts, upserted every poll so they survive a
  // restart. Null on native Tasks (and on mirrored rows written before this
  // migration). Epic and Map derivation read these columns (issue #234). ---
  /** The ticket's open/closed axis at last scan. Distinct from `state`, which is the Task's execution state. */
  trackerState: text('tracker_state').$type<TicketState>(),
  /** The ticket's parent pointer at last scan (the raw `#<n>` fact; `mapRef` is the derived Map rollup key). */
  trackerParent: integer('tracker_parent'),
  /** The ticket's `Blocked by` refs at last scan, verbatim (JSON). */
  trackerBlockedBy: text('tracker_blocked_by', { mode: 'json' }).$type<TicketRef[]>(),
  /** The ticket's labels at last scan (JSON). */
  trackerLabels: text('tracker_labels', { mode: 'json' }).$type<string[]>(),
  /** The ticket's title at last scan, verbatim (`prompt` is the derived title+body blend). */
  trackerTitle: text('tracker_title'),
  /** The ticket's body at last scan, verbatim. */
  trackerBody: text('tracker_body'),
  /** The ticket's tracker URL at last scan. */
  trackerUrl: text('tracker_url'),
  /** The ticket's created-at timestamp at last scan (tracker-native ISO string). */
  trackerCreatedAt: text('tracker_created_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  // The mirror upsert looks up by (workspaceId, trackerRef) every poll; unique
  // enforces 1:1 *per Workspace* (issue #45) — two repos sharing an issue
  // number mirror into distinct Tasks. SQLite treats NULLs as distinct, so
  // native Tasks (null trackerRef) are unconstrained.
  uniqueIndex('tasks_tracker_ref_idx').on(t.workspaceId, t.trackerRef),
  // The board/table's list scope filters by the active Workspace on every load.
  index('tasks_workspace_id_idx').on(t.workspaceId),
]);

/**
 * Tombstone for a **Dismissed** mirrored Task (issue #162, ADR-0025). Deleting
 * a mirrored Task removes its row like any other delete, but that alone isn't
 * enough — `upsertMirrored` re-creates a mirrored Task from its tracker issue
 * on every poll, keyed on `(workspaceId, trackerRef)`, so a naive delete would
 * be silently resurrected on the next scan. Writing a row here on delete lets
 * `mirrorScan` recognise "this ref was deliberately dismissed here" and skip
 * re-mirroring it, without inventing a hidden ninth Task state. Scoped per
 * Workspace (not global) to mirror `tasks_tracker_ref_idx`: two repos sharing
 * an issue number dismiss independently. Un-dismiss is out of scope (ADR-0025)
 * — deleting the tombstone row is the manual escape hatch.
 */
export const trackerDismissals = sqliteTable('tracker_dismissals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** The Workspace the dismissal is scoped to; mirrors the tasks.workspaceId FK. */
  workspaceId: integer('workspace_id').references(() => workspaces.id),
  /** The dismissed mirrored issue's tracker ref; the poller skips re-mirroring this (workspaceId, trackerRef). */
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

/** One pass through a Ticket's implement → verify loop (ADR-0041). */
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
  /** Recorded deterministic session choice for this attempt. */
  continuation: text('continuation'),
  /**
   * The ending-signal kind this Attempt settled under (ADR-0001 #388 S-E):
   * 'escalate' | 'failed' | 'process-death' | 'operator-cancel' |
   * 'operator-accept' | 'guardrail-trip' | 'agent-finish/unresolved'. This is
   * the whole coordination spine now — an Attempt's disposition is
   * `state` + `reason`, nothing replayed from an append-only log. Cheap,
   * low-cardinality audit hedge, not free text (the operator-facing detail
   * lives on `tasks.escalationReason` while a ticket is actually escalated).
   * A boot-time crash-recovery orphan settles `state: 'failed'`, `reason:
   * 'process-death'` — the vocabulary this column already carried, so a
   * crashed Attempt needs no dedicated `AttemptState` (ADR-0001 #388 S-G).
   */
  reason: text('reason'),
  /** ACP stopReason from the session/prompt result (folded from `runs.stop_reason`, ADR-0001 #388 S-G). */
  stopReason: text('stop_reason'),
  sessionId: text('session_id'),
  /**
   * The durable Session (issue #141, reliability-design Unit C) this Attempt is
   * bound to — the Harmonic-generated `sessions.id`, set on dispatch alongside
   * the ACP `sessionId` above once `session/new` returns. Null on pre-feature
   * Attempts and until the harness session is created. The Session is written
   * *alongside* the Attempt, never in place of it, so this binding is purely
   * additive and changes no in-flight Attempt behaviour. Folded from
   * `runs.session_row_id` (ADR-0001 #388 S-G).
   */
  sessionRowId: integer('session_row_id').references((): AnySQLiteColumn => sessions.id),
  /** The exact prompt text sent to the harness for this Attempt (native = filled
   * Task Prompt template + any feedback; mirrored = the filled Drive Prompt).
   * Persisted so Task detail's Prompt tab shows what actually went to the
   * agent; null for pre-feature Attempts and until the prompt turn is sent.
   * Folded from `runs.prompt` (ADR-0001 #388 S-G). */
  prompt: text('prompt'),
  /** Worktree mode: the attempt's branch and the branch it was cut from.
   * Folded from `runs.branch`/`runs.base_branch` (ADR-0001 #388 S-G). */
  branch: text('branch'),
  baseBranch: text('base_branch'),
  /** Immutable revisions for the settled worktree diff. They outlive the
   * attempt branch, which merging or cleanup can advance or delete. Folded
   * from `runs.diff_base_oid`/`runs.diff_head_oid` (ADR-0001 #388 S-G). */
  diffBaseOid: text('diff_base_oid'),
  diffHeadOid: text('diff_head_oid'),
  /** `git diff --stat` snapshot taken when the attempt settles; null in direct
   * mode or before settle. The card and Task detail both read this so they
   * can never disagree (issue #36). Folded from `runs.stat` (ADR-0001 #388 S-G). */
  stat: text('stat'),
  /**
   * The committed implementation head an Attempt is verified against (issue
   * #134, reshaped by the unified lifecycle): the branch-head OID captured at
   * implementation end, before finalize restores the checkout. Null when there
   * is nothing verifiable — a pre-feature Attempt, an escalated Attempt, or an
   * Attempt that left no new commit (the fail-closed no-verified-head path).
   * Folded from `runs.verified_head_oid` (ADR-0001 #388 S-G). */
  verifiedHeadOid: text('verified_head_oid'),
  /** The private Harmonic ref (`refs/harmonic/direct/attempt-<id>`) a **direct**
   * Attempt's head is pinned to, from which it is rematerialized for verification
   * or a later corrective turn. Null for worktree Attempts — their own branch owns
   * the head — so it can be null while `verifiedHeadOid` is set. Folded from
   * `runs.verified_ref` (ADR-0001 #388 S-G). */
  verifiedRef: text('verified_ref'),
  /** JSON: aggregate usage from the ACP prompt result. Folded from `runs.usage` (ADR-0001 #388 S-G). */
  usage: text('usage'),
  /** JSON: Cost frozen when the Attempt's final Usage is recorded (ADR-0035).
   * Folded from `runs.cost` (ADR-0001 #388 S-G). */
  cost: text('cost'),
  /** JSON: latest live-usage snapshot (rolled-up Usage + context fill +
   * current-activity line + Process Tree), overwritten on a coarse ~10s
   * cadence and on finish (ADR 0010). Folded from `runs.live_usage` (ADR-0001 #388 S-G). */
  liveUsage: text('live_usage'),
  /** JSON: the effective Guardrail config (`ResolvedGuardrails`) snapshotted at
   * Attempt start (issue #126, ADR-0019); null for pre-feature Attempts. A later
   * config change never alters this — the Attempt trips against what it
   * captured. Folded from `runs.guardrail_config` (ADR-0001 #388 S-G). */
  guardrailConfig: text('guardrail_config'),
  /** JSON: the effective price table (`PriceTable`) snapshotted at Attempt
   * start, so a mid-Attempt price edit can't retroactively change a cost trip
   * (issue #126). Folded from `runs.price_table` (ADR-0001 #388 S-G). */
  priceTable: text('price_table'),
  /** The free-text detail behind {@link reason} — a git/harness error message,
   * a guardrail's `budget: …` summary, or the same "escalated to human: …"
   * text as `tasks.escalationReason` — folded from `runs.reason` (ADR-0001
   * #388 S-G). Distinct from `reason` (the low-cardinality disposition kind,
   * ADR-0001 #388 S-E): the two used to live on separate rows (`runs.reason`
   * free text vs `attempts.reason` structured) and both still need to survive
   * the fold onto one row. Null while running, and for a disposition with no
   * extra human-readable detail beyond its kind (e.g. a plain operator-cancel). */
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

/**
 * Per-Attempt tool-call counts (ADR-0031; re-keyed off `attempt_id` at
 * ADR-0001 #388 S-F — Attempt is the single execution ledger, ADR-0007). The
 * runner will overwrite these rows from its in-memory rollup; Task and Epic
 * totals are derived on read through `attempts.taskId` and `tasks.mapRef`, so
 * they cannot drift from task ownership.
 */
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

/**
 * `attempt_events` (renamed from `run_events`, re-keyed off `attempt_id` at
 * ADR-0001 #388 S-F): the small structured facts ADR-0007's "The DB stores
 * aggregates, not event streams" keeps — lifecycle events and permission
 * requests. The `session_update` firehose was pruned outright (migration
 * 0042) before this table ever carried Attempt identity.
 */
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

/**
 * A Conversation (ADR-0006): an interactive, multi-turn exchange the
 * operator drives with a Harness over ACP — a first-class sibling to Task,
 * not a Task variant. Direct mode only; never queued or reviewed.
 */
export const conversations = sqliteTable('conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Operator-set title; null falls back to a title derived from the first Turn. */
  title: text('title'),
  harness: text('harness').notNull(),
  model: text('model').notNull(),
  workingDir: text('working_dir').notNull(),
  /** The owning Workspace (ADR-0008); see the `tasks.workspaceId` comment
   * for why this is nullable at the SQL level but never null at rest. */
  workspaceId: integer('workspace_id').references(() => workspaces.id),
  state: text('state').$type<ConversationState>().notNull(),
  /** The warm ACP session id, set once the harness spawns; null before the first Turn. */
  sessionId: text('session_id'),
  /** JSON: running Usage accumulated across Turns (issue 12); null before any usage. */
  usage: text('usage'),
  /** The latest Turn's input-side token footprint, for context-window fill (issue 12). */
  contextTokens: integer('context_tokens'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  endedAt: integer('ended_at'),
});

/** A Conversation's event stream; payloads are byte-identical to `run_events` so the renderer is shared by shape (ADR-0006). */
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

/**
 * An opt-in persistent Permission Rule (ADR-0007): auto-answers a Harness's
 * permission request in any Conversation when the tool kind and Working
 * Directory match. A deliberate auto-approval escalation — operator-visible
 * and revocable, never the default click.
 */
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
  /** The Conversation a 'conversation'-scoped key belongs to; its lifetime follows the Conversation's (issue 16). */
  conversationId: integer('conversation_id'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  revokedAt: integer('revoked_at'),
});

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/** The raw `tasks` row: the inheritable Task-default overrides read back nullable
 * (`null` ⇒ inherit). Used only inside TaskService, which resolves them. */
export type RawTaskRow = typeof tasks.$inferSelect;
/** A `tasks` row as every consumer sees it: the inheritable defaults
 * already resolved to their effective values (never null). TaskService.get/
 * list/etc. return this; storage speaks `RawTaskRow`. */
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

export type AttemptEventRow = typeof attemptEvents.$inferSelect;

/**
 * The Verification mechanisms that write to `verification_attempts` (issue
 * #136, ADR-0021, reliability-design Unit B). Only `'critic'` has an emitter
 * today (`verification/critic.ts`); `'command'` is reserved for the sibling
 * argv-verifier ticket (#132's `verificationCommandSchema` is config-only so
 * far) so both mechanisms share one attempt log and one row shape rather than
 * forking the table later.
 */
export const VERIFICATION_MECHANISMS = ['critic', 'command'] as const;
export type VerificationMechanism = (typeof VERIFICATION_MECHANISMS)[number];

/**
 * The persisted record of one Verification attempt against a Run's frozen
 * verified-head OID (issue #136, ADR-0021, reliability-design Unit B). Mirrors
 * `guardrail_events`'s discipline exactly: append-only, `seq` assigned by the
 * store as `max(seq)+1`, and the `(attempt_id, seq)` unique index is the same
 * monotonicity guarantee — two attempts can never share a seq within an
 * Attempt, so the log has a single total order and a cross-process race that
 * computed the same seq is rejected loudly rather than corrupting it.
 * Re-keyed off `attempt_id` at ADR-0001 #388 S-F (Attempt is the single
 * execution ledger, ADR-0007); was `run_id` before.
 *
 * `inputOid` is recorded per-row (not just implied by the Run's
 * `verifiedHeadOid` column) because a Run can be re-verified against more than
 * one verified head over its lifetime — a self-heal turn re-enters `validating`
 * and produces a fresh verified head (reliability-design Unit B), and the attempt
 * log is how a later reader tells which head each verdict actually
 * judged. `output` stores the verifier's raw output (the critic's agent
 * text); the caller is expected to cap it before it reaches here so an
 * unbounded or adversarial transcript can't grow the row without limit.
 *
 * Written for real during a live Run: the command verifier (#135) and the
 * agent critic (#136, wired in #164) both append their per-attempt record here
 * from the Attempt's Verification/Review Step (`execution/runner.ts` `runVerification`), and
 * `combineVerdicts` folds the verdicts into the block/escalate/merge decision.
 * `domain/verification-attempts.ts`'s `VerificationAttemptStore` stays
 * append+list only — this is its durable audit log.
 */
export const verificationAttempts = sqliteTable('verification_attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  attemptId: integer('attempt_id')
    .notNull()
    .references(() => attempts.id),
  /** Monotonic per-Attempt sequence (1-based); same discipline as `guardrail_events.seq`. */
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  /** 'critic' today; 'command' reserved for the sibling verifier ticket. */
  mechanism: text('mechanism').$type<VerificationMechanism>().notNull(),
  /** The verified-head OID this attempt checked (see the class doc — an Attempt may
   * be re-verified against more than one head across self-heal turns). */
  inputOid: text('input_oid').notNull(),
  /** 'pass' | 'fail' | 'inconclusive' (`verification/critic-schema.ts`'s `Verdict`). */
  verdict: text('verdict').$type<Verdict>().notNull(),
  summary: text('summary').notNull(),
  /** Raw verifier output (the critic's agent text), capped by the caller. */
  output: text('output').notNull(),
  /** Locator for the critic's native harness transcript (ADR-0040): resolved
   * from its harness `sessionId` before the disposable worktree is disposed, so
   * the operator can read the critic's own session log (reads, greps, builds)
   * on demand. Null for the command verifier, for a harness that writes no
   * native JSONL, and for every attempt recorded before this column existed —
   * all rendered "log unavailable". Server-only; never served raw to a client. */
  transcriptPath: text('transcript_path'),
  /** The critic harness id (`claude`/`codex`/…) that produced {@link transcriptPath},
   * kept so the log parser can be picked without re-deriving it from config —
   * the critic harness can differ from the builder's (`critic.harness ?? task.harness`). */
  harness: text('harness'),
}, (t) => [
  uniqueIndex('verification_attempts_attempt_seq_unique').on(t.attemptId, t.seq),
]);

export type VerificationAttemptRow = typeof verificationAttempts.$inferSelect;

/**
 * The Guardrail budget dimensions this table has a slot for (issue #127,
 * ADR-0019, reliability-design Unit A). `'wall-clock'` is the Step-scoped
 * wall-clock Guardrail that trips a Run to Escalation; `'progress'` and
 * `'tool-timeout'` (issue #131) now have emitters too — the stall/loop
 * detector (`domain/guardrail-progress.ts`, `domain/stall-detector.ts`) and
 * its hard tool-timeout backstop (`domain/guardrail-tool-timeout.ts`)
 * respectively. `'tokens'` and `'cost'` are the sibling budget dimensions
 * (`budgetGuardrailSchema`), enforced live off the Usage tailer by the
 * Runner's spend-guard poll (issue #128; `domain/guardrail-budget.ts`
 * `spendTrip`). Cost `limit_value`/`observed_value` are stored in micro-USD
 * (USD × 1e6) to keep the integer columns lossless; the human USD floats ride
 * in `payload`.
 */
export const GUARDRAIL_DIMENSIONS = ['wall-clock', 'tokens', 'cost', 'progress', 'tool-timeout'] as const;
export type GuardrailDimension = (typeof GUARDRAIL_DIMENSIONS)[number];

/** Where a Guardrail's configured limit resolved from, at the moment it
 * tripped — mirrors the override chain (`resolveGuardrails`,
 * setting-override.ts) collapsed to the two tiers that matter for evidence:
 * a Workspace override, or the global default. */
export const GUARDRAIL_CONFIG_SOURCES = ['default', 'workspace'] as const;
export type GuardrailConfigSource = (typeof GUARDRAIL_CONFIG_SOURCES)[number];

/**
 * The structured Guardrail-trip observability log (issue #127, ADR-0019,
 * reliability-design Unit A line 104): every time a Guardrail's configured
 * budget is crossed, one immutable row records what tripped, against what
 * bound, and where that bound resolved from — the evidence a
 * later Escalation card's reason derives from. Mirrors `verificationAttempts`'s
 * discipline exactly: append-only, `seq` assigned by the store
 * as `max(seq)+1` (1-based, per-Run monotonic), and the `(run_id, seq)`
 * unique index is the same cross-process integrity backstop — two trips can
 * never share a seq within a Run, so the log has a single total order and a
 * racing duplicate `seq` is rejected loudly rather than corrupting it.
 *
 * This table is substrate only, same as `verification_attempts` was at #136:
 * nothing here decides anything. It does not itself move a Run to Escalation
 * — the pure trip-detection logic and the Runner wiring that calls `append`
 * and sets the `guardrail-trip` disposition (`attempts.reason`) are out of
 * scope here (issue #127's logic/wiring halves). `dimension` only ever
 * observes `'wall-clock'` today.
 * `limitValue`/`observedValue` share the dimension's unit
 * (milliseconds for wall-clock). `payload` is free-form JSON for any extra
 * evidence a future dimension's emitter wants to attach, defaulting to `'{}'`
 * when there is none. Re-keyed off `attempt_id` at ADR-0001 #388 S-F
 * (Attempt is the single execution ledger, ADR-0007); was `run_id` before.
 */
export const guardrailEvents = sqliteTable('guardrail_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  attemptId: integer('attempt_id')
    .notNull()
    .references(() => attempts.id),
  /** Monotonic per-Attempt sequence (1-based); same discipline as `verification_attempts.seq`. */
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  /** The budget dimension that tripped; only 'wall-clock' has an emitter today (#127). */
  dimension: text('dimension').$type<GuardrailDimension>().notNull(),
  /** The configured bound that was crossed, in the dimension's unit (ms for wall-clock). */
  limitValue: integer('limit_value').notNull(),
  /** The observed value at trip, same unit as `limitValue`. */
  observedValue: integer('observed_value').notNull(),
  /** Where the limit resolved from: the global default, or a Workspace override. */
  configSource: text('config_source').$type<GuardrailConfigSource>().notNull(),
  /** JSON payload — any extra evidence; `'{}'` when none. */
  payload: text('payload').notNull().default('{}'),
}, (t) => [
  uniqueIndex('guardrail_events_attempt_seq_unique').on(t.attemptId, t.seq),
]);

export type GuardrailEventRow = typeof guardrailEvents.$inferSelect;

/**
 * A Session's lifecycle status (reliability-design Unit C): `active → idle →
 * retiring → retired`. **Session retirement is the sole owner of builder-worktree
 * removal** (issue #148): a worktree Session's checkout is retained through the
 * human-rejection window (so a reject-and-continue merges in the same workspace)
 * and its builder worktree is removed **only** at retirement, gated on the
 * Session having no active Run. `active` — a live Run owns it; `idle`
 * — no live Run, retained under a `retireDeadline` (reject-continuation / warm
 * reuse window); `retiring` — worktree removal in progress (crash-re-driven at
 * boot); `retired` — worktree removed, terminal.
 */
export const SESSION_STATUSES = ['active', 'idle', 'retiring', 'retired'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Why a Session retired (issue #148), for the operator-legible record: `merged`
 * (a successful merge + terminal success), `operator-disposition` (cancel / Close),
 * `retention-ttl` (the optional backstop when a retention TTL is configured),
 * `task-active` (idle, no deadline — the Task's worktree is retained across
 * Attempts until its terminal disposition; ADR-0046).
 */
export const SESSION_RETIRE_REASONS = ['merged', 'operator-disposition', 'retention-ttl', 'task-active'] as const;
export type SessionRetireReason = (typeof SESSION_RETIRE_REASONS)[number];

/**
 * A Session (issue #141, reliability-design Unit C): one ACP conversation with
 * a Harness, made a durable, first-class resource (CONTEXT.md "Session"). On
 * every dispatch Harmonic persists one of these alongside the Run, capturing
 * what the harness advertised at `initialize` (previously discarded) plus the
 * dispatch identity. It is written *alongside* existing Task/Run state, never
 * in place of it — the coordination spine's source of truth, of which Task
 * lifecycle is a projection.
 *
 * No resume behaviour yet: this is the foundation the rest of Unit C builds on.
 * Uniqueness is on `(harness, harnessSessionId)`; the PK is Harmonic-generated.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The Harness this Session runs against (claude/codex/copilot). */
    harness: text('harness').notNull(),
    /** The harness's own ACP session id (from `session/new`); the resume handle.
     * Unique per harness — the natural key resume loads against. */
    harnessSessionId: text('harness_session_id').notNull(),
    model: text('model').notNull(),
    /** The working directory / Work-Context identity the Session executes in —
     * part of the resume compatibility key (same cwd ⇒ reloadable). */
    cwd: text('cwd').notNull(),
    /** The owning Workspace (ADR-0008); nullable at the SQL level for the same
     * reason as `tasks.workspaceId`, set on every real dispatch. */
    workspaceId: integer('workspace_id').references(() => workspaces.id),
    /** Absolute native JSONL path discovered at dispatch. Null when the
     * harness has not written a transcript or does not expose one. */
    transcriptPath: text('transcript_path'),
    /** JSON array: the **credential-free** MCP server templates for this
     * Session — the `session/new` mcpServers shape with every secret (bearer
     * tokens, auth headers, env) stripped. Credentials are never persisted;
     * they are minted fresh at load/dispatch and grafted onto these templates. */
    mcpTemplates: text('mcp_templates').notNull().default('[]'),
    /** The ACP permission mode in effect for this Session (e.g. Claude's
     * `auto`/`bypassPermissions` for afk Runs); null when none was set. */
    permissionMode: text('permission_mode'),
    /** JSON: the harness's `initialize` result verbatim — the capability
     * advertisement (protocolVersion, agentCapabilities incl. `loadSession`,
     * authMethods). `'{}'` when the harness advertised nothing / a legacy
     * driver didn't surface it. */
    capabilitySnapshot: text('capability_snapshot').notNull().default('{}'),
    /** Denormalized from `capabilitySnapshot.agentCapabilities.loadSession`:
     * whether this harness advertised `session/load` support at `initialize`.
     * The resume-eligibility gate reads this without re-parsing the snapshot. */
    supportsLoadSession: integer('supports_load_session', { mode: 'boolean' }).notNull().default(false),
    /** The adapter/config version this Session was dispatched under (e.g.
     * `claude@1`); part of the resume compatibility matrix — an incompatible
     * version forces a fresh Session rather than a load. */
    adapterVersion: text('adapter_version'),
    status: text('status').$type<SessionStatus>().notNull().default('active'),
    /** Epoch ms of the Session's last dispatch/prompt activity; the freshness
     * signal reuse and retirement read. */
    lastActiveAt: integer('last_active_at').notNull(),
    /** Estimated epoch ms until the provider prompt-cache goes cold — a per-
     * Harness COST estimate (Claude ~1h), never a correctness TTL. Null when
     * the harness has no known warm window (never a fake zero). */
    estimatedWarmUntil: integer('estimated_warm_until'),
    /** The builder worktree this Session owns (issue #148): its checkout path and
     * the base repo it was carved from. Set when a **worktree-mode** Run binds
     * its workspace to the Session; retirement (the sole owner of removal) reads
     * these to tear the worktree down. Null for direct-mode / native / non-git
     * Sessions, which own no builder worktree — retirement is then a pure status
     * transition with nothing to remove. */
    worktreePath: text('worktree_path'),
    worktreeRepoDir: text('worktree_repo_dir'),
    /** Why this Session retired ({@link SessionRetireReason}), or — while `idle` —
     * the reason its retention deadline *will* retire it under. Null while
     * `active`. The operator-legible record of which retirement deadline fired. */
    retireReason: text('retire_reason').$type<SessionRetireReason>(),
    /** The machine-usable reason a `session/load` resume was declined on this
     * Session (a `ResumeIncompatibilityReason` from session-resume.ts or an
     * `AcpLoadIncompatibility` from acp/driver.ts) — issue #145 AC5. Persisted
     * as a plain string, not `$type`-constrained, to avoid a schema→domain
     * import cycle. Null until a reload actually declines. */
    resumeIncompatibilityReason: text('resume_incompatibility_reason'),
    /** The human-legible detail accompanying {@link resumeIncompatibilityReason}
     * — issue #145 AC5. Null until a reload actually declines. */
    resumeIncompatibilityDetail: text('resume_incompatibility_detail'),
    /** Epoch ms at which an `idle` Session's retention window lapses and the sweep
     * retires it (issue #148) — the reject-continuation / retention-TTL deadline.
     * Null while `active` or already `retired`; a null on an `idle` Session means
     * "retire only on an explicit operator disposition" (never auto-swept). */
    retireDeadline: integer('retire_deadline'),
    /** Epoch ms the Session reached `retired` (its worktree removed); null until
     * then. */
    retiredAt: integer('retired_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('sessions_harness_session_unique').on(t.harness, t.harnessSessionId)],
);

export type SessionRow = typeof sessions.$inferSelect;
