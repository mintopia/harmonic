import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { workflowStepRuns, type WorkflowStepOutcome, type WorkflowStepRunRow } from '../db/schema.js';
import type { TrackerRef } from '../tracker/adapter.js';

/** Who a step run belongs to: a Task, or a stored Epic identified by workspace and tracker refs. */
export type StepRunOwner = { taskId: number } | { workspaceId: number; epicRef: TrackerRef };

export function stepRunOwnerKey(owner: StepRunOwner): string {
  return 'taskId' in owner ? `task:${owner.taskId}` : `epic:${owner.workspaceId}:${owner.epicRef}`;
}

function ownerColumns(owner: StepRunOwner): { taskId: number | null; workspaceId: number | null; epicRef: TrackerRef | null } {
  return 'taskId' in owner ? { taskId: owner.taskId, workspaceId: null, epicRef: null } : { taskId: null, workspaceId: owner.workspaceId, epicRef: owner.epicRef };
}

function ownerWhere(owner: StepRunOwner) {
  return 'taskId' in owner ? eq(workflowStepRuns.taskId, owner.taskId) : and(eq(workflowStepRuns.workspaceId, owner.workspaceId), eq(workflowStepRuns.epicRef, owner.epicRef));
}

export interface WorkflowStepOutputs {
  stdout: string;
  exitCode: number | null;
  baseSha?: string;
  conflictedFiles?: string[];
  url?: string;
  number?: number;
  branch?: string;
  verdict?: 'pass' | 'fail' | 'inconclusive';
  reason?: string;
  findings?: string[];
  checkpoint?: { branch: string; sha: string | null; forced: boolean; unchanged: boolean; files?: number; error?: string };
}

export type WorkflowStepRunStart = StepRunOwner & {
  workflowRef: string;
  stepId: string;
  position: number;
  action: string;
  attempt?: number | null;
  attemptId?: number | null;
};

export interface WorkflowStepRunFinish {
  outcome: WorkflowStepOutcome;
  outputs: WorkflowStepOutputs;
  summary: string;
}

export type WorkflowStepRunSeed = StepRunOwner & {
  workflowRef: string;
  stepId: string;
  position: number;
  action: string;
  attempt: number | null;
  outcome: WorkflowStepOutcome;
  summary: string;
};

export class WorkflowStepRunStore {
  constructor(private readonly db: AsyncDbHandle) {}

  start(input: WorkflowStepRunStart, now: number = Date.now()): Promise<WorkflowStepRunRow> {
    const { workflowRef, stepId, position, action, attempt, attemptId } = input;
    return this.db.write((db) => db.insert(workflowStepRuns).values({ ...ownerColumns(input), workflowRef, stepId, position, action, attempt, attemptId: attemptId ?? null, startedAt: now }).returning().get());
  }

  async setSession(id: number, input: { sessionRowId?: number; harness?: string; model?: string }): Promise<void> {
    const { sessionRowId, harness, model } = input;
    const set = { ...(sessionRowId !== undefined ? { sessionRowId } : {}), ...(harness !== undefined ? { harness } : {}), ...(model !== undefined ? { model } : {}) };
    if (Object.keys(set).length === 0) return;
    await this.db.write((db) => db.update(workflowStepRuns).set(set).where(eq(workflowStepRuns.id, id)).run());
  }

  async setUsage(id: number, usage: unknown): Promise<void> {
    await this.db.write((db) => db.update(workflowStepRuns).set({ usage: JSON.stringify(usage) }).where(eq(workflowStepRuns.id, id)).run());
  }

  listForAttempt(attemptId: number): Promise<WorkflowStepRunRow[]> {
    return this.db.read((db) => db.select().from(workflowStepRuns).where(eq(workflowStepRuns.attemptId, attemptId)).orderBy(asc(workflowStepRuns.id)).all());
  }

  /** The latest still-running step run (null outcome) of each Attempt, keyed by attempt id. */
  async runningForAttempts(attemptIds: readonly number[]): Promise<Map<number, WorkflowStepRunRow>> {
    const latest = new Map<number, WorkflowStepRunRow>();
    if (attemptIds.length === 0) return latest;
    const rows = await this.db.read((db) =>
      db.select().from(workflowStepRuns).where(and(inArray(workflowStepRuns.attemptId, [...attemptIds]), isNull(workflowStepRuns.outcome))).orderBy(desc(workflowStepRuns.id)).all(),
    );
    for (const row of rows) if (row.attemptId !== null && !latest.has(row.attemptId)) latest.set(row.attemptId, row);
    return latest;
  }

  async closeOrphans(now: number = Date.now()): Promise<number> {
    const closed = await this.db.write((db) =>
      db
        .update(workflowStepRuns)
        .set({ outcome: 'inconclusive', summary: 'interrupted by process death', endedAt: now })
        .where(isNull(workflowStepRuns.outcome))
        .returning({ id: workflowStepRuns.id })
        .all(),
    );
    return closed.length;
  }

  async seed(rows: readonly WorkflowStepRunSeed[], now: number = Date.now()): Promise<void> {
    if (rows.length === 0) return;
    const outputs = JSON.stringify({ stdout: '', exitCode: null } satisfies WorkflowStepOutputs);
    await this.db.write(async (db) => {
      for (const row of rows) {
        const { workflowRef, stepId, position, action, attempt, outcome, summary } = row;
        await db.insert(workflowStepRuns).values({ ...ownerColumns(row), workflowRef, stepId, position, action, attempt, outcome, summary, outputs, startedAt: now, endedAt: now }).run();
      }
    });
  }

  async finish(id: number, result: WorkflowStepRunFinish, now: number = Date.now()): Promise<void> {
    await this.db.write((db) =>
      db
        .update(workflowStepRuns)
        .set({ outcome: result.outcome, outputs: JSON.stringify(result.outputs), summary: result.summary, endedAt: now })
        .where(eq(workflowStepRuns.id, id))
        .run(),
    );
  }

  async setResolvedPrompt(id: number, prompt: string): Promise<void> {
    await this.db.write((db) => db.update(workflowStepRuns).set({ resolvedPrompt: prompt }).where(eq(workflowStepRuns.id, id)).run());
  }

  listForOwner(owner: StepRunOwner): Promise<WorkflowStepRunRow[]> {
    return this.db.read((db) => db.select().from(workflowStepRuns).where(ownerWhere(owner)).orderBy(asc(workflowStepRuns.id)).all());
  }

  listForTask(taskId: number): Promise<WorkflowStepRunRow[]> {
    return this.listForOwner({ taskId });
  }

  async acceptFailed(owner: StepRunOwner, workflowRef: string): Promise<number> {
    const failed = [...(await this.latestByStep(owner, workflowRef)).values()].filter((row) => row.outcome === 'fail' || row.outcome === 'inconclusive' || row.outcome === 'conflict');
    await this.db.write(async (db) => {
      for (const row of failed) {
        await db
          .update(workflowStepRuns)
          .set({ outcome: 'pass', summary: `accepted by the operator (was ${row.outcome}): ${row.summary ?? ''}`.trimEnd() })
          .where(eq(workflowStepRuns.id, row.id))
          .run();
      }
    });
    return failed.length;
  }

  /** The latest run of each step under `workflowRef`, by step id; a run left `running` has a null outcome. */
  async latestByStep(owner: StepRunOwner, workflowRef: string): Promise<Map<string, WorkflowStepRunRow>> {
    const latest = new Map<string, WorkflowStepRunRow>();
    for (const row of await this.listForOwner(owner)) if (row.workflowRef === workflowRef) latest.set(row.stepId, row);
    return latest;
  }
}
