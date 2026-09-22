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

  it('shows pause and resume reasons as lifecycle facts', () => {
    const rows = lifecycleTimelineRows([
      lifecycle(10, { event: 'paused', reason: 'operator request' }),
      lifecycle(20, { event: 'resumed', reason: 'global pause cleared' }),
    ]);

    expect(rows.map((row) => [row.label, row.detail, row.tone])).toEqual([
      ['Paused', 'operator request', 'awaiting'],
      ['Resumed', 'global pause cleared', 'running'],
    ]);
  });

  it('makes an unattended permission-mode fallback visible', () => {
    const rows = lifecycleTimelineRows([
      lifecycle(10, {
        event: 'mode_set',
        requested: 'bypassPermissions',
        applied: 'auto',
        fallbackReason: 'configured-mode-not-advertised',
      }),
    ]);

    expect(rows[0]).toMatchObject({
      label: 'Permission mode fallback',
      detail: 'bypassPermissions → auto',
      tone: 'awaiting',
    });
  });

  it('renders the effective permission mode and distinguishes any requested-to-applied change', () => {
    const rows = lifecycleTimelineRows([
      lifecycle(10, { event: 'mode_set', requested: 'auto', applied: 'auto' }),
      lifecycle(20, { event: 'mode_set', requested: 'bypassPermissions', applied: 'auto' }),
    ]);

    expect(rows.map((row) => [row.label, row.detail, row.tone])).toEqual([
      ['Permission mode set', 'auto', 'neutral'],
      ['Permission mode fallback', 'bypassPermissions → auto', 'awaiting'],
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

  it('gives every git side-effect its own GIT-tagged row, failures included', () => {
    const rows = lifecycleTimelineRows([
      lifecycle(10, { event: 'worktree-created', worktree: 'task-42', branch: 'harmonic/task-42', baseBranch: 'develop', fromExistingBranch: false }),
      lifecycle(20, { event: 'worktree-created', worktree: 'task-42', branch: 'harmonic/task-42', baseBranch: null, fromExistingBranch: true }),
      lifecycle(30, { event: 'worktree-create-failed', worktree: 'task-42', branch: 'harmonic/task-42', baseBranch: 'develop', error: 'disk full' }),
      lifecycle(40, { event: 'worktree-discarded', worktree: 'task-42' }),
      lifecycle(50, { event: 'work-committed', oid: 'abcdef1234567', reason: 'recovered' }),
      lifecycle(60, { event: 'work-committed', oid: 'abcdef1234567', reason: 'attempt-end', attempt: 2 }),
      lifecycle(70, { event: 'commit-failed', error: 'lock held' }),
      lifecycle(80, { event: 'worktree-retained', worktree: 'task-42' }),
      lifecycle(90, { event: 'worktree-removed', worktree: 'task-42' }),
      lifecycle(100, { event: 'worktree-remove-failed', worktree: 'task-42', error: 'busy' }),
      lifecycle(110, { event: 'branch-deleted', branch: 'harmonic/task-42', containedIn: 'develop' }),
      lifecycle(120, { event: 'branch-delete-failed', branch: 'harmonic/task-42', error: 'ref lock held' }),
    ]);

    expect(rows.map((row) => [row.label, row.detail, row.tone, row.tag])).toEqual([
      ['Created worktree task-42 on harmonic/task-42 from develop', null, 'neutral', 'GIT'],
      ['Checked out harmonic/task-42 into worktree task-42', null, 'neutral', 'GIT'],
      ['Worktree task-42 could not be created', 'disk full', 'failed', 'GIT'],
      ['Discarded orphaned worktree task-42', null, 'neutral', 'GIT'],
      ['Committed leftover work', 'abcdef1', 'neutral', 'GIT'],
      ["Committed Attempt 2's uncommitted work", 'abcdef1', 'neutral', 'GIT'],
      ["Couldn't commit leftover work", 'lock held', 'failed', 'GIT'],
      ['Kept worktree task-42 for the warm session', null, 'neutral', 'GIT'],
      ['Removed worktree task-42', null, 'neutral', 'GIT'],
      ['Worktree task-42 could not be removed', 'busy', 'failed', 'GIT'],
      ['Deleted branch harmonic/task-42 (already merged into develop)', null, 'neutral', 'GIT'],
      ['Branch harmonic/task-42 could not be deleted', 'ref lock held', 'failed', 'GIT'],
    ]);
  });

  it('renders retirement, ticket-close and ticket-close-failure git rows', () => {
    const rows = lifecycleTimelineRows([
      lifecycle(10, { event: 'retired', worktree: 'task-42' }),
      lifecycle(20, { event: 'retired', worktree: 'task-42', error: 'already gone' }),
      lifecycle(30, { event: 'ticket-closed', trackerRef: '185', commitOid: 'a1b2c3d4e5', paths: ['.scratch/issues/07.md'] }),
      lifecycle(40, { event: 'ticket-close-failed', trackerRef: '185', error: 'no permission' }),
    ]);

    expect(rows.map((row) => [row.label, row.detail, row.tone, row.tag])).toEqual([
      ['Removed worktree task-42 (session retired)', null, 'neutral', 'GIT'],
      ['Worktree task-42 could not be removed', 'already gone', 'failed', 'GIT'],
      ['Issue #185 closed', 'Committed a1b2c3d to the base checkout (1 file)', 'passed', 'GITHUB'],
      ['Issue #185 could not be closed', 'no permission', 'failed', 'GITHUB'],
    ]);
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
