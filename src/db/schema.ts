import { sql } from 'drizzle-orm';
import { sqliteTable, integer, text, primaryKey, index, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
// Type-only import (erased at compile) so the db layer can brand `runs.phase`
// with the phase-machine enum without a runtime db→domain import cycle
// (domain/run-facts.ts already imports this schema).
import type { RunPhase } from '../domain/run-phases.js';
// Type-only import (erased at compile), same db→domain-cycle-free reasoning as
// `RunPhase` above: brands `verification_attempts.verdict` with the canonical
// verdict enum so the column is literal-typed like `mechanism`/`phase`.
import type { Verdict } from '../verification/critic-schema.js';
// Type-only import, same reasoning: brands `turn_queue`'s status/purpose/
// cancel-reason columns without a runtime db→domain import cycle
// (domain/turn-queue-store.ts already imports this schema).
import type { TurnStatus, TurnPurpose, TurnCancelReason } from '../domain/turn-queue.js';
// Type-only import, same reasoning: brands `merge_journal`'s kind/effect
// columns without a runtime db→domain import cycle (domain/merge.ts already
// imports nothing from this schema — it is deliberately DB-free — but the
// canonical `MergeEffect`/`MergeJournalKind` enums still live there so
// the pure module stays the single source of truth for them).
import type { MergeEffect, MergeJournalKind } from '../domain/merge.js';
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
  /** Task-default integration-retry bound (ADR-0046); null inherits `config.defaults.integrationRetries`. */
  integrationRetries: integer('integration_retries'),
  /** Task-default conflict-resolve-turn bound (ADR-0046); null inherits `config.defaults.conflictResolveTurns`. */
  conflictResolveTurns: integer('conflict_resolve_turns'),
  /** Per-Workspace concurrency cap; null inherits the Machine Ceiling
   * (`config.autoRunner.maxConcurrentRuns`). Clamped to the ceiling on read —
   * an override can never breach the machine's limit (`resolveCap`). */
  maxConcurrentRuns: integer('max_concurrent_runs'),
  /** Per-Workspace Auto-Runner enable; null inherits the global default. Gated
   * by the global master switch — a Task runs only if `master ∧ resolved`. */
  autoRunnerEnabled: integer('auto_runner_enabled', { mode: 'boolean' }),
  /** Per-Workspace command-verifier override (issue #132, ADR-0021), list-grain
   * (ADR-0044 §D, issue #338): a JSON array of `verificationCommandSchema` that
   * overrides the whole global list — a non-empty array is that ordered list, an
   * empty array `[]` is *off* (run no commands here) — or null to inherit
   * `config.verify.commands`. No per-command inheritance and no `{"off":true}`
   * sentinel (migrated away in 0057). Resolved at read time by `resolveVerifiers`
   * (setting-override.ts). */
  verificationCommand: text('verification_command'),
  /** Per-Workspace critic-review override (issue #337, ADR-0044 §C), decomposed
   * into four independently-inheritable scalar columns — each null inherits the
   * matching `config.verify.review.*` field. Resolved at read time by
   * `resolveVerifiers` (setting-override.ts). Replaces the old atomic
   * `verification_critic` blob + `{"off":true}` sentinel (migrated in 0059). */
  reviewEnabled: integer('review_enabled', { mode: 'boolean' }),
  reviewPrompt: text('review_prompt'),
  reviewModel: text('review_model'),
  reviewHarness: text('review_harness'),
  /** Per-Workspace budget-Guardrail override (issue #126, ADR-0019): JSON of
   * `budgetGuardrailSchema`, or null to inherit `config.guardrails.budget`.
   * Resolved by `resolveGuardrails` (setting-override.ts). */
  guardrailBudget: text('guardrail_budget'),
  /** Per-Workspace progress-detector toggle override (issue #126); null inherits
   * `config.guardrails.progress`. */
  guardrailProgress: integer('guardrail_progress', { mode: 'boolean' }),
  /** Per-Workspace attempt cap; null inherits `config.maxAttempts`. */
  maxAttempts: integer('max_attempts'),
  /** Per-Workspace context-reuse token limit; null inherits the global default. */
  contextReuseTokenLimit: integer('context_reuse_token_limit'),
  // --- Drive + Task Prompt overrides (ADR-0044): the `drive.*` block decomposes
  // into five independently-inheritable fields, plus the Task Prompt and the
  // tool-timeout bound. Null ⇒ inherit the global default; resolved at read time
  // (`resolveDrive` / `resolveScoped`, setting-override.ts). ---
  /** Per-Workspace Drive Prompt override; null inherits `config.drive.prompt`. */
  drivePrompt: text('drive_prompt'),
  /** Per-Workspace unattended-reminder override; null inherits `config.drive.unattendedReminder`. */
  driveUnattendedReminder: text('drive_unattended_reminder'),
  /** Per-Workspace continue-prompt override; null inherits `config.drive.continuePrompt`. */
  driveContinuePrompt: text('drive_continue_prompt'),
  /** Per-Workspace Merge Fate override; null inherits `config.drive.mergeFate`. */
  driveMergeFate: text('drive_merge_fate'),
  /** Per-Workspace continue-attempts override; null inherits `config.drive.continueAttempts`. */
  driveContinueAttempts: integer('drive_continue_attempts'),
  /** Per-Workspace Task Prompt override; null inherits `config.taskPrompt`. */
  taskPrompt: text('task_prompt'),
  /** Per-Workspace tool-timeout override (ADR-0044); null inherits `config.guardrails.toolTimeoutMinutes`. */
  toolTimeoutMinutes: integer('tool_timeout_minutes'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  uniqueIndex('workspaces_working_dir_idx').on(t.workingDir),
]);

export type WorkspaceRow = typeof workspaces.$inferSelect;

/**
 * Durable bookkeeping for recurring Scheduled Jobs (ADR-0038). `jobKey` is a
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
  /** Integration-retry bound override (ADR-0046); null inherits `config.defaults.integrationRetries`. */
  integrationRetries: integer('integration_retries'),
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
   * §0.2): `executing → validating → verifying → merging → terminal`. Persisted
   * so the phase survives a restart and is reconstructable from the Run row
   * alone (never inferred from Task columns); surfaced on the Run API + card.
   * Null on pre-feature Runs. Distinct from `state`: `state` is the
   * execution/terminal RunState, `phase` is *where in its lifecycle* the Run is.
   */
  phase: text('phase').$type<RunPhase>(),
  /** Failure reason: 'interrupted', an error message, or null. */
  reason: text('reason'),
  /** ACP stopReason from the session/prompt result. */
  stopReason: text('stop_reason'),
  sessionId: text('session_id'),
  /**
   * The durable Session (issue #141, reliability-design Unit C) this Run is
   * bound to — the Harmonic-generated `sessions.id`, set on dispatch alongside
   * the ACP `sessionId` above once `session/new` returns. Null on pre-feature
   * Runs and until the harness session is created. The Session is written
   * *alongside* the Run, never in place of it, so this binding is purely
   * additive and changes no in-flight Run behaviour.
   */
  sessionRowId: integer('session_row_id').references((): AnySQLiteColumn => sessions.id),
  /**
   * The Execution Chain (issue #129) this Run belongs to — shared with the
   * sibling Runs that continue the same line of work, so a cumulative spend
   * budget is charged across the chain and a retry can't reset it. Null on
   * pre-feature Runs. Established when a Run starts a new line of work and
   * carried forward when a related Run reattaches (see beginRun / the chain
   * resolver).
   */
  chainId: integer('chain_id').references((): AnySQLiteColumn => executionChains.id),
  /** The exact prompt text sent to the harness for this Run (native = filled
   * Task Prompt template + any feedback; mirrored = the filled Drive Prompt).
   * Persisted so Task detail's Prompt tab shows what actually went to the
   * agent; null for pre-feature Runs and until the prompt turn is sent. */
  prompt: text('prompt'),
  /** Worktree mode: the run's branch and the branch it was cut from. */
  branch: text('branch'),
  baseBranch: text('base_branch'),
  /** Immutable revisions for the settled worktree diff. They outlive the run
   * branch, which merging or cleanup can advance or delete. */
  diffBaseOid: text('diff_base_oid'),
  diffHeadOid: text('diff_head_oid'),
  /** `git diff --stat` snapshot taken when the run settles; null in direct
   * mode or before settle. The card and Task detail both read this so they
   * can never disagree (issue #36). */
  stat: text('stat'),
  /**
   * The committed implementation head a Run is verified against (issue #134,
   * reshaped by the unified lifecycle): the branch-head OID captured at
   * implementation end, before finalize restores the checkout. Null when there
   * is nothing verifiable — a pre-feature Run, an escalated Run, or a Run that
   * left no new commit (the fail-closed no-candidate path). */
  candidateOid: text('candidate_oid'),
  /** The private Harmonic ref (`refs/harmonic/direct/run-<id>`) a **direct**
   * Run's head is pinned to, from which it is rematerialized for verification
   * or a later corrective turn. Null for worktree Runs — their own branch owns
   * the head — so it can be null while `candidateOid` is set. */
  candidateRef: text('candidate_ref'),
  /** JSON: aggregate usage from the ACP prompt result. */
  usage: text('usage'),
  /** JSON: Cost frozen when the Run's final Usage is recorded (ADR-0035). */
  cost: text('cost'),
  /** JSON: latest live-usage snapshot (rolled-up Usage + context fill +
   * current-activity line + Process Tree), overwritten on a coarse ~10s
   * cadence and on finish (ADR 0010). */
  liveUsage: text('live_usage'),
  /** JSON: the effective Guardrail config (`ResolvedGuardrails`) snapshotted at
   * Run start (issue #126, ADR-0019); null for pre-feature Runs. A later config
   * change never alters this — the Run trips against what it captured. */
  guardrailConfig: text('guardrail_config'),
  /** JSON: the effective price table (`PriceTable`) snapshotted at Run start, so
   * a mid-Run price edit can't retroactively change a cost trip (issue #126). */
  priceTable: text('price_table'),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
});

/**
 * Per-Run tool-call counts (ADR-0031). The runner will overwrite these rows
 * from its in-memory rollup; Task and Epic totals are derived on read through
 * `runs.taskId` and `tasks.mapRef`, so they cannot drift from task ownership.
 */
export const runToolCalls = sqliteTable(
  'run_tool_calls',
  {
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id),
    toolName: text('tool_name').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.toolName] })],
);
export type RunToolCallRow = typeof runToolCalls.$inferSelect;

/** One pass through a Ticket's implement → verify loop (ADR-0041). */
export const ATTEMPT_STATES = ['running', 'passed', 'failed', 'escalated', 'cancelled'] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];
export const ATTEMPT_TASK_TYPES = ['rebase', 'implementation', 'verification', 'review'] as const;
export type AttemptTaskType = (typeof ATTEMPT_TASK_TYPES)[number];
export const ATTEMPT_TASK_STATES = ['pending', 'running', 'passed', 'failed', 'skipped', 'cancelled'] as const;
export type AttemptTaskState = (typeof ATTEMPT_TASK_STATES)[number];

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
}, (t) => [uniqueIndex('attempts_task_number_unique').on(t.taskId, t.number)]);
export type AttemptRow = typeof attempts.$inferSelect;

/** Individually visible work within an Attempt. `logLocator` points to its transcript/output. */
export const attemptTasks = sqliteTable('attempt_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  attemptId: integer('attempt_id').notNull().references(() => attempts.id),
  type: text('type').$type<AttemptTaskType>().notNull(),
  position: integer('position').notNull(),
  state: text('state').$type<AttemptTaskState>().notNull().default('pending'),
  command: text('command'),
  verdict: text('verdict'),
  logLocator: text('log_locator'),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
}, (t) => [uniqueIndex('attempt_tasks_attempt_position_unique').on(t.attemptId, t.position)]);
export type AttemptTaskRow = typeof attemptTasks.$inferSelect;

/**
 * The Execution Chain (issue #129, reliability-design Unit A): a persisted
 * identity threaded across every Run that continues one line of work —
 * retry / human-review rejection / crash-resume / every corrective turn — so
 * a cumulative token/cost budget is charged against the
 * whole chain, not reset by each fresh Run. A retry therefore cannot reset the
 * spend counter to bypass the ceiling. Per-Run budgets still apply alongside it.
 */
export const executionChains = sqliteTable('execution_chains', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: integer('created_at').notNull(),
});
export type ExecutionChainRow = typeof executionChains.$inferSelect;

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

/** The raw `tasks` row: the inheritable Task-default overrides read back nullable
 * (`null` ⇒ inherit). Used only inside TaskService, which resolves them. */
export type RawTaskRow = typeof tasks.$inferSelect;
/** A `tasks` row as every consumer sees it: the inheritable defaults
 * already resolved to their effective values (never null). TaskService.get/
 * list/etc. return this; storage speaks `RawTaskRow`. */
export type TaskRow = Omit<
  RawTaskRow,
  'harness' | 'model' | 'isolationMode' | 'priority' | 'integrationRetries' | 'conflictResolveTurns'
> & {
  harness: string;
  model: string;
  isolationMode: string;
  priority: string;
  integrationRetries: number;
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

export type RunRow = typeof runs.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;

export const LEASE_STATES = ['held', 'suspect'] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

/**
 * A Work Context lease (issue #118, ADR-0022, reliability-design §0.5): the
 * persisted claim that a Run owns exclusive occupancy of a Work Context (a
 * canonical working-directory/branch identity, `workContextKey` in
 * domain/work-context-key.ts) for a phase of its lifecycle. `phase` is always
 * `'running'` today — the phase machine (#114) will widen it. `expiry` is set
 * from birth and re-derived on every phase-aware heartbeat by the live TTL
 * sweep (#122, `domain/lease-ttl.ts`); `state` starts `'held'` and flips to
 * `'suspect'` either when that live sweep lapses it or via boot reconciliation
 * (#123).
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
  /** TTL deadline (issue #122): set at acquire and re-derived on every
   * phase-aware heartbeat (`domain/lease-ttl.ts`); nullable only for rows that
   * predate the TTL machinery. */
  expiry: integer('expiry'),
  state: text('state').$type<LeaseState>().notNull(),
  acquiredAt: integer('acquired_at').notNull(),
}, (t) => [
  uniqueIndex('work_context_leases_key_unique').on(t.key),
]);

export type WorkContextLeaseRow = typeof workContextLeases.$inferSelect;

/** Operator dispositions a Work Context lease can be given (issue #125,
 * ADR-0022): `supersede` re-points a stuck (typically `suspect`) lease's
 * ownership to a Run the operator names; `unlock` force-releases it outright,
 * freeing the key for a fresh acquire. Both are manual escapes from a lease
 * boot reconciliation (#123) or the live sweep (#122) could only flag, never
 * resolve on its own. */
export const LEASE_DISPOSITION_ACTIONS = ['supersede', 'unlock'] as const;
export type LeaseDispositionAction = (typeof LEASE_DISPOSITION_ACTIONS)[number];

/**
 * The append-only operator-disposition audit log for Work Context leases
 * (issue #125, ADR-0022): every `supersede`/`unlock` an operator issues is one
 * immutable row, mirroring `run_facts`/`guardrail_events`'s discipline —
 * written, never updated — so a lease's disposition history survives whatever
 * happens to the lease row itself (a `supersede` mutates it in place; an
 * `unlock` deletes it outright). No FK on `key` — a lease disposition
 * legitimately outlives the lease row it acted on (an `unlock` deletes it,
 * and a `key` can be re-acquired by an unrelated later Run), so this log is
 * keyed by the plain string identity, not a foreign row.
 */
export const workContextLeaseDispositions = sqliteTable('work_context_lease_dispositions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** The Work Context key the disposition acted on (`workContextKey`). */
  key: text('key').notNull(),
  action: text('action').$type<LeaseDispositionAction>().notNull(),
  /** The Run the lease was re-pointed to; null for `unlock` (there is no new owner). */
  targetRunId: integer('target_run_id'),
  /** The lease's owner immediately before this disposition, for the audit trail. */
  previousOwnerRunId: integer('previous_owner_run_id'),
  /** The lease's `state` immediately before this disposition. */
  previousState: text('previous_state').$type<LeaseState>(),
  at: integer('at').notNull(),
});

export type WorkContextLeaseDispositionRow = typeof workContextLeaseDispositions.$inferSelect;

/**
 * The ending-signal fact types the coordinator understands **today** (issue
 * #112, reliability-design §0.3). Every way a Run can end is recorded as a
 * `run_fact`; this is the set that has an emitter now. Later spine units append
 * their own kinds (e.g. verify-fail) without touching the coordinator contract —
 * the column is free `text`, and the single place a new kind is *ranked* is
 * `DISPOSITION_PRECEDENCE` (domain/run-disposition.ts). So this list is a
 * convenience type, not a closed constraint: the store never rejects an unknown
 * `type`, so historical rows carrying a since-removed kind still read back.
 * `guardrail-trip` now has an emitter (issue #127, the phase-scoped wall-clock
 * Guardrail) — its structured evidence lives in the separate `guardrail_events`
 * log (see below); this fact type is the disposition-facing signal that a trip
 * happened.
 *
 * `session-resumed` and `resume-entry` (issue #146, reliability-design Unit C)
 * are the two boot-time crash-resume markers, both **non-ending** (absent from
 * `DISPOSITION_PRECEDENCE`, so they never read as a terminal
 * disposition). `session-resumed` is stamped on the interrupted Run that
 * was resumed (recording the new Run it resumed into); `resume-entry` is stamped
 * on that **new** Run (recording the interrupted Run it continues). Together they
 * make the boot resume sweep idempotent: a Run carrying either marker is never
 * itself resumed again on a later boot (`BootResumeCoordinator`).
 */
export const RUN_FACT_TYPES = [
  'operator-cancel',
  'operator-accept',
  'escalate',
  'agent-finish/unresolved',
  'failed',
  'process-death',
  'guardrail-trip',
  'session-resumed',
  'resume-entry',
  'session-continuation',
  /** Immutable proof that verification ran against this branch tip. */
  'verified-head',
  /** Terminal count of moving-base rebase/CAS retries a completion loop absorbed
   * (ADR-0046, #368). Non-ending — a moving base is normal, never a disposition;
   * it sinks below every ranked kind in `DISPOSITION_PRECEDENCE`. */
  'moving-base',
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
  /** Attempt-owned coordination key. `runId` remains during the Run compatibility window. */
  attemptId: integer('attempt_id').references(() => attempts.id),
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
 * The journaled non-interruptible merge log (issue #115, reliability-design
 * §0.3, Unit D). Merging is the set of irreversible side effects a Run's
 * completion triggers once accepted — merging a worktree branch, opening a
 * PR, closing a tracker ticket (`MergeEffect`, domain/merge.ts) — and
 * this table is the append-only record of that process, mirroring
 * `run_facts`'s discipline exactly (same `(run_id, seq)` unique index, same
 * "only ever appended, never updated" rule) so a merge can be replayed and
 * reconciled from the log alone after a crash.
 *
 * Three row kinds (`kind`), written in this order per merge:
 *   - `ponc` — written once, before the first irreversible effect: freezes
 *     `run_facts`'s cutoff at the seq the merge disposition fact just took
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
 *     (`foldJournal`/`reconcile`, domain/merge.ts).
 *
 * `idempotency_key` is what makes reconciliation crash-safe: a process that
 * dies between `intent` and `result` leaves the effect ambiguous, and
 * `reconcile` resolves it by checking whether the world already shows that
 * key applied (`'adopt'`, no re-apply) rather than blindly retrying
 * (`'apply'`) and risking a duplicate merge/PR/ticket-close.
 */
export const mergeJournal = sqliteTable('merge_journal', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id')
    .notNull()
    .references(() => runs.id),
  /** Monotonic per-Run sequence (1-based); same discipline as `run_facts.seq`. */
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  /** 'ponc' | 'intent' | 'result'. */
  kind: text('kind').$type<MergeJournalKind>().notNull(),
  /** 'target-ref' | 'open-pr' | 'ticket-close'; null for 'ponc'. */
  effect: text('effect').$type<MergeEffect>(),
  /** The effect's identity for idempotency/reconciliation; null for 'ponc'. */
  idempotencyKey: text('idempotency_key'),
  /** JSON payload — kind-specific detail (cutoffSeq / expected / ok+observed+detail). */
  payload: text('payload').notNull().default('{}'),
}, (t) => [
  uniqueIndex('merge_journal_run_seq_unique').on(t.runId, t.seq),
]);

export type MergeJournalRow = typeof mergeJournal.$inferSelect;

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
 * candidate OID (issue #136, ADR-0021, reliability-design Unit B). Mirrors
 * `run_facts`'s discipline exactly: append-only, `seq` assigned by the store
 * as `max(seq)+1`, and the `(run_id, seq)` unique index is the same
 * monotonicity guarantee — two attempts can never share a seq within a Run,
 * so the log has a single total order and a cross-process race that computed
 * the same seq is rejected loudly rather than corrupting it.
 *
 * `inputOid` is recorded per-row (not just implied by the Run's
 * `candidateOid` column) because a Run can be re-verified against more than
 * one candidate over its lifetime — a self-heal turn re-enters `validating`
 * and produces a fresh candidate (reliability-design Unit B), and the attempt
 * log is how a later reader tells which candidate each verdict actually
 * judged. `output` stores the verifier's raw output (the critic's agent
 * text); the caller is expected to cap it before it reaches here so an
 * unbounded or adversarial transcript can't grow the row without limit. `phase` defaults
 * to `'verifying'` — the only phase a Verification attempt runs in today —
 * kept as its own column rather than inferred from the Run row so the record
 * is self-describing even if the Run has since moved on.
 *
 * Written for real during a live Run: the command verifier (#135) and the
 * agent critic (#136, wired in #164) both append their per-attempt record here
 * from the `verifying` phase (`execution/runner.ts` `runVerification`), and
 * `combineVerdicts` folds the verdicts into the block/escalate/merge decision.
 * `domain/verification-attempts.ts`'s `VerificationAttemptStore` stays
 * append+list only — this is its durable audit log.
 */
export const verificationAttempts = sqliteTable('verification_attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id')
    .notNull()
    .references(() => runs.id),
  /** Monotonic per-Run sequence (1-based); same discipline as `run_facts.seq`. */
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  /** 'critic' today; 'command' reserved for the sibling verifier ticket. */
  mechanism: text('mechanism').$type<VerificationMechanism>().notNull(),
  /** The candidate OID this attempt verified (see the class doc — a Run may
   * be re-verified against more than one candidate across self-heal turns). */
  inputOid: text('input_oid').notNull(),
  /** 'pass' | 'fail' | 'inconclusive' (`verification/critic-schema.ts`'s `Verdict`). */
  verdict: text('verdict').$type<Verdict>().notNull(),
  summary: text('summary').notNull(),
  /** Raw verifier output (the critic's agent text), capped by the caller. */
  output: text('output').notNull(),
  /** The Run phase this attempt ran in; every attempt today runs in `verifying`. */
  phase: text('phase').$type<RunPhase>().notNull().default('verifying'),
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
  uniqueIndex('verification_attempts_run_seq_unique').on(t.runId, t.seq),
]);

export type VerificationAttemptRow = typeof verificationAttempts.$inferSelect;

/**
 * The Guardrail budget dimensions this table has a slot for (issue #127,
 * ADR-0019, reliability-design Unit A). `'wall-clock'` is the phase-scoped
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
 * budget is crossed, one immutable row records what tripped, in which phase,
 * against what bound, and where that bound resolved from — the evidence a
 * later Escalation card's reason derives from. Mirrors `verificationAttempts`
 * / `runFacts`'s discipline exactly: append-only, `seq` assigned by the store
 * as `max(seq)+1` (1-based, per-Run monotonic), and the `(run_id, seq)`
 * unique index is the same cross-process integrity backstop — two trips can
 * never share a seq within a Run, so the log has a single total order and a
 * racing duplicate `seq` is rejected loudly rather than corrupting it.
 *
 * This table is substrate only, same as `run_facts` was at #112 and
 * `verification_attempts` was at #136: nothing here decides anything. It does
 * not itself move a Run to Escalation — the pure trip-detection logic and the
 * Runner wiring that calls `append` and emits the corresponding
 * `guardrail-trip` run_fact are out of scope here (issue #127's logic/wiring
 * halves). `dimension` only ever observes `'wall-clock'` today; `phase` is
 * recorded per-row (not inferred from the Run) so the trip is self-describing
 * proof it was observed inside an execution phase, even after the Run has
 * since moved on. `limitValue`/`observedValue` share the dimension's unit
 * (milliseconds for wall-clock). `payload` is free-form JSON for any extra
 * evidence a future dimension's emitter wants to attach, defaulting to `'{}'`
 * when there is none.
 */
export const guardrailEvents = sqliteTable('guardrail_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id')
    .notNull()
    .references(() => runs.id),
  /** Monotonic per-Run sequence (1-based); same discipline as `run_facts.seq`. */
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  /** The budget dimension that tripped; only 'wall-clock' has an emitter today (#127). */
  dimension: text('dimension').$type<GuardrailDimension>().notNull(),
  /** The Run phase the trip was observed in — proof the trip happened inside an execution phase. */
  phase: text('phase').$type<RunPhase>().notNull(),
  /** The configured bound that was crossed, in the dimension's unit (ms for wall-clock). */
  limitValue: integer('limit_value').notNull(),
  /** The observed value at trip, same unit as `limitValue`. */
  observedValue: integer('observed_value').notNull(),
  /** Where the limit resolved from: the global default, or a Workspace override. */
  configSource: text('config_source').$type<GuardrailConfigSource>().notNull(),
  /** JSON payload — any extra evidence; `'{}'` when none. */
  payload: text('payload').notNull().default('{}'),
}, (t) => [
  uniqueIndex('guardrail_events_run_seq_unique').on(t.runId, t.seq),
]);

export type GuardrailEventRow = typeof guardrailEvents.$inferSelect;

/**
 * A Session's lifecycle status (reliability-design Unit C): `active → idle →
 * retiring → retired`. **Session retirement is the sole owner of builder-worktree
 * removal** (issue #148): a worktree Session's checkout is retained through the
 * human-rejection window (so a reject-and-continue merges in the same workspace)
 * and its builder worktree is removed **only** at retirement, coordinated with
 * the Work Context lease. `active` — a live Run owns it; `idle`
 * — no live Run, retained under a `retireDeadline` (reject-continuation / warm
 * reuse window); `retiring` — worktree removal in progress (crash-re-driven at
 * boot); `retired` — worktree removed, terminal.
 */
export const SESSION_STATUSES = ['active', 'idle', 'retiring', 'retired'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Why a Session retired (issue #148), for the operator-legible record: `merged`
 * (a successful merge + terminal success), `operator-disposition` (cancel / Close),
 * `retention-ttl` (the backstop so no idle Session retains its worktree forever).
 */
export const SESSION_RETIRE_REASONS = ['merged', 'operator-disposition', 'retention-ttl'] as const;
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
