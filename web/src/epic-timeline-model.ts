import type { Epic, EpicBranchStep, EpicExportStep, EpicTimelineStep } from './epic-model.js';
import { exportOutcomeRow, formatBytes } from './task-export-model.js';
import { mergeStepRow, type MergeStepTone } from './merge-progress-model.js';

export interface EpicTimelineRow {
  id: string;
  at: number;
  label: string;
  detail: string | null;
  tone: MergeStepTone;
  tag: 'LIFECYCLE' | 'INTEGRATION' | 'EXPORT';
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

function isExportStep(step: EpicTimelineStep): step is EpicExportStep {
  return step.step === 'export-built' || step.step === 'export-delivered' || step.step === 'export-failed';
}

function exportStepRow(step: EpicExportStep): { label: string; detail: string | null; tone: MergeStepTone } {
  if (step.step === 'export-built') {
    return { label: 'Export built', detail: [step.name, formatBytes(step.bytes), step.partial ? 'partial' : null].filter(Boolean).join(' · '), tone: 'neutral' };
  }
  const row = exportOutcomeRow(
    step.step === 'export-failed'
      ? { status: 'failed', destination: step.destination, error: step.error, retry: step.retry, nextRetryAt: step.nextRetryAt }
      : { status: 'succeeded', destination: step.destination, file: step.file },
  );
  return { label: row.label, detail: row.detail, tone: row.tone };
}

function timelineStepRow(step: EpicTimelineStep, index: number): { label: string; detail: string | null; tone: MergeStepTone } {
  if (isBranchStep(step)) return branchStepRow(step);
  if (isExportStep(step)) return exportStepRow(step);
  const row = mergeStepRow(step, index);
  return { label: row.label, detail: row.detail ?? row.log, tone: row.tone };
}

export function epicTimelineRows(epic: Epic): EpicTimelineRow[] {
  const integrationRows = epic.timelineEvents
    .map((event, index) => {
      const row = timelineStepRow(event.step, index);
      const tag: EpicTimelineRow['tag'] = isExportStep(event.step) ? 'EXPORT' : 'INTEGRATION';
      return { id: `event:${event.seq}`, at: event.at, label: row.label, detail: row.detail, tone: row.tone, tag, seq: event.seq };
    })
    .sort((a, b) => a.at - b.at || a.seq - b.seq)
    .map(({ seq: _, ...row }) => row);
  return [
    { id: 'created', at: epic.createdAt, label: 'Epic created', detail: null, tone: 'neutral', tag: 'LIFECYCLE' },
    ...integrationRows,
  ];
}
