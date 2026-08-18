import { describe, expect, it } from 'vitest';
import {
  latestAttempts,
  latestVerdicts,
  overallDecision,
  latestCriticSummary,
} from '../web/src/verification-attempts-model.js';
import type { VerificationAttempt, VerificationMechanism } from '../web/src/types.js';
import type { Verdict } from '../web/src/verification-model.js';

/** Fills the fields the model helpers don't look at with plain defaults so
 * each test only spells out what it's asserting on (mirrors
 * `verification-model.test.ts`'s `v` factory). */
const attempt = (
  seq: number,
  mechanism: VerificationMechanism,
  verdict: Verdict,
  overrides: Partial<VerificationAttempt> = {},
): VerificationAttempt => ({
  id: seq,
  runId: 1,
  seq,
  ts: seq,
  mechanism,
  inputOid: 'a'.repeat(40),
  verdict,
  summary: `${mechanism} attempt ${seq}`,
  output: '',
  phase: 'verifying',
  mutated: false,
  ...overrides,
});

describe('latestAttempts', () => {
  it('is empty on the empty log', () => {
    expect(latestAttempts([])).toEqual([]);
  });

  it('keeps the whole max-seq attempt per mechanism, so the summary rides along with the verdict', () => {
    const attempts = [
      attempt(1, 'command', 'fail', { summary: 'lint broke' }),
      attempt(2, 'command', 'pass', { summary: 'lint clean' }),
    ];
    expect(latestAttempts(attempts)).toEqual([
      expect.objectContaining({ seq: 2, mechanism: 'command', verdict: 'pass', summary: 'lint clean' }),
    ]);
  });

  it('is robust to out-of-order input and orders mechanisms by first-seen', () => {
    const attempts = [
      attempt(3, 'critic', 'fail'),
      attempt(2, 'command', 'pass'),
      attempt(1, 'critic', 'pass'),
    ];
    expect(latestAttempts(attempts).map((a) => [a.mechanism, a.seq, a.verdict])).toEqual([
      ['critic', 3, 'fail'],
      ['command', 2, 'pass'],
    ]);
  });
});

describe('latestVerdicts', () => {
  it('is empty on the empty log', () => {
    expect(latestVerdicts([])).toEqual([]);
  });

  it('picks the max-seq attempt per mechanism when a mechanism retries', () => {
    const attempts = [
      attempt(1, 'command', 'fail'),
      attempt(2, 'command', 'pass'), // the self-heal retry that fixed it
    ];
    expect(latestVerdicts(attempts)).toEqual([{ verifier: 'command', verdict: 'pass' }]);
  });

  it('is robust to out-of-order input — still picks the highest seq per mechanism', () => {
    const attempts = [
      attempt(2, 'command', 'pass'),
      attempt(1, 'command', 'fail'),
    ];
    expect(latestVerdicts(attempts)).toEqual([{ verifier: 'command', verdict: 'pass' }]);
  });

  it('orders mechanisms by first-seen position, one entry each', () => {
    const attempts = [attempt(1, 'critic', 'pass'), attempt(2, 'command', 'pass'), attempt(3, 'critic', 'fail')];
    expect(latestVerdicts(attempts)).toEqual([
      { verifier: 'critic', verdict: 'fail' },
      { verifier: 'command', verdict: 'pass' },
    ]);
  });
});

describe('overallDecision', () => {
  it('proceeds on the empty log ("no verifiers configured")', () => {
    expect(overallDecision([])).toEqual({ outcome: 'proceed', reason: 'no verifiers configured' });
  });

  it('blocks when the current command verdict is fail alongside a passing critic', () => {
    const attempts = [attempt(1, 'command', 'fail'), attempt(1, 'critic', 'pass')];
    expect(overallDecision(attempts)).toEqual({ outcome: 'block', reason: 'verifier command failed' });
  });

  it('escalates when the current critic verdict is inconclusive', () => {
    const attempts = [attempt(1, 'command', 'pass'), attempt(1, 'critic', 'inconclusive')];
    expect(overallDecision(attempts)).toEqual({ outcome: 'escalate', reason: 'verifier critic inconclusive' });
  });
});

describe('latestCriticSummary', () => {
  it('is null when the log has no critic attempt', () => {
    expect(latestCriticSummary([attempt(1, 'command', 'pass')])).toBeNull();
  });

  it("returns the latest critic attempt's summary, not an earlier retry's", () => {
    const attempts = [
      attempt(1, 'critic', 'fail', { summary: 'missing test coverage' }),
      attempt(2, 'critic', 'pass', { summary: 'coverage added, looks good' }),
    ];
    expect(latestCriticSummary(attempts)).toBe('coverage added, looks good');
  });
});
