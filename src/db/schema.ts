import { sql } from 'drizzle-orm';
import { sqliteTable, integer, text, primaryKey, index, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
// Type-only import (erased at compile) so the db layer can brand `runs.phase`
// with the phase-machine enum without a runtime db→domain import cycle
// (domain/run-facts.ts already imports this schema).
import type { RunPhase } from '../domain/run-phases.js';
// Type-only import, same reasoning: brands `turn_queue`'s status/purpose/
// cancel-reason columns without a runtime db→domain import cycle
// (domain/turn-queue-store.ts already imports this schema).
import type { TurnStatus, TurnPurpose, TurnCancelReason } from '../domain/turn-queue.js';
// Type-only import, same reasoning: brands `landing_journal`'s kind/effect
// columns without a runtime db→domain import cycle (domain/landing.ts already
// imports nothing from this schema — it is deliberately DB-free — but the
// canonical `LandingEffect`/`LandingJournalKind` enums still live there so
// the pure module stays the single source of truth for them).
import type { LandingEffect, LandingJournalKind } from '../domain/landing.js';

/** Tracker mirroring (issue #30). A Task is either authored here or a 1:1 projection of a tracker issue. */
export const TASK_ORIGINS = ['native', 'mirrored'] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];
export const WORKFLOWS = ['wayfinder', 'implement'] as const;
export type Workflow = (typeof WORKFLOWS)[number];
export const WAYFINDER_TYPES = ['research', 'prototype', 'grilling', 'task'] as const;
export type WayfinderType = (typeof WAYFINDER_TYPES)[number];
export const DRIVES = ['afk', 'hitl'] as const;
export type Drive = (typeof DRIVES)[number];

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

/**
 * A Workspace (ADR-0008): a named Working Directory, unique by absolute
 * path. Owns a board of Tasks/Conversations. Its tracker mirroring is
 * per-Workspace (issue #45): each tracker-enabled Workspace polls its own
 * Working Directory on its own interval into its own board.
 *
 * Setting Overrides (ADR-0012, issue #59): the overridable execution settings
 * — Task defaults (harness, model, Isolation Mode, Priority), the concurrency
 * cap, and Auto-Runner enable — are nullable columns here where `null` means
 * *inherit* the global default. A non-null value overrides it. Effective values
 * are resolved at read time by `resolve`/`resolveCap` (domain/setting-override.ts).
 */
export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  workingDir: text('working_dir').notNull(),
  /** Tracker mirroring for this Workspace (issue #45). Off ⇒ no poll loop. */
  trackerEnabled: integer('tracker_enabled', { mode: 'boolean' }).notNull().default(false),
  /** How often this Workspace's poll loop scans its repo, in seconds. */
  trackerPollIntervalSeconds: integer('tracker_poll_interval_seconds').notNull().default(60),
  // --- Setting Overrides (ADR-0012, issue #59). Null ⇒ inherit the global
  // default; a non-null value overrides it. Task defaults resolved here are the
  // middle tier of a three-level chain (Task override → this Workspace override
  // → global default), resolved at read time so a change follows every Task
  // that hasn't pinned its own value. ---
  /** Task-default Harness override; null inherits `config.defaults.harness`. */
  harness: text('harness'),
  /** Task-default model override; null inherits the harness's default model. */
  model: text('model'),
  /** Chat-default Harness override; null inherits `config.chat.harness`. New
   * Conversations here start with this Harness (ADR-0012). */
  chatHarness: text('chat_harness'),
  /** Chat-default model override; null inherits `config.chat.model`. */
  chatModel: text('chat_model'),
  /** Task-default Isolation Mode override; null inherits `config.defaults.isolationMode`. */
  isolationMode: text('isolation_mode'),
  /** Task-default Priority override; null inherits `config.defaults.priority`. */
  priority: text('priority'),
  /** Per-Workspace concurrency cap; null inherits the Machine Ceiling
   * (`config.autoRunner.maxConcurrentRuns`). Clamped to the ceiling on read —
   * an override can never breach the machine's limit (`resolveCap`). */
  maxConcurrentRuns: integer('max_concurrent_runs'),
  /** Per-Workspace Auto-Runner enable; null inherits the global default. Gated
   * by the global master switch — a Task runs only if `master ∧ resolved`. */
  autoRunnerEnabled: integer('auto_runner_enabled', { mode: 'boolean' }),
  /** Per-Workspace command-verifier override (issue #132, ADR-0021): JSON of
   * `verificationCommandSchema`, or null to inherit `config.verification.command`.
   * Resolved per-key at read time by `resolveVerifiers` (setting-override.ts). */
  verificationCommand: text('verification_command'),
  /** Per-Workspace critic-verifier override (issue #132): JSON of
   * `verificationCriticSchema`, or null to inherit `config.verification.critic`. */
  verificationCritic: text('verification_critic'),
  /** Per-Workspace budget-Guardrail override (issue #126, ADR-0019): JSON of
   * `budgetGuardrailSchema`, or null to inherit `config.guardrails.budget`.
   * Resolved by `resolveGuardrails` (setting-override.ts). */
  guardrailBudget: text('guardrail_budget'),
  /** Per-Workspace progress-detector toggle override (issue #126); null inherits
   * `config.guardrails.progress`. */
  guardrailProgress: integer('guardrail_progress', { mode: 'boolean' }),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  uniqueIndex('workspaces_working_dir_idx').on(t.workingDir),
]);

export type WorkspaceRow = typeof workspaces.$inferSelect;

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
  state: text('state').$type<TaskState>().notNull(),
  /** The owning Workspace (ADR-0008). Nullable at the SQL level only because
   * SQLite can't add a NOT NULL column with no default to an existing table;
   * every insert path sets it and the boot-time backfill (db/index.ts) fills
   * pre-Workspace rows, so it is never actually null at rest. */
  workspaceId: integer('workspace_id').references(() => workspaces.id),
  /** The original this task re-attempts (a new attempt is a new, linked task). */
  reattemptOf: integer('reattempt_of').references((): AnySQLiteColumn => tasks.id),
  /** Reviewer feedback that seeded this re-attempt, stored in full, separate from the prompt. */
  feedback: text('feedback'),
  // --- Tracker mirroring (issue #30). Null/default on native Tasks. ---
  /** native (authored here) | mirrored (1:1 projection of a tracker issue). */
  origin: text('origin').$type<TaskOrigin>().notNull().default('native'),
  /** The mirrored issue's portable number; the upsert key. Null on native Tasks. */
  trackerRef: integer('tracker_ref'),
  /** wayfinder (charting) | implement (build tickets). Derived from labels. */
  workflow: text('workflow').$type<Workflow>(),
  /** research/prototype/grilling/task; null for implement and native Tasks. */
  wayfinderType: text('wayfinder_type').$type<WayfinderType>(),
  /** afk (Harmonic auto-runs) | hitl (human drives). Seeded from labels, then Harmonic-owned. */
  drive: text('drive').$type<Drive>(),
  /** Set when an afk Run escalated to a human (drive flipped afk→hitl at runtime). */
  escalated: integer('escalated', { mode: 'boolean' }).notNull().default(false),
  /** The parent Map issue's number, for the query-time Map rollup. Not a Dependency edge. */
  mapRef: integer('map_ref'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  // withDeps looks up reattempts (reverse link) per task on the board/table
  // hot path; index the FK so that stays cheap as the table grows.
  index('tasks_reattempt_of_idx').on(t.reattemptOf),
  // The mirror upsert looks up by (workspaceId, trackerRef) every poll; unique
  // enforces 1:1 *per Workspace* (issue #45) — two repos sharing an issue
  // number mirror into distinct Tasks. SQLite treats NULLs as distinct, so
  // native Tasks (null trackerRef) are unconstrained.
  uniqueIndex('tasks_tracker_ref_idx').on(t.workspaceId, t.trackerRef),
  // The board/table's list scope filters by the active Workspace on every load.
  index('tasks_workspace_id_idx').on(t.workspaceId),
]);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** Directed edge: `taskId` depends on `dependsOnId`. */
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
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnId] })],
);

export const RUN_STATES = ['running', 'completed', 'failed', 'cancelled'] as const;
export type RunState = (typeof RUN_STATES)[number];

export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id')
    .notNull()
    .references(() => tasks.id),
  attempt: integer('attempt').notNull(),
  state: text('state').$type<RunState>().notNull(),
  /**
   * The Run's position in the phase machine (issue #114, reliability-design
   * §0.2): `executing → validating → verifying → [review] → landing → terminal`,
   * with human-gated native Runs passing through `review` before `landing` and
   * mirrored / auto-accept Runs skipping it. Persisted so the phase survives a
   * restart and is reconstructable from the Run row alone (never inferred from
   * Task columns); surfaced on the Run API + card. Null on pre-feature Runs.
   * Distinct from `state`: `state` is the execution/terminal RunState, `phase`
   * is *where in its lifecycle* the Run is — a native Run is `state:'running'`
   * while parked in `phase:'review'` awaiting the human accept/reject gate.
   */
  phase: text('phase').$type<RunPhase>(),
  /**
   * Review-SLA deadline (epoch ms) for a Run parked in `phase:'review'`: the
   * point past which an un-reviewed Run is swept to a terminal disposition via
   * a `review-sla-expiry` run_fact (issue #114, reliability-design round-5 #4).
   * Set on entering `review`; null otherwise and on pre-feature Runs.
   */
  reviewDeadline: integer('review_deadline'),
  /** Failure reason: 'interrupted', an error message, or null. */
  reason: text('reason'),
  /** ACP stopReason from the session/prompt result. */
  stopReason: text('stop_reason'),
  sessionId: text('session_id'),
  /** The exact prompt text sent to the harness for this Run (native = filled
   * Task Prompt template + any feedback; mirrored = the filled Drive Prompt).
   * Persisted so Task detail's Prompt tab shows what actually went to the
   * agent; null for pre-feature Runs and until the prompt turn is sent. */
  prompt: text('prompt'),
  /** Worktree mode: the run's branch and the branch it was cut from. */
  branch: text('branch'),
  baseBranch: text('base_branch'),
  /** `git diff --stat` snapshot taken when the run settles to awaiting-review;
   * null in direct mode or before settle. The card and Task detail both read
   * this so they can never disagree (issue #36). */
  stat: text('stat'),
  /** JSON: aggregate usage from the ACP prompt result. */
  usage: text('usage'),
  /** JSON: latest live-usage snapshot (rolled-up Usage + context fill +
   * current-activity line + Process Tree), overwritten on a coarse ~10s
   * cadence and on finish (ADR 0010). Cost is not stored — derived on read. */
  liveUsage: text('live_usage'),
  /** JSON: the effective Guardrail config (`ResolvedGuardrails`) snapshotted at
   * Run start (issue #126, ADR-0019); null for pre-feature Runs. A later config
   * change never alters this — the Run trips against what it captured. */
  guardrailConfig: text('guardrail_config'),
  /** JSON: the effective price table (`PriceTable`) snapshotted at Run start, so
   * a mid-Run price edit can't retroactively change a cost trip (issue #126). */
  priceTable: text('price_table'),
  /** Review decision on this run: 'accepted' | 'rejected' | null. */
  review: text('review'),
  reviewFeedback: text('review_feedback'),
  reviewedAt: integer('reviewed_at'),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
});

export const runEvents = sqliteTable('run_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id')
    .notNull()
    .references(() => runs.id),
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  /** 'session_update' | 'permission_request' | 'lifecycle' */
  type: text('type').notNull(),
  /** JSON payload — for session_update, the ACP `update` object verbatim. */
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
  /** 'full' / 'read' for operator keys; 'run' / 'conversation' for ephemeral scoped keys. */
  scope: text('scope').notNull().default('full'),
  runId: integer('run_id'),
  /** The Conversation a 'conversation'-scoped key belongs to; its lifetime follows the Conversation's (issue 16). */
  conversationId: integer('conversation_id'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  revokedAt: integer('revoked_at'),
});

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/** The raw `tasks` row: the four Task-default overrides read back nullable
 * (`null` ⇒ inherit). Used only inside TaskService, which resolves them. */
export type RawTaskRow = typeof tasks.$inferSelect;
/** A `tasks` row as every consumer sees it: the four inheritable defaults
 * already resolved to their effective values (never null). TaskService.get/
 * list/etc. return this; storage speaks `RawTaskRow`. */
export type TaskRow = Omit<RawTaskRow, 'harness' | 'model' | 'isolationMode' | 'priority'> & {
  harness: string;
  model: string;
  isolationMode: string;
  priority: string;
};
export type RunRow = typeof runs.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;

export const LEASE_STATES = ['held', 'suspect'] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

/**
 * A Work Context lease (issue #118, ADR-0022, reliability-design §0.5): the
 * persisted claim that a Run owns exclusive occupancy of a Work Context (a
 * canonical working-directory/branch identity, `workContextKey` in
 * domain/work-context-key.ts) for a phase of its lifecycle. `phase` is always
 * `'running'` today — the phase machine (#114) will widen it. `expiry` is
 * nullable until the TTL sweep lands (#122); `state` starts `'held'` and only
 * flips to `'suspect'` once reconciliation (#123) exists to clear it.
 *
 * The unique index on `key` alone — not `(key, state)` — is deliberate and is
 * the compare-and-set acquire primitive: a `suspect` row still blocks a new
 * acquire on the same key, because a suspect lease is an unresolved claim, not
 * a free one. Only an explicit `release` (or, later, reconciliation) frees the
 * key. The Runner's use of this substrate is out of scope here (#118 is the
 * schema/store only).
 */
export const workContextLeases = sqliteTable('work_context_leases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** The canonical Work Context identity (`workContextKey`). */
  key: text('key').notNull(),
  /** Occupancy phase; always 'running' until the phase machine (#114). */
  phase: text('phase').notNull(),
  ownerRunId: integer('owner_run_id')
    .notNull()
    .references(() => runs.id),
  heartbeat: integer('heartbeat').notNull(),
  /** TTL deadline; null until the heartbeat/TTL sweep (#122) is built. */
  expiry: integer('expiry'),
  state: text('state').$type<LeaseState>().notNull(),
  acquiredAt: integer('acquired_at').notNull(),
}, (t) => [
  uniqueIndex('work_context_leases_key_unique').on(t.key),
]);

export type WorkContextLeaseRow = typeof workContextLeases.$inferSelect;

/**
 * The ending-signal fact types the coordinator understands **today** (issue
 * #112, reliability-design §0.3). Every way a Run can end is recorded as a
 * `run_fact`; this is the set that has an emitter now. Later spine units append
 * their own kinds (branch-violation, verify-fail, guardrail-trip) without
 * touching the coordinator contract — the column is free `text`, and the single
 * place a new kind is *ranked* is `DISPOSITION_PRECEDENCE`
 * (domain/run-disposition.ts). So this list is a convenience type, not a closed
 * constraint: the store never rejects an unknown `type`.
 */
export const RUN_FACT_TYPES = [
  'operator-cancel',
  'escalate',
  'review-sla-expiry',
  'agent-finish/unresolved',
  'failed',
  'process-death',
] as const;
export type RunFactType = (typeof RUN_FACT_TYPES)[number];

/**
 * The append-only fact log at the heart of the coordination spine (issue #112,
 * reliability-design §0.1/§0.3). Every ending signal a Run emits is one
 * immutable row with a per-Run monotonic `seq`; the ordered log is the sole
 * input (with a cutoff) to `computeDisposition`. Task lifecycle states are a
 * projection of these facts, never the source of coordination truth.
 *
 * The unique index on `(run_id, seq)` is the monotonicity guarantee: two facts
 * can never share a seq within a Run, so the log has a single total order. The
 * store assigns `seq` as `max(seq)+1`; the index is what makes that safe under a
 * cross-process race — a second append computing the same seq is rejected rather
 * than silently corrupting the order.
 */
export const runFacts = sqliteTable('run_facts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id')
    .notNull()
    .references(() => runs.id),
  /** Monotonic per-Run sequence (1-based); the fact log's total order. */
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  /** The ending-signal kind; open for extension (see `RUN_FACT_TYPES`). */
  type: text('type').$type<RunFactType>().notNull(),
  /** JSON payload — signal-specific detail (reason, exit code, …); `'{}'` when none. */
  payload: text('payload').notNull().default('{}'),
}, (t) => [
  uniqueIndex('run_facts_run_seq_unique').on(t.runId, t.seq),
]);

export type RunFactRow = typeof runFacts.$inferSelect;

/**
 * The journaled non-interruptible landing log (issue #115, reliability-design
 * §0.3, Unit D). Landing is the set of irreversible side effects a Run's
 * completion triggers once accepted — merging a worktree branch, opening a
 * PR, closing a tracker ticket (`LandingEffect`, domain/landing.ts) — and
 * this table is the append-only record of that process, mirroring
 * `run_facts`'s discipline exactly (same `(run_id, seq)` unique index, same
 * "only ever appended, never updated" rule) so a landing can be replayed and
 * reconciled from the log alone after a crash.
 *
 * Three row kinds (`kind`), written in this order per landing:
 *   - `ponc` — written once, before the first irreversible effect: freezes
 *     `run_facts`'s cutoff at the seq the land disposition fact just took
 *     (`payload.cutoffSeq`), so `RunSettleCoordinator.settle` (run-settle.ts)
 *     can exclude any cancel/guardrail fact that races in after this point
 *     from ever winning. `effect`/`idempotency_key` are null for this kind —
 *     a PONC is about the Run's disposition, not any one effect.
 *   - `intent` — "about to attempt `effect` identified by
 *     `idempotency_key`", `payload.expected` carries whatever a later
 *     `observed` check needs.
 *   - `result` — the outcome of that attempt, `payload.ok`
 *     (+ `payload.observed`/`payload.detail`). An effect counts as **applied**
 *     iff a `result` row with `ok:true` exists for its key
 *     (`foldJournal`/`reconcile`, domain/landing.ts).
 *
 * `idempotency_key` is what makes reconciliation crash-safe: a process that
 * dies between `intent` and `result` leaves the effect ambiguous, and
 * `reconcile` resolves it by checking whether the world already shows that
 * key applied (`'adopt'`, no re-apply) rather than blindly retrying
 * (`'apply'`) and risking a duplicate merge/PR/ticket-close.
 */
export const landingJournal = sqliteTable('landing_journal', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id')
    .notNull()
    .references(() => runs.id),
  /** Monotonic per-Run sequence (1-based); same discipline as `run_facts.seq`. */
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  /** 'ponc' | 'intent' | 'result'. */
  kind: text('kind').$type<LandingJournalKind>().notNull(),
  /** 'target-ref' | 'open-pr' | 'ticket-close'; null for 'ponc'. */
  effect: text('effect').$type<LandingEffect>(),
  /** The effect's identity for idempotency/reconciliation; null for 'ponc'. */
  idempotencyKey: text('idempotency_key'),
  /** JSON payload — kind-specific detail (cutoffSeq / expected / ok+observed+detail). */
  payload: text('payload').notNull().default('{}'),
}, (t) => [
  uniqueIndex('landing_journal_run_seq_unique').on(t.runId, t.seq),
]);

export type LandingJournalRow = typeof landingJournal.$inferSelect;

/**
 * The Session turn queue's persisted substrate (issue #116, reliability-design
 * §0.4): every turn a producer (`initial`, `continue`, `steer`, `self-heal`,
 * `re-merge`, `crash-recovery`) enqueues onto a Session's queue, in per-Session
 * FIFO order. The pure `planTurnQueue` (domain/turn-queue.ts) is the sole
 * decision of which pending row to dispatch and which to cancel; this table
 * only stores what it decides over and the outcome.
 *
 * Two indexes carry the queue's integrity guarantees:
 *
 *   - `turn_queue_session_seq_unique` on `(session_id, seq)` — the same
 *     monotonicity guarantee as `run_facts_run_seq_unique`: two turns can
 *     never share a seq within a Session, so the queue has a single total
 *     FIFO order.
 *   - `turn_queue_single_flight` — a **partial** unique index on `session_id`
 *     scoped to `status = 'in_flight'` — is the DB-level backstop for the
 *     planner's single-flight rule (`planTurnQueue`'s AC1): a second
 *     concurrent `markInFlight` for the same Session is rejected loudly by a
 *     raw UNIQUE violation rather than silently letting two turns race onto
 *     the same live harness process. Because the index only covers rows
 *     currently `in_flight`, a Session can freely accumulate any number of
 *     `queued`/`claimed`/settled rows — only ever one `in_flight` at a time.
 */
export const turnQueue = sqliteTable('turn_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  runId: integer('run_id')
    .notNull()
    .references(() => runs.id),
  /** Monotonic per-Session sequence (1-based); the queue's FIFO order. */
  seq: integer('seq').notNull(),
  status: text('status').$type<TurnStatus>().notNull(),
  purpose: text('purpose').$type<TurnPurpose>().notNull(),
  // Precondition bindings this turn was enqueued against — validated by
  // `planTurnQueue` only if present. Null on a turn that carries no such
  // binding (e.g. a read-only turn omits the workspace fields entirely).
  expectedPhase: text('expected_phase').$type<RunPhase>(),
  expectedGeneration: integer('expected_generation'),
  expectedWorkspaceOid: text('expected_workspace_oid'),
  expectedFingerprint: text('expected_fingerprint'),
  idempotencyKey: text('idempotency_key'),
  /** Set only when `status = 'cancelled'`; the precedence-first reason from `TURN_CANCEL_PRECEDENCE`. */
  cancelReason: text('cancel_reason').$type<TurnCancelReason>(),
  enqueuedAt: integer('enqueued_at').notNull(),
  claimedAt: integer('claimed_at'),
  sentAt: integer('sent_at'),
  settledAt: integer('settled_at'),
}, (t) => [
  uniqueIndex('turn_queue_session_seq_unique').on(t.sessionId, t.seq),
  uniqueIndex('turn_queue_single_flight').on(t.sessionId).where(sql`${t.status} = 'in_flight'`),
]);

export type TurnQueueRow = typeof turnQueue.$inferSelect;
