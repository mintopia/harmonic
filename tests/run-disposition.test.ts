import { describe, expect, it } from 'vitest';
import {
  DISPOSITION_PRECEDENCE,
  computeDisposition,
  type Disposition,
} from '../src/domain/run-disposition.js';

/** A fact at `seq` of kind `type`; keeps the precedence tables readable. */
const fact = (seq: number, type: Disposition) => ({ seq, type });

describe('computeDisposition (issue #112)', () => {
  it('returns null when there are no facts', () => {
    expect(computeDisposition([], 10)).toBeNull();
  });

  it('returns null when every fact is after the cutoff', () => {
    expect(computeDisposition([fact(5, 'failed'), fact(6, 'escalate')], 4)).toBeNull();
  });

  it('returns the sole deciding fact disposition', () => {
    expect(computeDisposition([fact(1, 'agent-finish/unresolved')], 1)).toBe('agent-finish/unresolved');
  });

  it('is independent of input order (precedence wins, not first-seen or recency)', () => {
    const facts = [fact(3, 'process-death'), fact(1, 'escalate'), fact(2, 'failed')];
    expect(computeDisposition(facts, 3)).toBe('escalate');
    expect(computeDisposition([...facts].reverse(), 3)).toBe('escalate');
  });

  it('matches the reliability-design §0.3 precedence exactly (locked ordering)', () => {
    expect(DISPOSITION_PRECEDENCE).toEqual([
      'operator-cancel',
      'escalate',
      'branch-violation',
      'verify-fail',
      'guardrail-trip',
      'agent-finish/unresolved',
      'failed',
      'process-death',
    ]);
  });

  describe('precedence: for every adjacent pair, the higher-precedence fact wins when both are present', () => {
    for (let i = 0; i < DISPOSITION_PRECEDENCE.length - 1; i++) {
      const higher = DISPOSITION_PRECEDENCE[i]!;
      const lower = DISPOSITION_PRECEDENCE[i + 1]!;
      it(`${higher} beats ${lower}`, () => {
        // Prove it both ways round so neither seq order nor recency can explain it.
        expect(computeDisposition([fact(1, lower), fact(2, higher)], 2)).toBe(higher);
        expect(computeDisposition([fact(1, higher), fact(2, lower)], 2)).toBe(higher);
      });
    }
  });

  it('operator-cancel wins transitively over the whole ordering at once', () => {
    const all = DISPOSITION_PRECEDENCE.map((type, i) => fact(i + 1, type));
    expect(computeDisposition(all, all.length)).toBe(DISPOSITION_PRECEDENCE[0]);
  });

  describe('idempotency', () => {
    it('recomputing over the same facts + cutoff yields the same disposition', () => {
      const facts = [fact(1, 'guardrail-trip'), fact(2, 'escalate'), fact(3, 'process-death')];
      const once = computeDisposition(facts, 3);
      expect(computeDisposition(facts, 3)).toBe(once);
      expect(once).toBe('escalate');
    });

    it('duplicate facts of the winning kind collapse to the same disposition', () => {
      const facts = [fact(1, 'failed'), fact(2, 'failed'), fact(3, 'process-death')];
      expect(computeDisposition(facts, 3)).toBe('failed');
    });
  });

  describe('late facts (after the cutoff) are audit-only and cannot alter the disposition', () => {
    it('a higher-precedence fact arriving after the cutoff does not change the result', () => {
      const cutoff = 1;
      const before = [fact(1, 'agent-finish/unresolved')];
      expect(computeDisposition(before, cutoff)).toBe('agent-finish/unresolved');
      // operator-cancel outranks everything, but it lands after the cutoff.
      const withLate = [...before, fact(2, 'operator-cancel')];
      expect(computeDisposition(withLate, cutoff)).toBe('agent-finish/unresolved');
    });

    it('a fact exactly at the cutoff still decides (cutoff is inclusive)', () => {
      expect(computeDisposition([fact(1, 'failed'), fact(2, 'operator-cancel')], 2)).toBe('operator-cancel');
    });
  });
});
