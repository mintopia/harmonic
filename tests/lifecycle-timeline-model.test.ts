import { describe, expect, it } from 'vitest';
import { lifecycleTimelineRows } from '../web/src/lifecycle-timeline-model.js';
import type { TicketTimelineEvent } from '../web/src/types.js';

const event = (kind: TicketTimelineEvent['kind'], ts: number, data: unknown): TicketTimelineEvent => ({ attemptId: 1, kind, ts, data });

describe('lifecycleTimelineRows', () => {
  it('keeps the audit chronology and gives verification, escalation, and disposition events operator-readable labels', () => {
    const rows = lifecycleTimelineRows([
      event('verification', 10, { verdict: 'pass', summary: 'checks passed' }),
      event('verification', 20, { outcome: 'skipped', command: 'npm test' }),
      event('escalation', 30, {}),
      event('operator-reject', 40, { feedback: 'Use the documented timeout.' }),
    ]);

    expect(rows.map((row) => [row.at, row.label, row.detail, row.tone])).toEqual([
      [10, 'Verify passed', 'checks passed', 'passed'],
      [20, 'Verify skipped', 'npm test', 'neutral'],
      [30, 'Escalated → awaiting review', null, 'awaiting'],
      [40, 'Operator rejected with guidance', 'Use the documented timeout.', 'awaiting'],
    ]);
  });

  it('keeps disabled verification visible and tolerates unrecognised event payloads', () => {
    const rows = lifecycleTimelineRows([
      event('verification', 1, { outcome: 'disabled' }),
      event('fact', 2, null),
    ]);

    expect(rows[0]).toMatchObject({ label: 'Verify disabled', tone: 'neutral' });
    expect(rows[1]).toMatchObject({ label: 'Ticket fact recorded', detail: null });
  });

  it('tags rows by source/mechanism and reads task-creation as a GITHUB row', () => {
    const rows = lifecycleTimelineRows([
      event('fact', 1, { type: 'task-created', trackerRef: '185', workspace: 'harmonic-core' }),
      event('attempt-started', 2, { attempt: 3 }),
      event('attempt-finished', 3, { attempt: 1, state: 'failed' }),
      event('verification', 4, { mechanism: 'critic', verdict: 'pass', summary: 'proceed' }),
      event('verification', 5, { mechanism: 'command', verdict: 'pass', summary: 'pnpm test' }),
    ]);
    expect(rows.map((row) => [row.label, row.tag])).toEqual([
      ['Task created', 'GITHUB'],
      ['Attempt 3 started', 'RUNNING'],
      ['Attempt 1 · failed', null],
      ['Review passed', 'CRITIC'],
      ['Verify passed', 'VERIFY'],
    ]);
    expect(rows[0]!.detail).toBe('Imported from issue #185 · queued to harmonic-core');
    expect(rows[1]!.detail).toBe('Continued Attempt 2');
  });
});
