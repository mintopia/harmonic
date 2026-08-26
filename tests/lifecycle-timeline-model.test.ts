import { describe, expect, it } from 'vitest';
import { lifecycleTimelineRows } from '../web/src/lifecycle-timeline-model.js';
import type { TicketTimelineEvent } from '../web/src/types.js';

const event = (kind: TicketTimelineEvent['kind'], ts: number, data: unknown): TicketTimelineEvent => ({ runId: 1, kind, ts, data });

describe('lifecycleTimelineRows', () => {
  it('keeps the audit chronology and gives verification, escalation, disposition, and merge operator-readable labels', () => {
    const rows = lifecycleTimelineRows([
      event('landing', 50, { effect: 'target-ref' }),
      event('verification', 20, { outcome: 'skipped', command: 'npm test' }),
      event('operator-reject', 40, { feedback: 'Use the documented timeout.' }),
      event('escalation', 30, {}),
      event('verification', 10, { verdict: 'pass', summary: 'checks passed' }),
    ]);

    expect(rows.map((row) => [row.at, row.label, row.detail, row.tone])).toEqual([
      [10, 'Verification pass', 'checks passed', 'passed'],
      [20, 'Verification skipped', 'npm test', 'neutral'],
      [30, 'Escalated for operator review', null, 'awaiting'],
      [40, 'Operator rejected with guidance', 'Use the documented timeout.', 'awaiting'],
      [50, 'Merged', 'target-ref', 'passed'],
    ]);
  });

  it('keeps disabled verification visible and tolerates unrecognised event payloads', () => {
    const rows = lifecycleTimelineRows([
      event('verification', 1, { outcome: 'disabled' }),
      event('fact', 2, null),
    ]);

    expect(rows[0]).toMatchObject({ label: 'Verification disabled', tone: 'neutral' });
    expect(rows[1]).toMatchObject({ label: 'Ticket fact recorded', detail: null });
  });
});
