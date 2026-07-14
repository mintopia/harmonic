import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { tasks, taskDependencies, TASK_STATES, type TaskRow, type TaskState } from '../db/schema.js';
import { HARNESS_IDS, ISOLATION_MODES, PRIORITIES, type AppConfig } from '../config.js';
import { DomainError } from './errors.js';

export const createTaskInputSchema = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  harness: z.enum(HARNESS_IDS).optional(),
  model: z.string().min(1).optional(),
  workingDir: z.string().min(1).optional(),
  isolationMode: z.enum(ISOLATION_MODES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  state: z.enum(['draft', 'ready']).optional(),
  dependsOn: z.array(z.number().int().positive()).optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskInputSchema = createTaskInputSchema.omit({ state: true, dependsOn: true }).partial();
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export const taskListQuerySchema = z.object({
  state: z.enum(TASK_STATES).optional(),
  harness: z.enum(HARNESS_IDS).optional(),
  priority: z.enum(PRIORITIES).optional(),
  sortBy: z.enum(['createdAt', 'priority']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/** A task plus its dependency context, as the API serves it. */
export interface TaskWithDeps extends TaskRow {
  dependsOn: number[];
  dependents: number[];
  /** blocked, and at least one dependency is failed or cancelled. */
  blockedOnFailed: boolean;
}

/** States an operator may edit a task in. */
const EDITABLE_STATES: TaskState[] = ['draft', 'ready'];
/** States a task can be cancelled from — everything not terminal. */
const CANCELLABLE_STATES: TaskState[] = [
  'draft',
  'blocked',
  'ready',
  'running',
  'awaiting-review',
  'failed',
];

export type TaskNotification =
  | 'task.created'
  | 'run.started'
  | 'task.awaiting-review'
  | 'task.completed'
  | 'task.failed';

const STATE_NOTIFICATIONS: Partial<Record<TaskState, TaskNotification>> = {
  running: 'run.started',
  'awaiting-review': 'task.awaiting-review',
  completed: 'task.completed',
  failed: 'task.failed',
};

export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly getConfig: () => AppConfig,
    private readonly onChanged: (task: TaskRow) => void = () => {},
    private readonly onNotify: (event: TaskNotification, task: TaskRow) => void = () => {},
  ) {}

  create(input: CreateTaskInput): TaskRow {
    const config = this.getConfig();
    const harness = input.harness ?? config.defaults.harness;
    const harnessConfig = config.harnesses[harness];
    if (!harnessConfig) throw new DomainError('validation', `harness '${harness}' is not configured`);
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    for (const depId of dependsOn) this.get(depId);
    const state: TaskState =
      input.state === 'draft' ? 'draft' : this.hasUnmet(dependsOn) ? 'blocked' : 'ready';
    const now = Date.now();
    const row = this.db
      .insert(tasks)
      .values({
        prompt: input.prompt,
        harness,
        model: input.model ?? harnessConfig.defaultModel,
        workingDir: input.workingDir ?? config.defaults.workingDir,
        isolationMode: input.isolationMode ?? config.defaults.isolationMode,
        priority: input.priority ?? config.defaults.priority,
        state,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (dependsOn.length > 0) {
      this.db.insert(taskDependencies).values(dependsOn.map((dependsOnId) => ({ taskId: row.id, dependsOnId }))).run();
    }
    this.onChanged(row);
    this.onNotify('task.created', row);
    return row;
  }

  list(query: TaskListQuery = {}): TaskRow[] {
    const filters = [
      query.state ? eq(tasks.state, query.state) : undefined,
      query.harness ? eq(tasks.harness, query.harness) : undefined,
      query.priority ? eq(tasks.priority, query.priority) : undefined,
    ].filter((f) => f !== undefined);
    let rows = this.db
      .select()
      .from(tasks)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .all();
    if (query.sortBy) {
      const dir = query.order === 'desc' ? -1 : 1;
      const rank: Record<string, number> = { high: 0, normal: 1, low: 2 };
      rows = rows.sort((a, b) => {
        const cmp =
          query.sortBy === 'priority'
            ? (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) || a.createdAt - b.createdAt
            : a.createdAt - b.createdAt || a.id - b.id;
        return cmp * dir;
      });
    }
    return rows;
  }

  get(id: number): TaskRow {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) throw new DomainError('not_found', `task ${id} not found`);
    return row;
  }

  update(id: number, input: UpdateTaskInput): TaskRow {
    const task = this.get(id);
    if (!EDITABLE_STATES.includes(task.state)) {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}; only draft or ready tasks can be edited`);
    }
    if (input.harness) {
      const config = this.getConfig();
      if (!config.harnesses[input.harness]) {
        throw new DomainError('validation', `harness '${input.harness}' is not configured`);
      }
    }
    const row = this.db
      .update(tasks)
      .set({ ...input, updatedAt: Date.now() })
      .where(eq(tasks.id, id))
      .returning()
      .get()!;
    this.onChanged(row);
    return row;
  }

  /** Promote a draft to ready (or blocked, when dependencies are unmet). */
  promote(id: number): TaskRow {
    const task = this.get(id);
    if (task.state !== 'draft') {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}; only drafts can be promoted to ready`);
    }
    return this.setState(id, this.hasUnmet(this.dependsOn(id)) ? 'blocked' : 'ready');
  }

  /**
   * Send a failed task back to ready for another attempt. Optional
   * feedback is appended to the prompt so the retry learns from what
   * went wrong.
   */
  requeue(id: number, feedback?: string): TaskRow {
    const task = this.get(id);
    if (task.state !== 'failed') {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}; only failed tasks can be re-queued`);
    }
    const patch: Partial<TaskRow> = {
      state: this.hasUnmet(this.dependsOn(id)) ? 'blocked' : 'ready',
      updatedAt: Date.now(),
    };
    if (feedback && feedback.trim().length > 0) {
      patch.prompt = `${task.prompt}\n\n## Feedback from previous attempt\n\n${feedback.trim()}`;
    }
    const row = this.db.update(tasks).set(patch).where(eq(tasks.id, id)).returning().get()!;
    this.onChanged(row);
    return row;
  }

  cancel(id: number): TaskRow {
    const task = this.get(id);
    if (!CANCELLABLE_STATES.includes(task.state)) {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}, which is terminal`);
    }
    return this.setState(id, 'cancelled');
  }

  setState(id: number, state: TaskState): TaskRow {
    const row = this.db
      .update(tasks)
      .set({ state, updatedAt: Date.now() })
      .where(eq(tasks.id, id))
      .returning()
      .get()!;
    this.onChanged(row);
    const notification = STATE_NOTIFICATIONS[state];
    if (notification) this.onNotify(notification, row);
    // Completion is what satisfies dependents (accepted, not merely
    // finished) — unblock any whose last unmet dependency this was.
    if (state === 'completed') {
      for (const dependentId of this.dependents(id)) {
        const dependent = this.get(dependentId);
        if (dependent.state === 'blocked' && !this.hasUnmet(this.dependsOn(dependentId))) {
          this.setState(dependentId, 'ready');
        }
      }
    }
    return row;
  }

  // ---- Dependencies ----

  dependsOn(taskId: number): number[] {
    return this.db
      .select({ id: taskDependencies.dependsOnId })
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, taskId))
      .all()
      .map((r) => r.id);
  }

  dependents(taskId: number): number[] {
    return this.db
      .select({ id: taskDependencies.taskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.dependsOnId, taskId))
      .all()
      .map((r) => r.id);
  }

  private hasUnmet(depIds: number[]): boolean {
    if (depIds.length === 0) return false;
    const states = this.db
      .select({ state: tasks.state })
      .from(tasks)
      .where(inArray(tasks.id, depIds))
      .all();
    return states.length < depIds.length || states.some((r) => r.state !== 'completed');
  }

  addDependency(taskId: number, dependsOnId: number): TaskWithDeps {
    const task = this.get(taskId);
    this.get(dependsOnId);
    if (!EDITABLE_STATES.includes(task.state) && task.state !== 'blocked') {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; dependencies can only change on draft, ready, or blocked tasks`);
    }
    if (taskId === dependsOnId || this.reaches(dependsOnId, taskId)) {
      throw new DomainError('conflict', `dependency ${taskId} → ${dependsOnId} would create a cycle`);
    }
    this.db.insert(taskDependencies).values({ taskId, dependsOnId }).onConflictDoNothing().run();
    this.rederiveBlocked(taskId);
    return this.withDeps(this.get(taskId));
  }

  removeDependency(taskId: number, dependsOnId: number): TaskWithDeps {
    this.get(taskId);
    this.db
      .delete(taskDependencies)
      .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, dependsOnId)))
      .run();
    this.rederiveBlocked(taskId);
    return this.withDeps(this.get(taskId));
  }

  /** Cancel a task and everything that transitively depends on it. */
  cancelWithDependents(id: number): number[] {
    const toCancel = [id];
    const seen = new Set(toCancel);
    for (let i = 0; i < toCancel.length; i++) {
      for (const dep of this.dependents(toCancel[i]!)) {
        if (!seen.has(dep)) {
          seen.add(dep);
          toCancel.push(dep);
        }
      }
    }
    const cancelled: number[] = [];
    for (const taskId of toCancel) {
      const task = this.get(taskId);
      if (taskId === id || CANCELLABLE_STATES.includes(task.state)) {
        this.cancel(taskId);
        cancelled.push(taskId);
      }
    }
    return cancelled;
  }

  withDeps(task: TaskRow): TaskWithDeps {
    const dependsOn = this.dependsOn(task.id);
    const depStates = dependsOn.map((depId) => this.get(depId).state);
    return {
      ...task,
      dependsOn,
      dependents: this.dependents(task.id),
      blockedOnFailed:
        task.state === 'blocked' && depStates.some((s) => s === 'failed' || s === 'cancelled'),
    };
  }

  listWithDeps(query: TaskListQuery = {}): TaskWithDeps[] {
    return this.list(query).map((task) => this.withDeps(task));
  }

  /** Is `to` reachable from `from` following depends-on edges? */
  private reaches(from: number, to: number): boolean {
    const queue = [from];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === to) return true;
      for (const next of this.dependsOn(current)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }

  /** blocked ⇄ ready, re-derived after a dependency edit. */
  private rederiveBlocked(taskId: number): void {
    const task = this.get(taskId);
    const unmet = this.hasUnmet(this.dependsOn(taskId));
    if (task.state === 'ready' && unmet) this.setState(taskId, 'blocked');
    else if (task.state === 'blocked' && !unmet) this.setState(taskId, 'ready');
  }

}
