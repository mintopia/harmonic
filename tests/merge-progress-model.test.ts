import { describe, expect, it } from 'vitest';
import { mergeStepRows } from '../web/src/merge-progress-model.js';

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
