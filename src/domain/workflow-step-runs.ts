import { asc, eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { workflowStepRuns, type WorkflowStepOutcome, type WorkflowStepRunRow } from '../db/schema.js';

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
}

export interface WorkflowStepRunStart {
  taskId: number;
  workflowRef: string;
  stepId: string;
  position: number;
  action: string;
  attempt?: number | null;
}

export interface WorkflowStepRunFinish {
  outcome: WorkflowStepOutcome;
  outputs: WorkflowStepOutputs;
  summary: string;
}

export class WorkflowStepRunStore {
  constructor(private readonly db: AsyncDbHandle) {}

  start(input: WorkflowStepRunStart, now: number = Date.now()): Promise<WorkflowStepRunRow> {
    return this.db.write((db) => db.insert(workflowStepRuns).values({ ...input, startedAt: now }).returning().get());
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

  listForTask(taskId: number): Promise<WorkflowStepRunRow[]> {
    return this.db.read((db) => db.select().from(workflowStepRuns).where(eq(workflowStepRuns.taskId, taskId)).orderBy(asc(workflowStepRuns.id)).all());
  }

  /** Overrides each step's latest failed run to `pass` (the operator's Accept); returns how many it changed. */
  async acceptFailed(taskId: number, workflowRef: string): Promise<number> {
    const failed = [...(await this.latestByStep(taskId, workflowRef)).values()].filter((row) => row.outcome === 'fail' || row.outcome === 'inconclusive' || row.outcome === 'conflict');
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
  async latestByStep(taskId: number, workflowRef: string): Promise<Map<string, WorkflowStepRunRow>> {
    const latest = new Map<string, WorkflowStepRunRow>();
    for (const row of await this.listForTask(taskId)) if (row.workflowRef === workflowRef) latest.set(row.stepId, row);
    return latest;
  }
}
