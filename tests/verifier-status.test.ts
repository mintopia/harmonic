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

  it('shows enabled verifiers without a recorded attempt as skipped with a reason', () => {
    expect(
      verifierStatuses({
        verifiers: {
          commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
          review: { enabled: true, requested: true, prompt: 'Review it.', model: 'stub-model' },
        },
        attempts: [],
        phase: 'verifying',
      }),
    ).toEqual([
      { mechanism: 'command', state: 'skipped', reason: 'No command verification attempt was recorded for this run.', commands: ['npm test'] },
      { mechanism: 'critic', state: 'skipped', reason: 'No critic verification attempt was recorded for this run.' },
    ]);
  });

  it('shows configured verifiers as planned before the run reaches verifying', () => {
    expect(
      verifierStatuses({
        verifiers: {
          commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
          review: { enabled: true, requested: true, prompt: 'Review it.', model: 'stub-model' },
        },
        attempts: [],
        phase: 'executing',
      }),
    ).toEqual([
      {
        mechanism: 'command',
        state: 'planned',
        reason: 'Configured to run — the run has not reached verification yet.',
        commands: ['npm test'],
      },
      {
        mechanism: 'critic',
        state: 'planned',
        reason: 'Configured to run — the run has not reached verification yet.',
      },
    ]);
  });

  it('shows configured verifiers as skipped once the run reaches verifying with no attempt', () => {
    expect(
      verifierStatuses({
        verifiers: {
          commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
          review: { enabled: true, requested: true, prompt: 'Review it.', model: 'stub-model' },
        },
        attempts: [],
        phase: 'verifying',
      }),
    ).toEqual([
      { mechanism: 'command', state: 'skipped', reason: 'No command verification attempt was recorded for this run.', commands: ['npm test'] },
      { mechanism: 'critic', state: 'skipped', reason: 'No critic verification attempt was recorded for this run.' },
    ]);
  });

  it('shows configured verifiers as skipped when phase is omitted (legacy callers)', () => {
    expect(
      verifierStatuses({
        verifiers: {
          commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
          review: { enabled: true, requested: true, prompt: 'Review it.', model: 'stub-model' },
        },
        attempts: [],
      }),
    ).toEqual([
      { mechanism: 'command', state: 'skipped', reason: 'No command verification attempt was recorded for this run.', commands: ['npm test'] },
      { mechanism: 'critic', state: 'skipped', reason: 'No critic verification attempt was recorded for this run.' },
    ]);
  });

  it('keeps a recorded pass attempt as passed even at phase verifying, not planned', () => {
    expect(
      verifierStatuses({
        verifiers: {
          commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
          review: { enabled: false, requested: false },
        },
        attempts: [{ mechanism: 'command', seq: 1, verdict: 'pass' }],
        phase: 'verifying',
      }),
    ).toEqual([
      { mechanism: 'command', state: 'passed', reason: null, commands: ['npm test'] },
      { mechanism: 'critic', state: 'disabled', reason: 'Critic verification is disabled.' },
    ]);
  });

  it('keeps a disabled verifier disabled regardless of phase — never planned', () => {
    expect(
      verifierStatuses({
        verifiers: { commands: [], review: { enabled: false, requested: false } },
        attempts: [],
        phase: 'executing',
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

  it('shows an enabled-but-unrunnable critic distinctly from disabled (ADR-0044 §F, issue #340)', () => {
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
