// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { Task, TaskState, StepType, WorkflowStepRun } from './types.js';

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

export function taskActions(state: TaskState, wallClockDeadline: number | null = null): TaskAction[] {
  switch (state) {
    case 'escalated':
      return ['delete', 'close', 'retry', 'accept'];
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

export interface EscalationActions {
  /** Accept merges the branch's candidate, so it needs one (commits ahead of base). */
  accept: boolean;
  retry: boolean;
  close: boolean;
}

/** Which of the three escalation actions an escalated ticket can take right now; null off the surface. */
export function escalationActions(task: Pick<Task, 'hasCandidate' | 'state'>): EscalationActions | null {
  if (task.state !== 'escalated') return null;
  return { accept: task.hasCandidate, retry: true, close: true };
}

export interface WorkflowEscalationNotes {
  heading: string;
  accept: string;
  retry: string;
  close: string;
}

/** What each escalation action does to a workflow-run Ticket's failed step (ADR-0053); null when no step has failed. */
export function workflowEscalationNotes(steps: readonly Pick<WorkflowStepRun, 'stepId' | 'action' | 'outcome' | 'attempt'>[]): WorkflowEscalationNotes | null {
  const latest = new Map<string, Pick<WorkflowStepRun, 'stepId' | 'action' | 'outcome' | 'attempt'>>();
  for (const step of steps) latest.set(step.stepId, step);
  const failed = [...latest.values()].filter((step) => step.outcome === 'fail' || step.outcome === 'inconclusive' || step.outcome === 'conflict').at(-1);
  if (!failed) return null;
  const name = `${failed.stepId} (${failed.action})`;
  return {
    heading: `Escalated at step ${failed.stepId}`,
    accept: `Marks step ${name} as pass and continues with the next step. No re-verify; a candidate commit is required. At the last step, Accept continues to Merge.`,
    retry: 'Starts a new pass of the attempts: block with the counter reset and re-resolves the Workflow Label.',
    close: 'Runs the cleanup: list, then removes the worktree and branch.',
  };
}

export function acceptPresentation(failedStep: StepType | null) {
  switch (failedStep) {
    case 'rebase':
      return { label: 'Accept & implement', description: 'Override the failed rebase step and continue with implementation.' };
    case 'implementation':
      return { label: 'Accept & verify', description: 'Override the failed implementation step and continue with verification.' };
    case 'verification':
      return { label: 'Accept & review', description: 'Override the failed verification step and continue with review.' };
    case 'review':
      return { label: 'Accept & merge', description: 'Override the failed review step and merge the candidate.' };
    case null:
      return { label: 'Accept', description: 'Override the failed step and continue the pipeline; accepting the final review merges the candidate.' };
  }
}

export function acceptedOutcome(task: Pick<Task, 'state' | 'mergeStatus' | 'currentStep'>): string {
  if (task.state === 'done') return 'completed';
  if (task.mergeStatus === 'merging') return 'merging';
  if (task.state === 'escalated') return 'needs your attention';
  if (task.currentStep) return `continuing with ${task.currentStep}`;
  return task.state === 'working' ? 'continuing the pipeline' : task.state;
}
