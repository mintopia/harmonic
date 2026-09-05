import { describe, expect, it } from 'vitest';
import { verifierStatuses } from '../src/domain/verifier-status.js';

describe('verifierStatuses', () => {
  it('keeps the latest recorded verdict for each verifier mechanism', () => {
    expect(
      verifierStatuses({
        verifiers: {
          commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
          review: { enabled: true, requested: true, prompt: 'Review it.', model: 'stub-model' },
        },
        attempts: [
          { mechanism: 'command', seq: 1, verdict: 'fail' },
          { mechanism: 'critic', seq: 2, verdict: 'inconclusive' },
          { mechanism: 'command', seq: 3, verdict: 'pass' },
        ],
      }),
    ).toEqual([
      { mechanism: 'command', state: 'passed', reason: null, commands: ['npm test'] },
      { mechanism: 'critic', state: 'inconclusive', reason: null },
    ]);
  });

  it('shows configured verifiers as planned before the Attempt reaches its Verification Step', () => {
    for (const stepType of ['rebase', 'implementation'] as const) {
      expect(
        verifierStatuses({
          verifiers: {
            commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
            review: { enabled: true, requested: true, prompt: 'Review it.', model: 'stub-model' },
          },
          attempts: [],
          stepType,
        }),
      ).toEqual([
        {
          mechanism: 'command',
          state: 'planned',
          reason: 'Configured to run — the attempt has not reached verification yet.',
          commands: ['npm test'],
        },
        {
          mechanism: 'critic',
          state: 'planned',
          reason: 'Configured to run — the attempt has not reached verification yet.',
        },
      ]);
    }
  });

  it('shows the verifier whose Step is live as running, the one after it as planned', () => {
    const verifiers = {
      commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
      review: { enabled: true, requested: true, prompt: 'Review it.', model: 'stub-model' },
    };
    expect(verifierStatuses({ verifiers, attempts: [], stepType: 'verification' })).toEqual([
      { mechanism: 'command', state: 'running', reason: 'Running the command checks now.', commands: ['npm test'] },
      { mechanism: 'critic', state: 'planned', reason: 'Configured to run — the attempt has not reached verification yet.' },
    ]);
    expect(verifierStatuses({ verifiers, attempts: [{ mechanism: 'command', seq: 1, verdict: 'pass' }], stepType: 'review' })).toEqual([
      { mechanism: 'command', state: 'passed', reason: null, commands: ['npm test'] },
      { mechanism: 'critic', state: 'running', reason: 'The critic is reviewing the candidate now.' },
    ]);
  });

  it('carries the resolved review harness on the critic status so the live view can name the reviewing harness', () => {
    const [, critic] = verifierStatuses({
      verifiers: {
        commands: [],
        review: { enabled: true, requested: true, prompt: 'Review it.', model: 'stub-model', harness: 'claude' },
      },
      attempts: [],
      stepType: 'review',
    });
    expect(critic).toEqual({ mechanism: 'critic', state: 'running', reason: 'The critic is reviewing the candidate now.', harness: 'claude' });
  });

  it('shows a configured verifier as skipped once its Step has been passed over with no attempt', () => {
    expect(
      verifierStatuses({
        verifiers: {
          commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
          review: { enabled: true, requested: true, prompt: 'Review it.', model: 'stub-model' },
        },
        attempts: [],
        stepType: 'review',
      }),
    ).toEqual([
      { mechanism: 'command', state: 'skipped', reason: 'No command verification attempt was recorded for this attempt.', commands: ['npm test'] },
      { mechanism: 'critic', state: 'running', reason: 'The critic is reviewing the candidate now.' },
    ]);
  });

  it('shows configured verifiers as planned when stepType is omitted or null — no Step evidence yet is the safe default', () => {
    const expected = [
      {
        mechanism: 'command',
        state: 'planned',
        reason: 'Configured to run — the attempt has not reached verification yet.',
        commands: ['npm test'],
      },
      {
        mechanism: 'critic',
        state: 'planned',
        reason: 'Configured to run — the attempt has not reached verification yet.',
      },
    ];
    const verifiers = {
      commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
      review: { enabled: true, requested: true, prompt: 'Review it.', model: 'stub-model' },
    };
    expect(verifierStatuses({ verifiers, attempts: [] })).toEqual(expected);
    expect(verifierStatuses({ verifiers, attempts: [], stepType: null })).toEqual(expected);
  });

  it('keeps a recorded pass attempt as passed even at the Verification Step, not planned', () => {
    expect(
      verifierStatuses({
        verifiers: {
          commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
          review: { enabled: false, requested: false },
        },
        attempts: [{ mechanism: 'command', seq: 1, verdict: 'pass' }],
        stepType: 'verification',
      }),
    ).toEqual([
      { mechanism: 'command', state: 'passed', reason: null, commands: ['npm test'] },
      { mechanism: 'critic', state: 'disabled', reason: 'Critic verification is disabled.' },
    ]);
  });

  it('keeps a disabled verifier disabled regardless of Step — never planned', () => {
    expect(
      verifierStatuses({
        verifiers: { commands: [], review: { enabled: false, requested: false } },
        attempts: [],
        stepType: 'implementation',
      }),
    ).toEqual([
      { mechanism: 'command', state: 'disabled', reason: 'No command verifier is configured.' },
      { mechanism: 'critic', state: 'disabled', reason: 'Critic verification is disabled.' },
    ]);
  });

  it('keeps disabled verifier categories visible', () => {
    expect(
      verifierStatuses({
        verifiers: { commands: [], review: { enabled: false, requested: false } },
        attempts: [],
      }),
    ).toEqual([
      { mechanism: 'command', state: 'disabled', reason: 'No command verifier is configured.' },
      { mechanism: 'critic', state: 'disabled', reason: 'Critic verification is disabled.' },
    ]);
  });

  it('shows an enabled-but-unrunnable critic distinctly from disabled (issue #340)', () => {
    expect(
      verifierStatuses({
        verifiers: {
          commands: [],
          review: { enabled: false, requested: true, prompt: 'x' },
        },
        attempts: [],
      }),
    ).toEqual([
      { mechanism: 'command', state: 'disabled', reason: 'No command verifier is configured.' },
      {
        mechanism: 'critic',
        state: 'unrunnable',
        reason: 'Review is enabled but resolves to no model, so it cannot run. Set a review model or turn review off.',
      },
    ]);
  });
});
