import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

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
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

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

export type TaskRow = typeof tasks.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
