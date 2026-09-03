import { describe, expect, it } from 'vitest';
import { mergeStepRows, mergeStepsFromTimeline, type MergeStepEvent } from '../web/src/merge-progress-model.js';
import type { TicketTimelineEvent } from '../web/src/types.js';

describe('mergeStepRows', () => {
  it('labels a skipped post-merge check honestly rather than as a pass', () => {
    const rows = mergeStepRows([{ step: 'post-check-skipped', mergeOid: 'abc1234def' }]);
    expect(rows[0]).toMatchObject({ label: 'Post-merge check skipped', detail: 'no commands configured', tone: 'neutral' });
  });

  it('exposes conflict paths as the expandable log and shorts the merge oid', () => {
    const rows = mergeStepRows([
      { step: 'conflict', paths: ['src/a.ts', 'src/b.ts'] },
      { step: 'merged', mergeOid: 'abcdef1234567' },
    ]);
    expect(rows[0]).toMatchObject({ label: 'Conflicts in 2 files', log: 'src/a.ts\nsrc/b.ts', tone: 'awaiting' });
    expect(rows[1]).toMatchObject({ label: 'Merged', detail: 'abcdef1', tone: 'passed' });
  });

  it('surfaces the revert oid and marks the row failed', () => {
    const rows = mergeStepRows([{ step: 'reverted', mergeOid: 'aaaaaaa1111', revertOid: 'bbbbbbb2222' }]);
    expect(rows[0]).toMatchObject({ label: 'Reverted to keep base green', detail: 'bbbbbbb', tone: 'failed' });
    expect(rows[0]!.log).toContain('reverted as bbbbbbb');
  });
});

describe('mergeStepsFromTimeline', () => {
  const lifecycle = (payload: unknown): TicketTimelineEvent => ({ attemptId: 1, ts: 0, kind: 'lifecycle', data: { payload } });

  it('pulls merge-step payloads in order and ignores other lifecycle events', () => {
    const started: MergeStepEvent = { step: 'started', baseBranch: 'develop', taskBranch: 'task/1' };
    const merged: MergeStepEvent = { step: 'merged', mergeOid: 'deadbeef' };
    const events: TicketTimelineEvent[] = [
      lifecycle({ event: 'merge-step', step: started }),
      lifecycle({ event: 'escalated', reason: 'x' }),
      lifecycle({ event: 'merge-step', step: merged }),
    ];
    expect(mergeStepsFromTimeline(events)).toEqual([started, merged]);
  });

  it('returns nothing when the stream carries no merge steps', () => {
    expect(mergeStepsFromTimeline([lifecycle({ event: 'merged', oid: 'x' })])).toEqual([]);
  });
});
