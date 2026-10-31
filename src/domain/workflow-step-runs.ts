import { asc, eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { workflowStepRuns, type WorkflowStepOutcome, type WorkflowStepRunRow } from '../db/schema.js';

export interface WorkflowStepOutputs {
  stdout: string;
  exitCode: number | null;
}

export interface WorkflowStepRunStart {
  taskId: number;
  workflowRef: string;
  stepId: string;
  position: number;
  action: string;
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

  /** Step ids whose latest run under `workflowRef` finished with `pass`; a run left `running` counts as unexecuted. */
  async passedStepIds(taskId: number, workflowRef: string): Promise<Set<string>> {
    const latest = new Map<string, WorkflowStepRunRow>();
    for (const row of await this.listForTask(taskId)) if (row.workflowRef === workflowRef) latest.set(row.stepId, row);
    return new Set([...latest.values()].filter((row) => row.outcome === 'pass').map((row) => row.stepId));
  }
}
