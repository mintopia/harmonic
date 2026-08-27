import { describe, it, expect } from 'vitest';
import { decideMergeTrainMerge, type MergeTrainGitFacts } from '../src/domain/merge-train.js';

const TIP = 'b'.repeat(40);

/** A fresh, mergeable set of facts — the happy path. Individual tests override
 * the fields under test. */
function freshFacts(overrides: Partial<MergeTrainGitFacts> = {}): MergeTrainGitFacts {
  return {
    integrationExists: true,
    alreadyMerged: false,
    memberTip: TIP,
    verifiedTip: TIP,
    basedOnIntegrationTip: true,
    ...overrides,
  };
}

describe('decideMergeTrainMerge (issue #160, ADR-0041 freshness gate)', () => {
  it('escalates when the integration branch is missing', () => {
    expect(decideMergeTrainMerge(freshFacts({ integrationExists: false }))).toEqual({
      action: 'escalate',
      reason: 'integration branch missing',
    });
  });

  it('already-merged wins over staleness (idempotent crash/re-submit path)', () => {
    expect(decideMergeTrainMerge(freshFacts({ alreadyMerged: true, memberTip: 'moved', basedOnIntegrationTip: false }))).toEqual({
      action: 'already-merged',
    });
  });

  it('fast-forwards to the verified tip when the member sits at it and it contains the integration tip', () => {
    expect(decideMergeTrainMerge(freshFacts())).toEqual({ action: 'ff', toOid: TIP });
  });

  it('is stale when the member branch moved off its verified tip', () => {
    expect(decideMergeTrainMerge(freshFacts({ memberTip: 'c'.repeat(40) }))).toEqual({
      action: 'stale',
      reason: 'member branch moved after verification',
    });
  });

  it('is stale when the integration branch advanced past what the verified tip is based on', () => {
    expect(decideMergeTrainMerge(freshFacts({ basedOnIntegrationTip: false }))).toEqual({
      action: 'stale',
      reason: 'integration branch advanced after verification',
    });
  });

  it('is total and deterministic: same input yields the same decision', () => {
    const input = freshFacts();
    expect(decideMergeTrainMerge(input)).toEqual(decideMergeTrainMerge(input));
  });
});
