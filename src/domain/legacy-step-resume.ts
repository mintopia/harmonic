import type { StepState, StepType, WorkflowStepOutcome } from '../db/schema.js';
import type { WorkflowDefinition, WorkflowStepDefinition } from './workflow.js';

export interface LegacyStepRow {
  type: StepType;
  state: StepState;
}

/** A workflow step run to insert for a Ticket that began before it ran through a workflow. */
export interface LegacySeedRow {
  stepId: string;
  position: number;
  action: string;
  attempt: number | null;
  outcome: WorkflowStepOutcome;
  summary: string;
}

interface Unit {
  leaves: readonly WorkflowStepDefinition[];
  position: number;
  inBlock: boolean;
  ordinal: number;
}

const LEGACY_ORDINAL: Record<StepType, number> = { rebase: 0, implementation: 1, verification: 2, review: 3 };

const actionOf = (step: WorkflowStepDefinition): string => (step.run !== undefined ? 'run' : (step.uses ?? 'run'));

function leafOrdinal(step: WorkflowStepDefinition): number {
  const action = actionOf(step);
  if (action === 'rebase') return 0;
  if (action === 'agent') return 1;
  if (action === 'run' || action === 'command' || action === 'verify') return 2;
  if (action === 'critic') return 3;
  return 4;
}

function unitOrdinal(leaves: readonly WorkflowStepDefinition[]): number {
  return leaves.some((leaf) => actionOf(leaf) === 'critic') ? 3 : Math.min(...leaves.map(leafOrdinal));
}

function unitsOf(workflow: WorkflowDefinition): Unit[] {
  const { start, end } = workflow.attempts;
  return workflow.steps.map((step, index) => {
    const leaves = step.parallel ?? [step];
    return { leaves, position: index, inBlock: index >= start && index < end, ordinal: unitOrdinal(leaves) };
  });
}

/**
 * The step runs that put a legacy-pipeline Ticket at the point its pre-workflow Attempt reached.
 * `attemptNumber` is the Attempt's number within its escalation budget. An escalated Ticket also gets its
 * target step seeded `fail`, so an operator Accept flips it; an escalation with no legacy steps seeds everything before `merge`.
 */
export function planLegacyResume(
  workflow: WorkflowDefinition,
  legacySteps: readonly LegacyStepRow[],
  attemptNumber: number,
  max: number,
  escalated = false,
): LegacySeedRow[] {
  const units = unitsOf(workflow);
  const last = legacySteps.at(-1);
  let target: number;
  if (last === undefined) {
    if (!escalated) return [];
    target = units.findIndex((unit) => unit.leaves.some((leaf) => leaf.uses === 'merge'));
  } else {
    const ordinal = LEGACY_ORDINAL[last.type];
    const done = last.state === 'passed' || last.state === 'skipped';
    target = units.findIndex((unit) => (done ? unit.ordinal > ordinal : unit.ordinal >= ordinal));
  }
  const stop = target < 0 ? units.length : target;
  const attempt = Math.min(Math.max(attemptNumber, 1), max);
  const rows: LegacySeedRow[] = [];
  const seed = (unit: Unit, outcome: WorkflowStepOutcome, suffix: string): void => {
    for (const leaf of unit.leaves) {
      rows.push({
        stepId: leaf.id,
        position: unit.position,
        action: actionOf(leaf),
        attempt: unit.inBlock ? attempt : null,
        outcome,
        summary: `carried over from pre-workflow Attempt ${attemptNumber} (${actionOf(leaf)})${suffix}`,
      });
    }
  };
  for (const unit of units.slice(0, stop)) seed(unit, 'pass', '');
  if (escalated && last !== undefined && target >= 0) seed(units[target]!, 'fail', ': it had not passed when the Ticket escalated');
  return rows;
}
