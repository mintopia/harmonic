import { and, eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { taskDependencies, type TaskRow, type TaskState } from '../db/schema.js';
import { DomainError } from './errors.js';

export interface TaskWithBlockers extends TaskRow {
  dependsOn: number[];
  dependents: number[];
  blockedOnFailed: boolean;
  openBlockerCount: number;
  agentWorkable: boolean;
  humanOnly: boolean;
  isEpic: boolean;
  overrides: {
    harness: string | null;
    model: string | null;
    isolationMode: string | null;
    priority: string | null;
    conflictResolveTurns: number | null;
  };
}

export interface TaskBlockerGraphOptions {
  get: (id: number) => Promise<TaskRow>;
  withDeps: (task: TaskRow) => Promise<TaskWithBlockers>;
  assertOperatorEditable: (task: TaskRow) => void;
  cancel: (id: number) => Promise<TaskRow>;
  onChanged: (task: TaskRow) => void;
  editableStates: readonly TaskState[];
  cancellableStates: readonly TaskState[];
}

export class TaskBlockerGraph {
  constructor(
    private readonly db: AsyncDbHandle,
    private readonly options: TaskBlockerGraphOptions,
  ) {}

  async dependsOn(taskId: number): Promise<number[]> {
    return (
      await this.db.read((db) =>
        db
          .select({ id: taskDependencies.dependsOnId })
          .from(taskDependencies)
          .where(eq(taskDependencies.taskId, taskId))
          .all(),
      )
    ).map((row) => row.id);
  }

  async dependents(taskId: number): Promise<number[]> {
    return (
      await this.db.read((db) =>
        db
          .select({ id: taskDependencies.taskId })
          .from(taskDependencies)
          .where(eq(taskDependencies.dependsOnId, taskId))
          .all(),
      )
    ).map((row) => row.id);
  }

  async addDependency(taskId: number, dependsOnId: number): Promise<TaskWithBlockers> {
    const task = await this.options.get(taskId);
    this.options.assertOperatorEditable(task);
    await this.options.get(dependsOnId);
    if (!this.options.editableStates.includes(task.state)) {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; dependencies can only change on draft or ready tasks`);
    }
    if (taskId === dependsOnId || (await this.reaches(dependsOnId, taskId))) {
      throw new DomainError('conflict', `dependency ${taskId} → ${dependsOnId} would create a cycle`);
    }
    await this.db.write((db) =>
      db.insert(taskDependencies).values({ taskId, dependsOnId }).onConflictDoNothing().run(),
    );
    await this.rederiveBlocked(taskId);
    return this.options.withDeps(await this.options.get(taskId));
  }

  async removeDependency(taskId: number, dependsOnId: number): Promise<TaskWithBlockers> {
    this.options.assertOperatorEditable(await this.options.get(taskId));
    await this.db.write((db) =>
      db
        .delete(taskDependencies)
        .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, dependsOnId)))
        .run(),
    );
    await this.rederiveBlocked(taskId);
    return this.options.withDeps(await this.options.get(taskId));
  }

  async cancelWithDependents(id: number): Promise<number[]> {
    const toCancel = [id];
    const seen = new Set(toCancel);
    for (let index = 0; index < toCancel.length; index++) {
      for (const dependentId of await this.dependents(toCancel[index]!)) {
        if (!seen.has(dependentId)) {
          seen.add(dependentId);
          toCancel.push(dependentId);
        }
      }
    }
    const cancelled: number[] = [];
    for (const taskId of toCancel) {
      const task = await this.options.get(taskId);
      if (taskId === id || this.options.cancellableStates.includes(task.state)) {
        await this.options.cancel(taskId);
        cancelled.push(taskId);
      }
    }
    return cancelled;
  }

  async emitDependents(taskId: number): Promise<void> {
    for (const dependentId of await this.dependents(taskId)) {
      this.options.onChanged(await this.options.get(dependentId));
    }
  }

  async rederiveBlockers(taskIds: readonly number[]): Promise<void> {
    for (const taskId of taskIds) await this.rederiveBlocked(taskId);
  }

  async reaches(from: number, to: number): Promise<boolean> {
    const queue = [from];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === to) return true;
      for (const next of await this.dependsOn(current)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }

  async rederiveBlocked(taskId: number): Promise<void> {
    this.options.onChanged(await this.options.get(taskId));
  }
}
