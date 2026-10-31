import type { AttemptRow, TaskRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import { planLegacyResume } from '../domain/legacy-step-resume.js';
import { parseWorkflow, resolveAttemptsMax } from '../domain/workflow.js';
import { snapshotVars } from '../domain/workflow-vars.js';
import type { WorkflowEntry } from '../domain/workflow-library-store.js';
import type { WorkflowStepRunStore } from '../domain/workflow-step-runs.js';
import { parseWorkflowRef } from './workflow-engine.js';

export interface LegacyResumeDeps {
  library: { getVersion(name: string, version: number): Promise<WorkflowEntry> };
  stepRuns: WorkflowStepRunStore;
  attempts: Pick<AttemptStore, 'listSteps' | 'budgetBase'>;
}

/** Puts a pre-workflow Ticket's workflow at the step its last Attempt reached; a no-op once the workflow has step runs. */
export async function seedLegacyResume(deps: LegacyResumeDeps, task: TaskRow, run: AttemptRow, escalated: boolean): Promise<void> {
  const ref = task.workflowRef;
  if (ref === null || (await deps.stepRuns.latestByStep(task.id, ref)).size > 0) return;
  const { name, version } = parseWorkflowRef(ref);
  const workflow = parseWorkflow((await deps.library.getVersion(name, version)).text, { lenient: true });
  const max = resolveAttemptsMax(workflow.attempts.max, snapshotVars(task.workflowVars, workflow.vars));
  const legacy = await deps.attempts.listSteps(run.id);
  const attemptNumber = run.number - (await deps.attempts.budgetBase(task.id));
  const rows = planLegacyResume(workflow, legacy, attemptNumber, max.ok ? max.value : 1, escalated);
  await deps.stepRuns.seed(rows.map((row) => ({ ...row, taskId: task.id, workflowRef: ref })));
}
