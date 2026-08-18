import { describe, it, expect } from 'vitest';
import { decideMergeTrainLand, type MergeTrainGitFacts } from '../src/domain/merge-train.js';

const REBASED_TIP = 'b'.repeat(40);

/** A clean, landable set of facts — the happy path. Individual tests override
 * the fields under test. */
function cleanFacts(overrides: Partial<MergeTrainGitFacts> = {}): MergeTrainGitFacts {
  return {
    integrationExists: true,
    alreadyMerged: false,
    rebase: { status: 'clean', rebasedTip: REBASED_TIP },
    ...overrides,
  };
}

describe('decideMergeTrainLand (issue #160, pure merge-train land decision)', () => {
  it('escalates when the integration branch is missing', () => {
    const v = decideMergeTrainLand({
      facts: cleanFacts({ integrationExists: false }),
      healAttempted: false,
    });
    expect(v).toEqual({ action: 'escalate', reason: 'integration branch missing' });
  });

  it('already-merged wins over a conflicting rebase even with healAttempted true (idempotent crash/re-submit path)', () => {
    const v = decideMergeTrainLand({
      facts: cleanFacts({
        alreadyMerged: true,
        rebase: { status: 'conflict', detail: 'stale conflicting rebase' },
      }),
      healAttempted: true,
    });
    expect(v).toEqual({ action: 'already-landed' });
  });

  it('a clean rebase fast-forwards to the rebased tip', () => {
    const v = decideMergeTrainLand({ facts: cleanFacts(), healAttempted: false });
    expect(v).toEqual({ action: 'ff', toOid: REBASED_TIP });
  });

  it('a conflicting rebase with no prior heal attempt gets exactly one corrective turn, carrying the conflict detail', () => {
    const v = decideMergeTrainLand({
      facts: cleanFacts({ rebase: { status: 'conflict', detail: 'CONFLICT in src/foo.ts' } }),
      healAttempted: false,
    });
    expect(v).toEqual({ action: 'heal', reason: 'CONFLICT in src/foo.ts' });
  });

  it('a conflicting rebase that persists after the corrective turn escalates (no second mutating turn)', () => {
    const v = decideMergeTrainLand({
      facts: cleanFacts({ rebase: { status: 'conflict', detail: 'CONFLICT in src/foo.ts' } }),
      healAttempted: true,
    });
    expect(v).toEqual({
      action: 'escalate',
      reason: 'rebase still conflicts after corrective turn',
    });
  });

  it('escalates defensively when no rebase was observed at all (integration exists, not already merged)', () => {
    const v = decideMergeTrainLand({
      facts: cleanFacts({ rebase: null }),
      healAttempted: false,
    });
    expect(v).toEqual({ action: 'escalate', reason: 'internal: rebase not observed' });
  });

  it('is total and deterministic: same input yields the same decision', () => {
    const input = { facts: cleanFacts(), healAttempted: false };
    expect(decideMergeTrainLand(input)).toEqual(decideMergeTrainLand(input));
  });
});
