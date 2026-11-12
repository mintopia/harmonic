// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { Task, TaskState, WorkflowStepRun } from './types.js';

/**
 * The operator actions the TaskDetail footer and TaskCard offer in a given
 * state. Order is display order (left to right).
 */
export type TaskAction =
  | 'accept'
  | 'retry'
  | 'close'
  | 'run'
  | 'ready'
  | 'edit'
  | 'complete'
  | 'pause'
  | 'extend'
  | 'resume'
  | 'cancel'
  | 'uncancel'
  | 'delete';

/** `hasCandidate` gates Accept: the server refuses it (409) with no commits ahead of base, so it is not offered. */
export function taskActions(state: TaskState, wallClockDeadline: number | null = null, hasCandidate = true): TaskAction[] {
  switch (state) {
    case 'escalated':
      return hasCandidate ? ['delete', 'close', 'retry', 'accept'] : ['delete', 'close', 'retry'];
    case 'ready':
      return ['delete', 'run', 'edit', 'cancel'];
    case 'draft':
      return ['delete', 'ready', 'edit', 'cancel'];
    case 'working':
      return wallClockDeadline != null ? ['pause', 'extend', 'complete', 'cancel'] : ['pause', 'complete', 'cancel'];
    case 'paused':
      return ['delete', 'resume', 'cancel'];
    case 'cancelled':
      return ['delete', 'uncancel'];
    case 'done':
      return ['delete'];
  }
  return [];
}

export interface WorkflowEscalationNotes {
  heading: string;
  accept: string;
  retry: string;
  close: string;
}

type StepFacts = Pick<WorkflowStepRun, 'stepId' | 'action' | 'outcome' | 'attempt'>;
type WorkflowFacts = { steps: readonly StepFacts[]; outline: readonly { id: string; children: readonly string[] }[]; cleanupCount: number };

const FAILED: ReadonlySet<string> = new Set(['fail', 'inconclusive', 'conflict']);

function latestSteps(steps: readonly StepFacts[]): Map<string, StepFacts> {
  const latest = new Map<string, StepFacts>();
  for (const step of steps) latest.set(step.stepId, step);
  return latest;
}

const outlineIndex = (outline: WorkflowFacts['outline'], stepId: string): number => outline.findIndex((entry) => entry.id === stepId || entry.children.includes(stepId));

export function workflowEscalationNotes(workflow: WorkflowFacts): WorkflowEscalationNotes | null {
  const failed = [...latestSteps(workflow.steps).values()].filter((step) => step.outcome !== null && FAILED.has(step.outcome)).at(-1);
  if (!failed) return null;
  const next = workflow.outline[outlineIndex(workflow.outline, failed.stepId) + 1];
  const where = next ? `continues with ${next.id}` : 'continues to Merge';
  const cleanup = `${workflow.cleanupCount} ${workflow.cleanupCount === 1 ? 'step' : 'steps'}`;
  return {
    heading: `Escalated at step ${failed.stepId}`,
    accept: `marks step ${failed.stepId} (${failed.action}) as pass and ${where}. No re-verify; a candidate commit is required. At the last step, Accept continues to Merge.`,
    retry: 'starts a new pass of attempts: with the counter reset.',
    close: `runs the cleanup: list (${cleanup}), then removes the worktree and branch.`,
  };
}

export function nextUnexecutedStep(workflow: Pick<WorkflowFacts, 'steps' | 'outline'>): string | null {
  const latest = latestSteps(workflow.steps);
  const done = (id: string): boolean => latest.get(id)?.outcome === 'pass' || latest.get(id)?.outcome === 'skipped';
  return workflow.outline.find((entry) => !(entry.children.length > 0 ? entry.children.every(done) : done(entry.id)))?.id ?? null;
}

export function acceptPresentation(notes: WorkflowEscalationNotes | null) {
  return notes ? { label: 'Accept', description: notes.accept } : { label: 'Accept', description: 'Override the failed step and continue the workflow; accepting the last step merges the candidate.' };
}

export function acceptedOutcome(task: Pick<Task, 'state' | 'mergeStatus' | 'currentStep'>): string {
  if (task.state === 'done') return 'completed';
  if (task.mergeStatus === 'merging') return 'merging';
  if (task.state === 'escalated') return 'needs your attention';
  if (task.currentStep) return `continuing with ${task.currentStep.stepId}`;
  return task.state === 'working' ? 'continuing the pipeline' : task.state;
}
