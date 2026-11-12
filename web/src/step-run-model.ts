// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { AttemptLogEvent, StepRun, WorkflowStepsResponse } from './types.js';

export type IconKind = 'pass' | 'fail' | 'running' | 'pending' | 'skipped' | 'interrupted';
export type PassTone = 'pass' | 'fail' | 'running';

export function iconKind(run: Pick<StepRun, 'state'>): IconKind {
  switch (run.state) {
    case 'pass':
      return 'pass';
    case 'running':
      return 'running';
    case 'interrupted':
      return 'interrupted';
    case 'skipped':
      return 'skipped';
    default:
      return 'fail';
  }
}

export const isFailed = (run: Pick<StepRun, 'state'>): boolean => iconKind(run) === 'fail';

export function passNumbers(runs: readonly StepRun[]): number[] {
  return [...new Set(runs.flatMap((run) => (run.pass === null ? [] : [run.pass])))].sort((a, b) => a - b);
}

export function passTone(runs: readonly StepRun[], pass: number): PassTone {
  const inPass = runs.filter((run) => run.pass === pass);
  if (inPass.some((run) => run.state === 'running')) return 'running';
  return inPass.some(isFailed) ? 'fail' : 'pass';
}

export interface StepRowModel {
  key: string;
  stepId: string;
  run: StepRun | null;
  /** The parallel group this step belongs to, when the outline says so. */
  group: string | null;
}

export interface AttemptRowsInput {
  stepRuns: readonly StepRun[];
  pass: number | null;
  workflow: Pick<WorkflowStepsResponse, 'outline' | 'cleanupIds'> | null;
  showPending: boolean;
}

const groupOf = (workflow: AttemptRowsInput['workflow']): Map<string, string> =>
  new Map((workflow?.outline ?? []).flatMap((entry) => entry.children.map((child) => [child, entry.id] as const)));

/** Outline steps as plain step ids: a parallel group is its children. */
export function outlineStepIds(workflow: Pick<WorkflowStepsResponse, 'outline' | 'cleanupIds'> | null): string[] {
  const cleanup = new Set(workflow?.cleanupIds ?? []);
  return (workflow?.outline ?? []).flatMap((entry) => (entry.children.length > 0 ? entry.children : [entry.id])).filter((id) => !cleanup.has(id));
}

/**
 * The step list of one Attempt: the selected Pass's step runs plus the runs
 * outside the `attempts:` block, in execution order, then outline steps that
 * have not run yet. `verify` markers show only when they failed.
 */
export function attemptRows({ stepRuns, pass, workflow, showPending }: AttemptRowsInput): StepRowModel[] {
  const groups = groupOf(workflow);
  const shown = stepRuns.filter((run) => (run.pass === null || run.pass === pass) && (run.kind !== 'marker' || isFailed(run)));
  const rows: StepRowModel[] = shown.map((run) => ({ key: `run:${run.id}`, stepId: run.stepId, run, group: groups.get(run.stepId) ?? null }));
  if (!showPending) return rows;
  const ran = new Set(stepRuns.filter((run) => run.pass === null || run.pass === pass).map((run) => run.stepId));
  const pending = outlineStepIds(workflow).filter((id) => !ran.has(id));
  return [...rows, ...pending.map((id) => ({ key: `pending:${id}`, stepId: id, run: null, group: groups.get(id) ?? null }))];
}

/** The Ticket's workflow before any Attempt: every step pending. */
export const outlineRows = (workflow: Pick<WorkflowStepsResponse, 'outline' | 'cleanupIds'> | null): StepRowModel[] => {
  const groups = groupOf(workflow);
  return outlineStepIds(workflow).map((id) => ({ key: `pending:${id}`, stepId: id, run: null, group: groups.get(id) ?? null }));
};

/** Default-open row: the running one, else the failed one, else the last agent row. */
export function defaultOpenKey(rows: readonly StepRowModel[]): string | null {
  const runs = rows.filter((row) => row.run !== null);
  const pick = runs.find((row) => row.run!.state === 'running') ?? runs.find((row) => isFailed(row.run!)) ?? runs.filter((row) => row.run!.kind === 'agent').at(-1);
  return pick?.key ?? null;
}

/** The Attempt stream's events for one step run: tagged by `stepRunId`, else (untagged) by the run's time window. */
export function eventsForStepRun(events: readonly AttemptLogEvent[], run: Pick<StepRun, 'id' | 'startedAt' | 'endedAt'>): AttemptLogEvent[] {
  return events.filter((event) =>
    event.stepRunId !== undefined ? event.stepRunId === run.id : event.ts >= run.startedAt && (run.endedAt === null || event.ts <= run.endedAt),
  );
}

export const stepRunElapsedMs = (run: Pick<StepRun, 'startedAt' | 'endedAt' | 'state'>, now: number): number | null =>
  run.state === 'skipped' ? null : Math.max(0, (run.endedAt ?? now) - run.startedAt);

const CRITIC_VERDICT_WORD = { pass: 'pass', fail: 'block', inconclusive: 'inconclusive' } as const;

export const criticVerdictWord = (verdict: NonNullable<StepRun['outputs']['verdict']>): string => CRITIC_VERDICT_WORD[verdict];

/** The one-line summary a row shows beside its step id. */
export function rowSummary(run: StepRun | null): string {
  if (run === null) return '';
  if (run.state === 'interrupted') return 'interrupted';
  return run.summary ?? run.detail ?? '';
}
