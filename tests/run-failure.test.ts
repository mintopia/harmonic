import { describe, expect, it } from 'vitest';
import {
  failureReasonKey,
  failuresByReason,
  isExecutionFailure,
  type FailedRun,
} from '../src/domain/run-failure.js';
import type { DispositionFact } from '../src/domain/run-disposition.js';

const fact = (seq: number, type: string): DispositionFact => ({ seq, type });

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
  it('uses the winning terminal disposition when facts are present', () => {
    // escalate outranks failed in DISPOSITION_PRECEDENCE — the higher-precedence
    // signal is the reason, regardless of input order.
    expect(failureReasonKey({ facts: [fact(2, 'failed'), fact(1, 'escalate')], reason: 'boom' })).toBe('escalate');
    expect(failureReasonKey({ facts: [fact(1, 'guardrail-trip')], reason: null })).toBe('guardrail-trip');
  });

  it('ignores non-disposition facts, falling back when none rank', () => {
    // run-start-state / session-resumed are not terminal dispositions.
    expect(failureReasonKey({ facts: [fact(1, 'run-start-state'), fact(2, 'session-resumed')], reason: 'boom' })).toBe(
      'failed',
    );
  });

  it("folds an 'interrupted' reason into process-death when no fact exists", () => {
    expect(failureReasonKey({ facts: [], reason: 'interrupted' })).toBe('process-death');
  });

  it('buckets any other free-text reason as a generic error, and a bare failure as unknown', () => {
    expect(failureReasonKey({ facts: [], reason: 'some unique error message' })).toBe('failed');
    expect(failureReasonKey({ facts: [], reason: null })).toBe('unknown');
  });
});

describe('failuresByReason', () => {
  it('counts execution failures by reason bucket, collapsing free text via disposition', () => {
    const failures: FailedRun[] = [
      { facts: [fact(1, 'failed')], reason: 'epic branch missing' },
      { facts: [fact(1, 'failed')], reason: 'a totally different message' },
      { facts: [fact(1, 'process-death')], reason: 'interrupted' },
      { facts: [], reason: 'interrupted' },
      { facts: [fact(1, 'guardrail-trip')], reason: 'budget: 60m' },
      { facts: [], reason: null },
    ];
    expect(failuresByReason(failures)).toEqual({
      failed: 2, // two distinct error messages collapse into one disposition bucket
      'process-death': 2, // the fact and the 'interrupted' fallback land together
      'guardrail-trip': 1,
      unknown: 1,
    });
  });

  it('returns an empty map for no failures', () => {
    expect(failuresByReason([])).toEqual({});
  });
});
