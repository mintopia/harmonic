import type { Epic, EpicBranchStep, EpicTimelineStep } from './epic-model.js';
import { mergeStepRow, type MergeStepTone } from './merge-progress-model.js';

export interface EpicTimelineRow {
  id: string;
  at: number;
  label: string;
  detail: string | null;
  tone: MergeStepTone;
  tag: 'LIFECYCLE' | 'INTEGRATION';
}

const shortOid = (oid: string): string => oid.slice(0, 7);

function isBranchStep(step: EpicTimelineStep): step is EpicBranchStep {
  return step.step === 'branch-created' || step.step === 'branch-create-failed';
}

function branchStepRow(step: EpicBranchStep): { label: string; detail: string | null; tone: MergeStepTone } {
  if (step.step === 'branch-created') {
    return { label: `Created integration branch ${step.branch} from ${step.fromBranch}`, detail: shortOid(step.oid), tone: 'passed' };
  }
  return { label: `Integration branch ${step.branch} could not be created`, detail: step.error, tone: 'failed' };
}

function timelineStepRow(step: EpicTimelineStep, index: number): { label: string; detail: string | null; tone: MergeStepTone } {
  if (isBranchStep(step)) return branchStepRow(step);
  const row = mergeStepRow(step, index);
  return { label: row.label, detail: row.detail ?? row.log, tone: row.tone };
}

export function epicTimelineRows(epic: Epic): EpicTimelineRow[] {
  const integrationRows = epic.timelineEvents
    .map((event, index) => {
      const row = timelineStepRow(event.step, index);
      return { id: `event:${event.seq}`, at: event.at, label: row.label, detail: row.detail, tone: row.tone, tag: 'INTEGRATION' as const, seq: event.seq };
    })
    .sort((a, b) => a.at - b.at || a.seq - b.seq)
    .map(({ seq: _, ...row }) => row);
  return [
    { id: 'created', at: epic.createdAt, label: 'Epic created', detail: null, tone: 'neutral', tag: 'LIFECYCLE' },
    ...integrationRows,
  ];
}
