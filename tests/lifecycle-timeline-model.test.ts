import { describe, expect, it } from 'vitest';
import { lifecycleTimelineRows } from '../web/src/lifecycle-timeline-model.js';
import type { TicketTimelineEvent } from '../web/src/types.js';

const event = (kind: TicketTimelineEvent['kind'], ts: number, data: unknown): TicketTimelineEvent => ({ attemptId: 1, kind, ts, data });

describe('lifecycleTimelineRows', () => {
  const lifecycle = (ts: number, payload: unknown): TicketTimelineEvent => event('lifecycle', ts, { type: 'lifecycle', payload });

  it('keeps the audit chronology and gives verification, escalation, and disposition events operator-readable labels', () => {
    const rows = lifecycleTimelineRows([
      event('verification', 10, { verdict: 'pass', summary: 'checks passed' }),
      event('verification', 20, { outcome: 'skipped', command: 'npm test' }),
      lifecycle(30, { event: 'escalated' }),
      event('operator-reject', 40, { feedback: 'Use the documented timeout.' }),
    ]);

    expect(rows.map((row) => [row.at, row.label, row.detail, row.tone])).toEqual([
      [10, 'Verify passed', 'checks passed', 'passed'],
      [20, 'Verify skipped', 'npm test', 'neutral'],
      [30, 'Escalated → awaiting review', null, 'awaiting'],
      [40, 'Operator rejected with guidance', 'Use the documented timeout.', 'awaiting'],
    ]);
  });

  it('reads recorded lifecycle events as significant, legible rows instead of a raw token', () => {
    const rows = lifecycleTimelineRows([
      lifecycle(10, { event: 'merged', oid: '0f758cd2200565e7605902a86c2827c65ad25ce0', baseBranch: 'develop' }),
      lifecycle(20, { event: 'escalated', gate: 'post-merge-red', reason: 'the post-merge check failed on develop' }),
      lifecycle(30, { event: 'rebase-conflict', baseBranch: 'develop' }),
      lifecycle(40, { event: 'progress-nudge', pattern: 'monologue' }),
      lifecycle(50, { event: 'ticket-closed', trackerRef: '185' }),
      lifecycle(60, { event: 'retired' }),
    ]);

    expect(rows.map((row) => [row.label, row.detail, row.tone, row.tag])).toEqual([
      ['Merged to develop', '0f758cd', 'passed', null],
      ['Escalated — post-merge check failed', 'the post-merge check failed on develop', 'awaiting', null],
      ['Rebase hit a conflict', 'develop', 'failed', null],
      ['Nudged — attempt stalled', 'monologue', 'awaiting', null],
      ['Issue #185 closed', null, 'passed', 'GITHUB'],
      ['Worktree cleaned up', null, 'neutral', null],
    ]);
  });

  it('weaves granular merge sub-steps into the chronology, deduping the terminal step against the high-level outcome', () => {
    const rows = lifecycleTimelineRows([
      lifecycle(10, { event: 'merge-step', step: { step: 'started', baseBranch: 'develop', taskBranch: 'task/498' } }),
      lifecycle(20, { event: 'merge-step', step: { step: 'post-check-passed', mergeOid: 'abcdef1234567' } }),
      lifecycle(30, { event: 'merge-step', step: { step: 'merged', mergeOid: 'abcdef1234567' } }),
      lifecycle(40, { event: 'merged', oid: 'abcdef1234567', baseBranch: 'develop' }),
    ]);

    expect(rows.map((row) => [row.at, row.label, row.tone, row.tag])).toEqual([
      [10, 'Merge started', 'running', 'MERGE'],
      [20, 'Post-merge check passed', 'passed', 'MERGE'],
      [40, 'Merged to develop', 'passed', null],
    ]);
  });

  it('folds a conflict merge-step\'s paths into the timeline detail', () => {
    const rows = lifecycleTimelineRows([
      lifecycle(10, { event: 'merge-step', step: { step: 'conflict', paths: ['src/a.ts', 'src/b.ts'] } }),
    ]);
    expect(rows[0]).toMatchObject({ label: 'Conflicts in 2 files', detail: 'src/a.ts\nsrc/b.ts', tone: 'awaiting', tag: 'MERGE' });
  });

  it('humanises an unrecognised lifecycle event rather than dumping the raw token', () => {
    const rows = lifecycleTimelineRows([lifecycle(10, { event: 'some-new-signal' })]);
    expect(rows[0]).toMatchObject({ label: 'Some new signal', tone: 'neutral' });
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
