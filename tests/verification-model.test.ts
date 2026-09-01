import { describe, expect, it } from 'vitest';
import { combineVerdicts } from '../web/src/verification-model.js';
import type { Verdict, VerifierVerdict } from '../web/src/verification-model.js';

const v = (verifier: string, verdict: Verdict): VerifierVerdict => ({ verifier, verdict });

describe('combineVerdicts', () => {
  it('proceeds on the empty set, naming "no verifiers configured"', () => {
    expect(combineVerdicts([])).toEqual({ outcome: 'proceed', reason: 'no verifiers configured' });
  });

  it('proceeds on a single pass', () => {
    expect(combineVerdicts([v('lint', 'pass')])).toEqual({
      outcome: 'proceed',
      reason: 'all 1 verifier passed',
    });
  });

  it('proceeds when all verifiers pass', () => {
    expect(combineVerdicts([v('lint', 'pass'), v('test', 'pass'), v('critic', 'pass')])).toEqual({
      outcome: 'proceed',
      reason: 'all 3 verifiers passed',
    });
  });

  it('blocks on a single fail', () => {
    expect(combineVerdicts([v('test', 'fail')])).toEqual({
      outcome: 'block',
      reason: 'verifier test failed',
    });
  });

  it('blocks on multiple fails and names all of them', () => {
    expect(combineVerdicts([v('lint', 'fail'), v('pass-through', 'pass'), v('test', 'fail')])).toEqual({
      outcome: 'block',
      reason: 'verifiers lint, test failed',
    });
  });

  it('escalates on a single inconclusive', () => {
    expect(combineVerdicts([v('critic', 'inconclusive')])).toEqual({
      outcome: 'escalate',
      reason: 'verifier critic inconclusive',
    });
  });

  it('escalates on multiple inconclusive and names all of them', () => {
    expect(
      combineVerdicts([v('critic', 'inconclusive'), v('lint', 'pass'), v('sandbox', 'inconclusive')]),
    ).toEqual({
      outcome: 'escalate',
      reason: 'verifiers critic, sandbox inconclusive',
    });
  });

  it('escalates over block when both fail and inconclusive are present (inconclusive wins, not block)', () => {
    const decision = combineVerdicts([v('test', 'fail'), v('critic', 'inconclusive')]);
    expect(decision.outcome).toBe('escalate');
    expect(decision).toEqual({
      outcome: 'escalate',
      reason: 'verifier critic inconclusive',
    });
  });

  it('escalates over block regardless of ordering, and does not mention the failing verifier in the reason', () => {
    const decision = combineVerdicts([v('critic', 'inconclusive'), v('test', 'fail'), v('lint', 'pass')]);
    expect(decision.outcome).toBe('escalate');
    expect(decision.reason).toContain('critic');
    expect(decision.reason).not.toContain('test');
  });

  it('names only the inconclusive verifiers when several fail and one is inconclusive', () => {
    const decision = combineVerdicts([
      v('test', 'fail'),
      v('lint', 'fail'),
      v('critic', 'inconclusive'),
    ]);
    expect(decision).toEqual({
      outcome: 'escalate',
      reason: 'verifier critic inconclusive',
    });
  });

  it('escalates fail-safe on a verdict outside the known union (server ahead of this bundle)', () => {
    const skewed = [v('lint', 'pass'), { verifier: 'sandbox', verdict: 'timeout' as unknown as Verdict }];
    expect(combineVerdicts(skewed)).toEqual({
      outcome: 'escalate',
      reason: 'unrecognized verifier verdict; escalating fail-safe',
    });
  });

  it('does not mutate the input array', () => {
    const input = [v('lint', 'pass'), v('test', 'fail'), v('critic', 'inconclusive')];
    const snapshot = input.map((entry) => ({ ...entry }));
    combineVerdicts(input);
    expect(input).toEqual(snapshot);
    expect(input.length).toBe(3);
  });

  it('is deterministic for the same input', () => {
    const input = [v('lint', 'fail'), v('test', 'fail')];
    expect(combineVerdicts(input)).toEqual(combineVerdicts(input));
  });
});
