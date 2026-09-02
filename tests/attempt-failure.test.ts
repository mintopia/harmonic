import { describe, expect, it } from 'vitest';
import {
  failureReasonKey,
  failuresByReason,
  isExecutionFailure,
  type FailedAttempt,
} from '../src/domain/attempt-failure.js';

describe('isExecutionFailure', () => {
  it('counts a failed Run as an execution failure', () => {
    expect(isExecutionFailure({ state: 'failed' })).toBe(true);
  });

  it('does not treat completed, cancelled, or still-running Runs as failures', () => {
    expect(isExecutionFailure({ state: 'completed' })).toBe(false);
    expect(isExecutionFailure({ state: 'cancelled' })).toBe(false);
    expect(isExecutionFailure({ state: 'running' })).toBe(false);
  });
});

describe('failureReasonKey', () => {
  it("uses the Attempt's disposition-kind reason when present (ADR-0001 #388 S-E)", () => {
    expect(failureReasonKey({ attemptReason: 'escalate', detailReason: 'boom' })).toBe('escalate');
    expect(failureReasonKey({ attemptReason: 'guardrail-trip', detailReason: null })).toBe('guardrail-trip');
  });

  it("folds an 'interrupted' reason into process-death when no Attempt disposition exists", () => {
    expect(failureReasonKey({ attemptReason: null, detailReason: 'interrupted' })).toBe('process-death');
  });

  it('buckets any other free-text reason as a generic error, and a bare failure as unknown', () => {
    expect(failureReasonKey({ attemptReason: null, detailReason: 'some unique error message' })).toBe('failed');
    expect(failureReasonKey({ attemptReason: null, detailReason: null })).toBe('unknown');
  });
});

describe('failuresByReason', () => {
  it('counts execution failures by reason bucket, collapsing free text via the Attempt disposition', () => {
    const failures: FailedAttempt[] = [
      { attemptReason: 'failed', detailReason: 'epic branch missing' },
      { attemptReason: 'failed', detailReason: 'a totally different message' },
      { attemptReason: 'process-death', detailReason: 'interrupted' },
      { attemptReason: null, detailReason: 'interrupted' },
      { attemptReason: 'guardrail-trip', detailReason: 'budget: 60m' },
      { attemptReason: null, detailReason: null },
    ];
    expect(failuresByReason(failures)).toEqual({
      failed: 2,
      'process-death': 2,
      'guardrail-trip': 1,
      unknown: 1,
    });
  });

  it('returns an empty map for no failures', () => {
    expect(failuresByReason([])).toEqual({});
  });
});
