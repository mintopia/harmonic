// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { Task, TaskState, StepType } from './types.js';

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
