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
      event('operator-retry', 40, { feedback: 'Use the documented timeout.' }),
    ]);

    expect(rows.map((row) => [row.at, row.label, row.detail, row.tone])).toEqual([
      [10, 'Verify passed', 'checks passed', 'passed'],
      [20, 'Verify skipped', 'npm test', 'neutral'],
      [30, 'Escalated → awaiting review', null, 'awaiting'],
      [40, 'Operator retried with guidance', 'Use the documented timeout.', 'awaiting'],
    ]);
  });

  it('labels operator accept, close and cancel task events by actor, with and without a reason', () => {
    const rows = lifecycleTimelineRows([
      lifecycle(10, { event: 'operator-accepted', actor: 'operator', reason: null }),
      lifecycle(20, { event: 'operator-accepted', actor: 'agent', reason: null }),
      lifecycle(30, { event: 'operator-closed', actor: 'operator', reason: 'Superseded by #12' }),
      lifecycle(40, { event: 'operator-closed', actor: 'agent', reason: null }),
      lifecycle(50, { event: 'operator-cancelled', actor: 'operator', reason: 'Wrong\n  repo' }),
      lifecycle(60, { event: 'operator-cancelled', actor: 'agent', reason: null }),
      lifecycle(70, { event: 'operator-accepted' }),
      lifecycle(80, { event: 'operator-closed', actor: 'system', reason: null }),
      lifecycle(90, { event: 'operator-cancelled' }),
    ]);

    expect(rows.map((row) => [row.label, row.detail, row.tone, row.tag])).toEqual([
      ['Accepted by operator', null, 'passed', null],
      ['Accepted by agent', null, 'passed', null],
      ['Closed by operator', 'Superseded by #12', 'neutral', null],
      ['Closed by agent', null, 'neutral', null],
      ['Cancelled by operator', 'Wrong repo', 'neutral', null],
      ['Cancelled by agent', null, 'neutral', null],
      ['Accepted', null, 'passed', null],
      ['Closed', null, 'neutral', null],
      ['Cancelled', null, 'neutral', null],
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

  it('flags a steer that could not be redelivered after its drive loop settled', () => {
    const rows = lifecycleTimelineRows([lifecycle(10, { event: 'steer_undelivered', text: 'left over from a turn that never came' })]);

    expect(rows.map((row) => [row.label, row.detail, row.tone])).toEqual([
      ['Steer not delivered', 'left over from a turn that never came', 'failed'],
    ]);
  });

  it('shows a Routing Label route change with the deciding label and whether the Session was kept', () => {
    const route = {
      event: 'route-changed',
      from: { harness: 'claude', model: 'claude-haiku-4-5-20251001' },
      to: { harness: 'claude', model: 'claude-opus-5-5' },
      label: 'reasoning',
    };
    const rows = lifecycleTimelineRows([
      lifecycle(10, { ...route, sessionKept: true }),
      lifecycle(20, { ...route, to: { harness: 'codex', model: '' }, sessionKept: false }),
    ]);

    expect(rows.map((row) => [row.label, row.detail])).toEqual([
      ['Route changed: Claude Haiku 4.5 → Claude Opus 5.5', "label 'reasoning'; warm Session kept"],
      ['Route changed: Claude Haiku 4.5 → Codex', "label 'reasoning'; fresh Session started"],
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

  it('labels Export attempts by outcome', () => {
    const rows = lifecycleTimelineRows([
      lifecycle(10, { event: 'export', destination: 'directory', status: 'succeeded', file: '/x/1-done.tar.gz' }),
      lifecycle(20, { event: 'export', destination: 's3', status: 'failed', error: 'AccessDenied: s3:PutObject' }),
    ]);

    expect(rows.map((row) => [row.label, row.detail, row.tone, row.tag])).toEqual([
      ['Export delivered · Directory', '/x/1-done.tar.gz', 'passed', 'EXPORT'],
      ['Export failed · S3 — AccessDenied', 's3:PutObject. Retry 1 of 3 in 5 min.', 'failed', 'EXPORT'],
    ]);
  });

  it('precedes the first fact of a build with one Export built row, and writes each retry its own fact', () => {
    const built = { builtAt: '2026-09-30T11:42:07.000Z', name: '412-done.tar.gz', bytes: 19_293_798, redactions: { bearer: 4, 'github-token': 3 } };
    const rows = lifecycleTimelineRows([
      lifecycle(1_000, { event: 'export', destination: 'directory', status: 'succeeded', file: '/srv/x/412-done.tar.gz', ...built }),
      lifecycle(2_000, { event: 'export', destination: 's3', status: 'failed', error: 'AccessDenied: s3:PutObject', ...built }),
      lifecycle(3_000, { event: 'export', destination: 's3', status: 'failed', error: 'AccessDenied: s3:PutObject', retry: 1, ...built }),
    ]);

    expect(rows.map((row) => row.label)).toEqual([
      'Export built',
      'Export delivered · Directory',
      'Export failed · S3 — AccessDenied',
      'Export failed · S3 — AccessDenied',
    ]);
    expect(rows[0]).toMatchObject({ detail: '412-done.tar.gz · 18.4 MB · 7 redactions', tone: 'neutral', tag: 'EXPORT', at: Date.parse(built.builtAt) });
    expect(rows[3]!.detail).toBe('s3:PutObject. Retry 1 of 3. Next: retry 2 of 3 in 30 min.');
    expect(new Set(rows.map((row) => row.id)).size).toBe(4);
  });
  describe('Agent Message rows', () => {
    const message = (ts: number, data: Record<string, unknown>) =>
      event('agent-message', ts, { messageId: 'm1', threadId: 'm1', workspaceId: 3, preview: 'Not touching merge.ts, go ahead.', isReply: false, reason: null, ...data });

    it('shows a sent row with the peer, receipt, preview and a Thread link, and no reply control', () => {
      const [row] = lifecycleTimelineRows([message(1_000, { direction: 'sent', peerTaskId: 413, peerHarness: 'codex', receipt: 'delivered', sendNumber: 3, sendCap: 10 })]);

      expect(row).toMatchObject({
        label: 'Agent Message sent',
        detail: 'New Thread · send 3 of 10 this Attempt',
        tone: 'sent',
        message: { peer: 'to T-413 · Codex', receipt: { label: 'delivered mid-turn', tone: 'done' }, preview: 'Not touching merge.ts, go ahead.', href: '/workspace/3/activity?thread=m1' },
      });
    });

    it('shows a received row from the sender, marking replies', () => {
      const [row] = lifecycleTimelineRows([message(1_000, { direction: 'received', peerTaskId: 412, peerHarness: 'claude', receipt: 'delivered', isReply: true })]);

      expect(row).toMatchObject({ label: 'Agent Message received', detail: 'Reply to your message', tone: 'received', message: { peer: 'from T-412 · Claude', epic: null } });
    });

    it('names the replied-to message time and the Epic on a received Epic broadcast', () => {
      const replyToAt = new Date(2026, 9, 2, 14, 9, 0).getTime();
      const [row] = lifecycleTimelineRows([message(1_000, { direction: 'received', peerTaskId: 412, peerHarness: 'claude', receipt: 'delivered', isReply: true, replyToAt, epic: 400 })]);

      expect(row).toMatchObject({ detail: 'Reply to your message of 14:09', message: { epic: 'Epic #400' } });
    });

    it('labels queued and held receipts for the recipient\'s next turn or Attempt', () => {
      const rows = lifecycleTimelineRows([
        message(1_000, { direction: 'sent', peerTaskId: 414, peerHarness: 'copilot', receipt: 'queued' }),
        message(2_000, { direction: 'sent', peerTaskId: 416, peerHarness: 'claude', receipt: 'held' }),
      ]);
      expect(rows.map((row) => row.detail)).toEqual(['New Thread', 'Task 416 is ready between Attempts']);

      expect(rows.map((row) => row.message?.receipt)).toEqual([
        { label: 'queued — next turn', tone: 'ready' },
        { label: 'held — next Attempt', tone: 'paused' },
      ]);
    });

    it('shows a refused send with its reason in place of the thread context', () => {
      const [row] = lifecycleTimelineRows([message(1_000, { direction: 'sent', peerTaskId: 415, peerHarness: null, receipt: 'refused', reason: 'Task #415 is not in this Workspace' })]);

      expect(row).toMatchObject({ detail: 'Task #415 is not in this Workspace', message: { peer: 'to T-415', receipt: { label: 'refused', tone: 'fail' } } });
    });
  });
});
