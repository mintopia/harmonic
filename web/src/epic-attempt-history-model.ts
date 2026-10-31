import type { EpicAttempt, WorkflowStepRun } from './types';

export function preCutoverAttempts(attempts: EpicAttempt[], steps: WorkflowStepRun[], workflowRef: string | null): EpicAttempt[] {
  const firstStep = steps.reduce<number | null>((min, step) => (step.startedAt === null || (min !== null && min <= step.startedAt) ? min : step.startedAt), null);
  const ordered = [...attempts].sort((a, b) => a.number - b.number);
  if (firstStep === null) {
    const last = ordered.at(-1);
    return workflowRef !== null && last?.state === 'running' ? ordered.slice(0, -1) : ordered;
  }
  const firstEngine = ordered.findLast((attempt) => attempt.startedAt <= firstStep);
  return firstEngine === undefined ? [] : ordered.filter((attempt) => attempt.number < firstEngine.number);
}
