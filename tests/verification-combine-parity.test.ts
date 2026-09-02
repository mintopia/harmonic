import { describe, it, expect } from 'vitest';
import { combineVerdicts as combineSrc } from '../src/verification/combine.js';
import { combineVerdicts as combineWeb, type VerifierVerdict } from '../web/src/verification-model.js';

describe('combineVerdicts src↔web parity (issue #135)', () => {
  const verdicts: VerifierVerdict['verdict'][] = ['pass', 'fail', 'inconclusive'];

  const batches: VerifierVerdict[][] = [[]];
  for (const a of verdicts) {
    batches.push([{ verifier: 'command', verdict: a }]);
    for (const b of verdicts) {
      batches.push([
        { verifier: 'command', verdict: a },
        { verifier: 'critic', verdict: b },
      ]);
    }
  }
  batches.push([{ verifier: 'command', verdict: 'weird' as VerifierVerdict['verdict'] }]);

  it('agrees on outcome and reason for every batch', () => {
    for (const batch of batches) {
      expect(combineSrc(batch)).toEqual(combineWeb(batch));
    }
  });
});
