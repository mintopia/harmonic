import { describe, expect, it } from 'vitest';
import {
  failureReasonKey,
  failuresByReason,
  isExecutionFailure,
  type FailedRun,
} from '../src/domain/run-failure.js';

describe('isExecutionFailure', () => {
  it('counts a failed Run as an execution failure', () => {
    expect(isExecutionFailure({ state: 'failed' })).toBe(true);
  });

  it('does not treat completed, cancelled, or still-running Runs as failures (ADR-0028)', () => {
    expect(isExecutionFailure({ state: 'completed' })).toBe(false);
    expect(isExecutionFailure({ state: 'cancelled' })).toBe(false);
    expect(isExecutionFailure({ state: 'running' })).toBe(false);
  });
});

describe('failureReasonKey', () => {
  it("uses the Attempt's disposition-kind reason when present (ADR-0001 #388 S-E)", () => {
    expect(failureReasonKey({ attemptReason: 'escalate', runReason: 'boom' })).toBe('escalate');
    expect(failureReasonKey({ attemptReason: 'guardrail-trip', runReason: null })).toBe('guardrail-trip');
  });

  it("folds an 'interrupted' reason into process-death when no Attempt disposition exists", () => {
    expect(failureReasonKey({ attemptReason: null, runReason: 'interrupted' })).toBe('process-death');
  });

  it('buckets any other free-text reason as a generic error, and a bare failure as unknown', () => {
    expect(failureReasonKey({ attemptReason: null, runReason: 'some unique error message' })).toBe('failed');
    expect(failureReasonKey({ attemptReason: null, runReason: null })).toBe('unknown');
  });
});

describe('failuresByReason', () => {
  it('counts execution failures by reason bucket, collapsing free text via the Attempt disposition', () => {
    const failures: FailedRun[] = [
      { attemptReason: 'failed', runReason: 'epic branch missing' },
      { attemptReason: 'failed', runReason: 'a totally different message' },
      { attemptReason: 'process-death', runReason: 'interrupted' },
      { attemptReason: null, runReason: 'interrupted' },
      { attemptReason: 'guardrail-trip', runReason: 'budget: 60m' },
      { attemptReason: null, runReason: null },
    ];
    expect(failuresByReason(failures)).toEqual({
      failed: 2, // two distinct error messages collapse into one disposition bucket
      'process-death': 2, // the Attempt disposition and the 'interrupted' fallback merge together
      'guardrail-trip': 1,
      unknown: 1,
    });
  });

  it('returns an empty map for no failures', () => {
    expect(failuresByReason([])).toEqual({});
  });
});
