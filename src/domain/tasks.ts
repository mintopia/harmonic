import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  tasks,
  taskDependencies,
  TASK_STATES,
  type TaskRow,
  type TaskState,
  type Workflow,
  type WayfinderType,
  type Drive,
  type WorkspaceRow,
} from '../db/schema.js';
import { resolveWorkspace } from './workspaces.js';
import { HARNESS_IDS, ISOLATION_MODES, PRIORITIES, type AppConfig } from '../config.js';
import { DomainError } from './errors.js';

// Examples ride on the request schemas too, not just the responses: the API
// page renders whatever the spec declares, so a bare field documents itself as
// `"string"`. Optional fields fall back to config defaults when omitted — the
// examples show what a caller *would* send, not what's required.
export const createTaskInputSchema = z.object({
  prompt: z.string().min(1, 'prompt is required').meta({ example: 'Add rate limiting to POST /api/tasks' }),
  /** The owning Workspace (ADR-0008); defaults to the earliest-created Workspace when omitted, so callers that predate Workspaces (MCP, older API clients) keep working unchanged. */
  workspaceId: z.number().int().positive().optional().meta({ example: 1 }),
  harness: z.enum(HARNESS_IDS).optional().meta({ example: 'claude' }),
  model: z.string().min(1).optional().meta({ example: 'sonnet-5' }),
  workingDir: z.string().min(1).optional().meta({ example: '/home/dev/harmonic' }),
  isolationMode: z.enum(ISOLATION_MODES).optional().meta({ example: 'worktree' }),
  priority: z.enum(PRIORITIES).optional().meta({ example: 'normal' }),
  state: z.enum(['draft', 'ready']).optional().meta({ example: 'ready' }),
  dependsOn: z.array(z.number().int().positive()).optional().meta({ example: [4818] }),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

// A Task's Workspace is fixed at creation (no cross-Workspace move in this slice).
export const updateTaskInputSchema = createTaskInputSchema
  .omit({ state: true, dependsOn: true, workspaceId: true })
  .partial();
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export const taskListQuerySchema = z.object({
  workspaceId: z.coerce.number().int().positive().optional().meta({ example: 1 }),
  state: z.enum(TASK_STATES).optional().meta({ example: 'awaiting-review' }),
  harness: z.enum(HARNESS_IDS).optional().meta({ example: 'claude' }),
  priority: z.enum(PRIORITIES).optional().meta({ example: 'high' }),
  /** 'cost' is handled by the API layer (cost is derived from runs, not a task column). */
  sortBy: z.enum(['createdAt', 'priority', 'cost']).optional().meta({ example: 'createdAt' }),
  order: z.enum(['asc', 'desc']).optional().meta({ example: 'desc' }),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/** A task plus its dependency context, as the API serves it. */
export interface TaskWithDeps extends TaskRow {
  dependsOn: number[];
  dependents: number[];
  /** blocked, and at least one dependency is failed or cancelled. */
  blockedOnFailed: boolean;
  /** Task ids that re-attempt this one (reverse of `reattemptOf`). */
  reattempts: number[];
}

/** States an operator may edit a task in. */
const EDITABLE_STATES: TaskState[] = ['draft', 'ready'];
/** Finished states — the only ones a task can be re-attempted from (a
 * non-terminal original could still run, so cloning it would duplicate work). */
const TERMINAL_STATES: TaskState[] = ['completed', 'failed', 'cancelled'];
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

/** Normalised input for a mirrored-Task upsert (issue #30); role fields already derived from labels. */
export interface MirrorInput {
  trackerRef: number;
  prompt: string;
  workflow: Workflow;
  wayfinderType: WayfinderType | null;
  /** Seed only — applied on insert, preserved (Harmonic-owned) on re-poll. */
  drive: Drive;
  mapRef: number | null;
  /** The tracker open/closed axis; closed → completed. */
  closed: boolean;
}

export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly getConfig: () => AppConfig,
    private readonly getWorkspaces: () => WorkspaceRow[],
    private readonly onChanged: (task: TaskRow) => void = () => {},
    private readonly onNotify: (event: TaskNotification, task: TaskRow) => void = () => {},
  ) {}

  /** {@link resolveWorkspace} over this service's Workspace list — see its doc comment. */
  private resolveWorkspace(workspaceId?: number): WorkspaceRow {
    return resolveWorkspace(this.getWorkspaces(), workspaceId);
  }

  /** Resolve execution defaults (harness/model/workingDir/isolationMode/priority) from optional overrides + config defaults. */
  private resolveExecution(
    over: Partial<Pick<CreateTaskInput, 'harness' | 'model' | 'workingDir' | 'isolationMode' | 'priority'>> = {},
    workspace: WorkspaceRow,
  ) {
    const config = this.getConfig();
    const harness = over.harness ?? config.defaults.harness;
    const harnessConfig = config.harnesses[harness];
    if (!harnessConfig) throw new DomainError('validation', `harness '${harness}' is not configured`);
    return {
      harness,
      model: over.model ?? harnessConfig.defaultModel,
      workingDir: over.workingDir ?? workspace.workingDir,
      isolationMode: over.isolationMode ?? config.defaults.isolationMode,
      priority: over.priority ?? config.defaults.priority,
    };
  }

  create(input: CreateTaskInput): TaskRow {
    const workspace = this.resolveWorkspace(input.workspaceId);
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    for (const depId of dependsOn) this.get(depId);
    const state: TaskState =
      input.state === 'draft' ? 'draft' : this.hasUnmet(dependsOn) ? 'blocked' : 'ready';
    const now = Date.now();
    const row = this.db
      .insert(tasks)
      .values({
        prompt: input.prompt,
        workspaceId: workspace.id,
        ...this.resolveExecution(input, workspace),
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

  /**
   * Upsert a mirrored Task from a tracker issue (issue #30), keyed on
   * trackerRef so re-polls are idempotent. The tracker owns the issue's shape;
   * Harmonic owns execution state — so a re-poll refreshes prompt/role/mapRef
   * but never re-seeds `drive` (that protects a runtime Escalation) and never
   * moves a Task off `running` (nothing interrupts a live Run). A closed ticket
   * settles a resting Task to completed; reopen reconciliation is left to the
   * lifecycle work downstream. blocked⇄ready is not set here — it derives from
   * the projected Dependency edges (see {@link reconcileMirroredDeps}, issue
   * #31). Mirrored Tasks never enter draft or awaiting-review.
   */
  upsertMirrored(input: MirrorInput): TaskRow {
    const existing = this.db.select().from(tasks).where(eq(tasks.trackerRef, input.trackerRef)).get();
    const now = Date.now();
    if (existing) {
      const state: TaskState =
        existing.state === 'running'
          ? existing.state
          : input.closed
            ? 'completed'
            : existing.state;
      const row = this.db
        .update(tasks)
        .set({
          prompt: input.prompt,
          state,
          workflow: input.workflow,
          wayfinderType: input.wayfinderType,
          mapRef: input.mapRef,
          updatedAt: now,
        })
        .where(eq(tasks.id, existing.id))
        .returning()
        .get()!;
      this.onChanged(row);
      return row;
    }
    // The poller is not yet Workspace-aware (issue #45); every mirrored Task
    // lands in the earliest-created Workspace, matching pre-Workspace behaviour.
    const workspace = this.resolveWorkspace();
    const row = this.db
      .insert(tasks)
      .values({
        prompt: input.prompt,
        workspaceId: workspace.id,
        ...this.resolveExecution({}, workspace),
        // Seed open Tasks ready; reconcileMirroredDeps re-derives blocked once
        // edges are wired in the same poll.
        state: input.closed ? 'completed' : 'ready',
        origin: 'mirrored',
        trackerRef: input.trackerRef,
        workflow: input.workflow,
        wayfinderType: input.wayfinderType,
        drive: input.drive,
        mapRef: input.mapRef,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    // No task.created notify: a mirrored Task is a projection, not an authored
    // Task, and a first poll would otherwise storm one notification per issue.
    this.onChanged(row);
    return row;
  }

  list(query: TaskListQuery = {}): TaskRow[] {
    const filters = [
      query.workspaceId ? eq(tasks.workspaceId, query.workspaceId) : undefined,
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
      // Requeue bakes feedback into the prompt in place; clear any re-attempt
      // feedback column so the runner doesn't append it a second time.
      feedback: null,
    };
    if (feedback && feedback.trim().length > 0) {
      patch.prompt = `${task.prompt}\n\n## Feedback from the previous attempt\n\n${feedback.trim()}`;
    }
    const row = this.db.update(tasks).set(patch).where(eq(tasks.id, id)).returning().get()!;
    this.onChanged(row);
    return row;
  }

  /**
   * Create a NEW task that re-attempts an existing one: a copy of its
   * config and dependencies, linked back via `reattemptOf`, carrying the
   * reviewer's feedback in full. The feedback is composed into the run
   * prompt at run time (see the runner), so the original prompt stays
   * pristine. The original task is left untouched.
   */
  reattempt(originalId: number, feedback?: string): TaskRow {
    const original = this.get(originalId);
    if (!TERMINAL_STATES.includes(original.state)) {
      throw new DomainError(
        'invalid_state',
        `task ${originalId} is ${original.state}; only a finished task (completed, failed, or cancelled) can be re-attempted`,
      );
    }
    const dependsOn = this.dependsOn(originalId);
    const now = Date.now();
    const row = this.db
      .insert(tasks)
      .values({
        prompt: original.prompt,
        workspaceId: original.workspaceId,
        harness: original.harness,
        model: original.model,
        workingDir: original.workingDir,
        isolationMode: original.isolationMode,
        priority: original.priority,
        state: this.hasUnmet(dependsOn) ? 'blocked' : 'ready',
        reattemptOf: originalId,
        feedback: feedback && feedback.trim().length > 0 ? feedback.trim() : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (dependsOn.length > 0) {
      this.db.insert(taskDependencies).values(dependsOn.map((dependsOnId) => ({ taskId: row.id, dependsOnId }))).run();
    }
    // Rewire the original's dependents onto this re-attempt so a pipeline
    // waiting on the original advances once the re-attempt completes (the
    // original stays failed as history, but nothing depends on it anymore).
    for (const dependentId of this.dependents(originalId)) {
      this.db
        .delete(taskDependencies)
        .where(and(eq(taskDependencies.taskId, dependentId), eq(taskDependencies.dependsOnId, originalId)))
        .run();
      this.db.insert(taskDependencies).values({ taskId: dependentId, dependsOnId: row.id }).onConflictDoNothing().run();
      this.rederiveBlocked(dependentId);
      // Emit even when the state didn't flip: blockedOnFailed changed.
      this.onChanged(this.get(dependentId));
    }
    this.onChanged(row);
    this.onNotify('task.created', row);
    return row;
  }

  /**
   * Escalate an afk Run to a human (issue #33): the runtime afk→hitl flip.
   * Lands the Task back in ready flagged "escalated", drive → hitl, so the
   * Auto-Runner skips it and the poll's reconcile releases the advisory claim.
   * Used both when a Run blocks on a human prompt and when Auto-Retry is
   * exhausted.
   */
  escalate(id: number): TaskRow {
    const row = this.db
      .update(tasks)
      .set({ state: 'ready', drive: 'hitl', escalated: true, updatedAt: Date.now() })
      .where(eq(tasks.id, id))
      .returning()
      .get()!;
    this.onChanged(row);
    return row;
  }

  /**
   * Un-escalate a mirrored Task (issue #33 follow-up): the operator hands a
   * Task Harmonic escalated back to autonomous drive. Clears the flag and flips
   * drive hitl→afk; the Task stays where it is (usually ready), so the
   * task_changed→poke path re-picks it for an afk Run. The inverse of
   * {@link escalate}.
   */
  unescalate(id: number): TaskRow {
    const task = this.get(id);
    if (task.origin !== 'mirrored') {
      throw new DomainError('conflict', `task ${id} is native; only mirrored Tasks escalate`);
    }
    if (!task.escalated) throw new DomainError('invalid_state', `task ${id} is not escalated`);
    const row = this.db
      .update(tasks)
      .set({ drive: 'afk', escalated: false, updatedAt: Date.now() })
      .where(eq(tasks.id, id))
      .returning()
      .get()!;
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

  /** Task ids that re-attempt this one (reverse of the `reattemptOf` link). */
  reattempts(taskId: number): number[] {
    return this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.reattemptOf, taskId))
      .all()
      .map((r) => r.id);
  }

  /** A mirrored Task's blocking is the tracker's `blockedBy` projection — read-only
   * to operators; edges only change where the dependent is a native Task (issue #31). */
  private assertOperatorEditable(task: TaskRow): void {
    if (task.origin === 'mirrored') {
      throw new DomainError('conflict', `task ${task.id} is mirrored; its blocking is tracker-owned and read-only`);
    }
  }

  /**
   * Set a mirrored Task's dependency edges to exactly `dependsOnIds` — the
   * tracker's `blockedBy` projected onto real edges (issue #31) — then re-derive
   * blocked⇄ready. Edges change for any Task, but the re-derive only flips a
   * resting Task: a running Run is never interrupted and nothing cascades.
   */
  reconcileMirroredDeps(taskId: number, dependsOnIds: number[]): void {
    const desired = new Set(dependsOnIds.filter((id) => id !== taskId));
    const current = new Set(this.dependsOn(taskId));
    for (const id of desired) {
      if (!current.has(id)) {
        this.db.insert(taskDependencies).values({ taskId, dependsOnId: id }).onConflictDoNothing().run();
      }
    }
    for (const id of current) {
      if (!desired.has(id)) {
        this.db
          .delete(taskDependencies)
          .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, id)))
          .run();
      }
    }
    this.rederiveBlocked(taskId);
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
    this.assertOperatorEditable(task);
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
    this.assertOperatorEditable(this.get(taskId));
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
      reattempts: this.reattempts(task.id),
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
