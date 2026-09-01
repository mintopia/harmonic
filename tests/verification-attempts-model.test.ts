import { describe, expect, it } from 'vitest';
import {
  latestAttempts,
  latestVerdicts,
  overallDecision,
  latestCriticSummary,
  groupAttemptsByMechanism,
  verificationRows,
  criticUnavailableReason,
} from '../web/src/verification-attempts-model.js';
import type { VerificationAttempt, VerificationMechanism, VerifierStatus } from '../web/src/types.js';
import type { Verdict } from '../web/src/verification-model.js';

const attempt = (
  seq: number,
  mechanism: VerificationMechanism,
  verdict: Verdict,
  overrides: Partial<VerificationAttempt> = {},
): VerificationAttempt => ({
  id: seq,
  attemptId: 1,
  seq,
  ts: seq,
  mechanism,
  inputOid: 'a'.repeat(40),
  verdict,
  summary: `${mechanism} attempt ${seq}`,
  output: '',
  hasTranscript: false,
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

describe('verificationRows', () => {
  it('joins each status to its latest recorded attempt without dropping skipped or disabled rows', () => {
    const statuses: VerifierStatus[] = [
      { mechanism: 'command', state: 'skipped', reason: 'No command verification attempt was recorded for this run.' },
      { mechanism: 'critic', state: 'passed', reason: null },
    ];

    expect(verificationRows(statuses, [attempt(1, 'critic', 'fail'), attempt(2, 'critic', 'pass')])).toEqual([
      { status: statuses[0], attempt: undefined },
      { status: statuses[1], attempt: expect.objectContaining({ seq: 2, verdict: 'pass' }) },
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
      attempt(2, 'command', 'pass'),
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

describe('groupAttemptsByMechanism', () => {
  it('is empty on the empty log', () => {
    expect(groupAttemptsByMechanism([])).toEqual([]);
  });

  it('numbers a single mechanism\'s attempts from 1, first attempt not a self-heal', () => {
    const attempts = [attempt(1, 'command', 'fail')];
    expect(groupAttemptsByMechanism(attempts)).toEqual([
      {
        mechanism: 'command',
        attempts: [expect.objectContaining({ seq: 1, attemptNumber: 1, isSelfHeal: false })],
      },
    ]);
  });

  it('numbers every retry after the first as a self-heal attempt', () => {
    const attempts = [
      attempt(1, 'command', 'fail'),
      attempt(3, 'command', 'fail'),
      attempt(5, 'command', 'pass'),
    ];
    const group = groupAttemptsByMechanism(attempts)[0]!;
    expect(group.attempts.map((a) => [a.seq, a.attemptNumber, a.isSelfHeal])).toEqual([
      [1, 1, false],
      [3, 2, true],
      [5, 3, true],
    ]);
  });

  it('groups interleaved mechanisms separately, each numbered from 1', () => {
    const attempts = [
      attempt(1, 'command', 'fail'),
      attempt(2, 'critic', 'pass'),
      attempt(3, 'command', 'pass'),
      attempt(4, 'critic', 'fail'),
    ];
    const groups = groupAttemptsByMechanism(attempts);
    expect(groups.map((g) => [g.mechanism, g.attempts.map((a) => [a.seq, a.attemptNumber, a.isSelfHeal])])).toEqual([
      [
        'command',
        [
          [1, 1, false],
          [3, 2, true],
        ],
      ],
      [
        'critic',
        [
          [2, 1, false],
          [4, 2, true],
        ],
      ],
    ]);
  });

  it('orders groups by each mechanism\'s first-seen seq, robust to out-of-order input', () => {
    const attempts = [
      attempt(3, 'critic', 'fail'),
      attempt(2, 'command', 'pass'),
      attempt(1, 'critic', 'pass'),
    ];
    expect(groupAttemptsByMechanism(attempts).map((g) => g.mechanism)).toEqual(['critic', 'command']);
  });

  it("keeps each attempt's original fields alongside the added attemptNumber/isSelfHeal", () => {
    const attempts = [attempt(1, 'command', 'fail', { summary: 'lint broke' })];
    const group = groupAttemptsByMechanism(attempts)[0]!;
    expect(group.attempts[0]).toEqual(
      expect.objectContaining({ id: 1, mechanism: 'command', verdict: 'fail', summary: 'lint broke' }),
    );
  });
});

describe('criticUnavailableReason (#331)', () => {
  it('is null when a transcript is present — nothing to explain', () => {
    expect(criticUnavailableReason('passed', true, true)).toBeNull();
    expect(criticUnavailableReason('disabled', false, true)).toBeNull();
  });

  it('says disabled when the verifier is off for the workspace', () => {
    expect(criticUnavailableReason('disabled', false, false)).toBe('Critic disabled for this workspace.');
  });

  it('says did-not-run when no attempt was recorded (skipped / never ran)', () => {
    expect(criticUnavailableReason('skipped', false, false)).toBe('Critic did not run.');
    expect(criticUnavailableReason('inconclusive', false, false)).toBe('Critic did not run.');
  });

  it('says unrunnable when enabled but resolving to no model', () => {
    expect(criticUnavailableReason('unrunnable', false, false)).toBe('Review is enabled but resolves to no model — it cannot run.');
  });

  it('says not-captured when the critic ran but its log was not captured', () => {
    expect(criticUnavailableReason('passed', true, false)).toBe('Critic session log was not captured.');
    expect(criticUnavailableReason('failed', true, false)).toBe('Critic session log was not captured.');
  });
});
