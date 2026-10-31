import type { StepCheckpoint, TaskExecution, WorkflowStepRun } from './types';

export type PodTone = 'working' | 'off' | 'lost';

export interface PodStateView {
  label: string;
  tone: PodTone;
}

const POD_STATES: Record<TaskExecution['podState'], PodStateView> = {
  pending: { label: 'Pending', tone: 'working' },
  running: { label: 'Running', tone: 'working' },
  deleted: { label: 'Pod deleted', tone: 'off' },
  lost: { label: 'Lost', tone: 'lost' },
};

export const podStateView = (state: TaskExecution['podState']): PodStateView => POD_STATES[state];

export const DELETED_POD_CAPTION =
  'The pod and its per-pod Secret are gone. Transcripts were copied out before deletion; Cost and the Archive are unchanged. No Service or port was ever exposed.';

export const targetSourceLabel = (source: TaskExecution['source']): string => (source === 'workflow' ? 'from workflow ' : 'from step ');

export type StepTarget = { kind: 'local' } | { kind: 'k8s'; name: string };

export function stepTarget(step: Pick<WorkflowStepRun, 'outputs'>, execution: Pick<TaskExecution, 'target'> | null | undefined): StepTarget | null {
  if (!execution) return null;
  return step.outputs.checkpoint ? { kind: 'k8s', name: execution.target } : { kind: 'local' };
}

export interface CheckpointView {
  branch: string;
  sha: string | null;
  forced: boolean;
  noChanges: boolean;
}

export function checkpointView(step: Pick<WorkflowStepRun, 'outputs'>): CheckpointView | null {
  const checkpoint: StepCheckpoint | undefined = step.outputs.checkpoint;
  if (!checkpoint) return null;
  return {
    branch: checkpoint.branch,
    sha: checkpoint.sha === null ? null : checkpoint.sha.slice(0, 7),
    forced: checkpoint.forced,
    noChanges: !checkpoint.forced && checkpoint.unchanged === true,
  };
}
