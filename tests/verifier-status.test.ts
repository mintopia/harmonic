import { describe, expect, it } from 'vitest';
import { verifierStatuses } from '../src/domain/verifier-status.js';

describe('verifierStatuses', () => {
  it('keeps the latest recorded verdict for each verifier mechanism', () => {
    expect(
      verifierStatuses({
        verifiers: {
          commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
          review: { enabled: true, prompt: 'Review it.', model: 'stub-model' },
        },
        attempts: [
          { mechanism: 'command', seq: 1, verdict: 'fail' },
          { mechanism: 'critic', seq: 2, verdict: 'inconclusive' },
          { mechanism: 'command', seq: 3, verdict: 'pass' },
        ],
      }),
    ).toEqual([
      { mechanism: 'command', state: 'passed', reason: null },
      { mechanism: 'critic', state: 'inconclusive', reason: null },
    ]);
  });

  it('shows enabled verifiers without a recorded attempt as skipped with a reason', () => {
    expect(
      verifierStatuses({
        verifiers: {
          commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
          review: { enabled: true, prompt: 'Review it.', model: 'stub-model' },
        },
        attempts: [],
      }),
    ).toEqual([
      { mechanism: 'command', state: 'skipped', reason: 'No command verification attempt was recorded for this run.' },
      { mechanism: 'critic', state: 'skipped', reason: 'No critic verification attempt was recorded for this run.' },
    ]);
  });

  it('keeps disabled verifier categories visible', () => {
    expect(
      verifierStatuses({
        verifiers: { commands: [], review: { enabled: false } },
        attempts: [],
      }),
    ).toEqual([
      { mechanism: 'command', state: 'disabled', reason: 'No command verifier is configured.' },
      { mechanism: 'critic', state: 'disabled', reason: 'Critic verification is disabled.' },
    ]);
  });
});
