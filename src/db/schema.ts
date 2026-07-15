import { sqliteTable, integer, text, primaryKey, index, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

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

export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  prompt: text('prompt').notNull(),
  harness: text('harness').notNull(),
  model: text('model').notNull(),
  workingDir: text('working_dir').notNull(),
  isolationMode: text('isolation_mode').notNull(),
  priority: text('priority').notNull(),
  state: text('state').$type<TaskState>().notNull(),
  /** The original this task re-attempts (a new attempt is a new, linked task). */
  reattemptOf: integer('reattempt_of').references((): AnySQLiteColumn => tasks.id),
  /** Reviewer feedback that seeded this re-attempt, stored in full, separate from the prompt. */
  feedback: text('feedback'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  // withDeps looks up reattempts (reverse link) per task on the board/table
  // hot path; index the FK so that stays cheap as the table grows.
  index('tasks_reattempt_of_idx').on(t.reattemptOf),
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
  /** Failure reason: 'interrupted', an error message, or null. */
  reason: text('reason'),
  /** ACP stopReason from the session/prompt result. */
  stopReason: text('stop_reason'),
  sessionId: text('session_id'),
  /** Worktree mode: the run's branch and the branch it was cut from. */
  branch: text('branch'),
  baseBranch: text('base_branch'),
  /** JSON: aggregate usage from the ACP prompt result. */
  usage: text('usage'),
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
  state: text('state').$type<ConversationState>().notNull(),
  /** The warm ACP session id, set once the harness spawns; null before the first Turn. */
  sessionId: text('session_id'),
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

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationEventRow = typeof conversationEvents.$inferSelect;

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
  /** 'full' for operator keys; 'run' for per-run scoped keys. */
  scope: text('scope').notNull().default('full'),
  runId: integer('run_id'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  revokedAt: integer('revoked_at'),
});

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export type TaskRow = typeof tasks.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
