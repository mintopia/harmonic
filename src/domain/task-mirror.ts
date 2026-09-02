import { and, eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { taskDependencies, tasks, type RawTaskRow, type TaskRow, type TaskState, type TrackerFacts, type WayfinderType, type Workflow, type WorkspaceRow } from '../db/schema.js';
import { decideTaskDeletion, type DeletionDecision } from './task-deletion.js';
import type { TaskBlockerGraph } from './task-blocker-graph.js';

export interface MirrorInput {
  trackerRef: number;
  prompt: string;
  workflow: Workflow;
  wayfinderType: WayfinderType | null;
  mapRef: number | null;
  closed: boolean;
  trackerCanClose?: boolean;
  facts?: TrackerFacts;
}

export interface TaskMirrorOptions {
  resolveWorkspace: (workspaceId?: number) => Promise<WorkspaceRow>;
  changed: (task: RawTaskRow) => Promise<TaskRow>;
  get: (id: number) => Promise<TaskRow>;
  clearDismissal: (workspaceId: number, trackerRef: number) => Promise<void>;
  removeTaskCascade: (id: number, tombstone: DeletionDecision['tombstone']) => Promise<void>;
  blockerGraph: TaskBlockerGraph;
}

function trackerFactColumns(facts: TrackerFacts) {
  return {
    trackerState: facts.state,
    trackerParent: facts.parent,
    trackerBlockedBy: facts.blockedBy,
    trackerLabels: facts.labels,
    trackerTitle: facts.title,
    trackerBody: facts.body,
    trackerUrl: facts.url,
    trackerCreatedAt: facts.createdAt,
  };
}

export class TaskMirror {
  constructor(
    private readonly db: AsyncDbHandle,
    private readonly options: TaskMirrorOptions,
  ) {}

  async upsertMirrored(input: MirrorInput, workspaceId?: number): Promise<TaskRow> {
    const workspace = await this.options.resolveWorkspace(workspaceId);
    const { row, dirty } = await this.db.write(async (db) => {
      const existing = await db.select().from(tasks).where(and(eq(tasks.workspaceId, workspace.id), eq(tasks.trackerRef, input.trackerRef))).get();
      const now = Date.now();
      if (existing) {
        const state: TaskState = existing.state === 'working' || existing.state === 'escalated'
          ? existing.state
          : input.closed
            ? 'done'
            : existing.state === 'done' && input.trackerCanClose !== false
              ? 'ready'
              : existing.state;
        const factCols = input.facts ? trackerFactColumns(input.facts) : {};
        const factUnchanged = ([column, value]: [string, unknown]) => {
          const current = existing[column as keyof typeof existing];
          return typeof value === 'object' && value !== null ? JSON.stringify(current) === JSON.stringify(value) : current === value;
        };
        const unchanged = existing.state === state && existing.prompt === input.prompt && existing.workflow === input.workflow && existing.wayfinderType === input.wayfinderType && existing.mapRef === input.mapRef && Object.entries(factCols).every(factUnchanged);
        if (unchanged) return { row: existing, dirty: false };
        const updated = await db.update(tasks).set({ prompt: input.prompt, state, workflow: input.workflow, wayfinderType: input.wayfinderType, mapRef: input.mapRef, ...factCols, updatedAt: now }).where(eq(tasks.id, existing.id)).returning().get();
        return { row: updated, dirty: true };
      }
      const inserted = await db.insert(tasks).values({
        prompt: input.prompt, workspaceId: workspace.id, harness: null, model: null, isolationMode: null, priority: null, conflictResolveTurns: null, workingDir: workspace.workingDir,
        state: input.closed ? 'done' : 'ready', origin: 'mirrored', trackerRef: input.trackerRef, workflow: input.workflow, wayfinderType: input.wayfinderType, mapRef: input.mapRef,
        ...(input.facts ? trackerFactColumns(input.facts) : {}), createdAt: now, updatedAt: now,
      }).returning().get();
      return { row: inserted, dirty: true };
    });
    return dirty ? this.options.changed(row) : this.options.get(row.id);
  }

  async claimMirroredAutoRun(id: number): Promise<TaskRow | undefined> {
    const row = await this.db.write((db) => db.update(tasks).set({ state: 'working', updatedAt: Date.now() }).where(and(eq(tasks.id, id), eq(tasks.state, 'ready'), eq(tasks.origin, 'mirrored'))).returning().get());
    return row ? this.options.changed(row) : undefined;
  }

  async reconcileMirroredDeps(taskId: number, dependsOnIds: number[]): Promise<void> {
    const desired = new Set(dependsOnIds.filter((id) => id !== taskId));
    const current = new Set(await this.options.blockerGraph.dependsOn(taskId));
    const toAdd = [...desired].filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !desired.has(id));
    if (toAdd.length === 0 && toRemove.length === 0) return;
    await this.db.write(async (db) => {
      for (const id of toAdd) await db.insert(taskDependencies).values({ taskId, dependsOnId: id }).onConflictDoNothing().run();
      for (const id of toRemove) await db.delete(taskDependencies).where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, id))).run();
    });
    await this.options.blockerGraph.rederiveBlocked(taskId);
  }

  async demoteMirroredToContainer(workspaceId: number, trackerRef: number): Promise<void> {
    await this.options.clearDismissal(workspaceId, trackerRef);
    const row = await this.db.read((db) => db.select({ id: tasks.id, state: tasks.state, origin: tasks.origin, trackerRef: tasks.trackerRef, workspaceId: tasks.workspaceId }).from(tasks).where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.trackerRef, trackerRef))).get());
    if (!row || !decideTaskDeletion(row).ok) return;
    await this.options.removeTaskCascade(row.id, null);
  }
}
