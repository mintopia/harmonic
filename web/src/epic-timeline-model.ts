import type { Epic } from './epic-model.js';
import { mergeStepRow, type MergeStepTone } from './merge-progress-model.js';

export interface EpicTimelineRow {
  id: string;
  at: number;
  label: string;
  detail: string | null;
  tone: MergeStepTone;
  tag: 'LIFECYCLE' | 'INTEGRATION';
}

/** Projects the Epic record and its persisted integration log into one audit trail. */
export function epicTimelineRows(epic: Epic): EpicTimelineRow[] {
  const integrationRows = epic.timelineEvents
    .map((event, index) => {
      const row = mergeStepRow(event.step, index);
      return { id: `event:${event.seq}`, at: event.at, label: row.label, detail: row.detail ?? row.log, tone: row.tone, tag: 'INTEGRATION' as const, seq: event.seq };
    })
    .sort((a, b) => a.at - b.at || a.seq - b.seq)
    .map(({ seq: _, ...row }) => row);
  return [
    { id: 'created', at: epic.createdAt, label: 'Epic created', detail: null, tone: 'neutral', tag: 'LIFECYCLE' },
    ...integrationRows,
  ];
}
