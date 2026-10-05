import type { Epic, EpicBranchStep, EpicExportStep, EpicResolverPromptStep, EpicTimelineStep } from './epic-model.js';
import { exportOutcomeRow, formatBytes } from './task-export-model.js';
import { mergeStepRow, type MergeStepTone } from './merge-progress-model.js';

export interface EpicTimelineRow {
  id: string;
  at: number;
  label: string;
  detail: string | null;
  tone: MergeStepTone;
  tag: 'LIFECYCLE' | 'INTEGRATION' | 'EXPORT';
  /** The archived prompt this row sent, read on demand; null for every other row. */
  prompt: { attempt: number; locator: string; index: number } | null;
}

export const EPIC_RESOLVER_LABEL = {
  'merge-conflict': 'Epic merge conflict resolver',
  verification: 'Epic verification resolver',
  refresh: 'Epic refresh resolver',
} as const;

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

function isResolverPromptStep(step: EpicTimelineStep): step is EpicResolverPromptStep {
  return step.step === 'resolver-prompt';
}

function timelineStepRow(step: EpicTimelineStep, index: number): { label: string; detail: string | null; tone: MergeStepTone } {
  if (isResolverPromptStep(step)) return { label: `${EPIC_RESOLVER_LABEL[step.kind]} prompt sent`, detail: null, tone: 'neutral' };
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
      const prompt = isResolverPromptStep(event.step) ? { attempt: event.step.attempt, locator: event.step.locator, index: event.step.promptIndex } : null;
      return { id: `event:${event.seq}`, at: event.at, label: row.label, detail: row.detail, tone: row.tone, tag, prompt, seq: event.seq };
    })
    .sort((a, b) => a.at - b.at || a.seq - b.seq)
    .map(({ seq: _, ...row }) => row);
  return [
    { id: 'created', at: epic.createdAt, label: 'Epic created', detail: null, tone: 'neutral', tag: 'LIFECYCLE', prompt: null },
    ...integrationRows,
  ];
}
