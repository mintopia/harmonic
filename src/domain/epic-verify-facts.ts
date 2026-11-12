import type { WorkflowStepRunRow } from '../db/schema.js';
import { parseWorkflow, type WorkflowStepDefinition } from './workflow.js';

export type EpicVerifyStatus = 'pass' | 'fail' | 'pending' | null;

export interface EpicVerifyFacts {
  configured: boolean;
  status: EpicVerifyStatus;
  labels: string[];
}

const flatten = (steps: readonly WorkflowStepDefinition[]): WorkflowStepDefinition[] => steps.flatMap((step) => (step.parallel ? flatten(step.parallel) : [step]));

const isCheck = (step: WorkflowStepDefinition): boolean => step.run !== undefined || step.uses === 'command';

const labelOf = (step: WorkflowStepDefinition): string => {
  if (step.uses === 'critic') return `Critic: ${step.id}`;
  const line = (step.run ?? (typeof step.with?.run === 'string' ? step.with.run : '')).trim().split('\n')[0] ?? '';
  return line === '' ? step.id : line;
};

/** The check and critic steps in the workflow's `attempts:` block, with the verdict their latest step runs give. */
export function epicVerifyFacts(workflowText: string, latestByStep: ReadonlyMap<string, WorkflowStepRunRow>): EpicVerifyFacts {
  const { steps, attempts } = parseWorkflow(workflowText, { lenient: true });
  const verifiers = flatten(steps.slice(attempts.start, attempts.end)).filter((step) => isCheck(step) || step.uses === 'critic');
  const runs = verifiers.flatMap((step) => latestByStep.get(step.id) ?? []);
  const bad = runs.some((run) => run.outcome === 'fail' || run.outcome === 'inconclusive' || run.outcome === 'conflict');
  const running = runs.some((run) => run.outcome === null);
  const settled = runs.length === verifiers.length && runs.every((run) => run.outcome === 'pass' || run.outcome === 'skipped');
  let status: EpicVerifyStatus = null;
  if (bad) status = 'fail';
  else if (running) status = 'pending';
  else if (verifiers.length > 0 && settled) status = 'pass';
  return { configured: verifiers.length > 0, status, labels: verifiers.map(labelOf) };
}
