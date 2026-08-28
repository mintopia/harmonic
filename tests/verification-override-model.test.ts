import { describe, expect, it } from 'vitest';
import {
  EMPTY_COMMAND,
  EMPTY_CRITIC,
  argsText,
  missingReviewInput,
  reviewUnrunnable,
  setCommandField,
  setCriticField,
  summarizeCommand,
  summarizeCommands,
  summarizeCritic,
} from '../web/src/components/verification-override-model.js';
import type { VerificationCommand, VerificationCritic } from '../web/src/types.js';

const baseCommand: VerificationCommand = { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
const baseCritic: VerificationCritic = { prompt: 'review the diff', model: 'claude-opus-5' };

describe('reviewUnrunnable (ADR-0044 §F, issue #340)', () => {
  it('flags a review toggled on with no resolved model', () => {
    expect(reviewUnrunnable({ requested: true, model: '', prompt: 'review the diff' })).toBe(true);
  });

  it('flags a review toggled on with no resolved prompt', () => {
    expect(reviewUnrunnable({ requested: true, model: 'claude-opus-5', prompt: '' })).toBe(true);
  });

  it('is runnable when toggled on with both model and prompt resolved', () => {
    expect(reviewUnrunnable({ requested: true, model: 'claude-opus-5', prompt: 'review the diff' })).toBe(false);
  });

  it('is never unrunnable when the review is toggled off', () => {
    expect(reviewUnrunnable({ requested: false, model: '', prompt: '' })).toBe(false);
  });

  it('treats a missing (undefined/null) model or prompt as unresolved', () => {
    expect(reviewUnrunnable({ requested: true })).toBe(true);
    expect(reviewUnrunnable({ requested: true, model: null, prompt: null })).toBe(true);
  });

  it('names the missing input, model before prompt', () => {
    expect(missingReviewInput({ model: '', prompt: '' })).toBe('model');
    expect(missingReviewInput({ model: 'claude-opus-5', prompt: '' })).toBe('prompt');
  });
});

describe('setCommandField (issue #165)', () => {
  it('sets the executable from a text input', () => {
    expect(setCommandField(baseCommand, 'command', 'pnpm')).toEqual({ ...baseCommand, command: 'pnpm' });
  });

  it('splits args on any run of whitespace', () => {
    expect(setCommandField(baseCommand, 'args', 'run  lint --fix').args).toEqual(['run', 'lint', '--fix']);
  });

  it('clears args to an empty array on a blank input', () => {
    expect(setCommandField(baseCommand, 'args', '   ').args).toEqual([]);
  });

  it('sets a positive integer timeout', () => {
    expect(setCommandField(baseCommand, 'timeoutSeconds', '900')).toEqual({ ...baseCommand, timeoutSeconds: 900 });
  });

  it('keeps the prior timeout on a blank, non-numeric, or non-positive input', () => {
    expect(setCommandField(baseCommand, 'timeoutSeconds', '')).toEqual(baseCommand);
    expect(setCommandField(baseCommand, 'timeoutSeconds', 'soon')).toEqual(baseCommand);
    expect(setCommandField(baseCommand, 'timeoutSeconds', '0')).toEqual(baseCommand);
  });
});

describe('argsText (issue #165)', () => {
  it('joins args back into the whitespace-separated string the input edits', () => {
    expect(argsText({ ...baseCommand, args: ['run', 'lint'] })).toBe('run lint');
    expect(argsText({ ...baseCommand, args: [] })).toBe('');
  });
});

describe('summarizeCommand (issue #165)', () => {
  it('shows the argv and timeout for a configured command', () => {
    expect(summarizeCommand(baseCommand)).toBe('npm test · 600s timeout');
  });

  it('reads the empty seed back as "Not configured"', () => {
    expect(summarizeCommand(EMPTY_COMMAND)).toBe('Not configured');
  });
});

describe('summarizeCommands (issue #338)', () => {
  it('reads an empty list as "No commands"', () => {
    expect(summarizeCommands([])).toBe('No commands');
  });

  it('joins each command summary for a non-empty list', () => {
    const lint: VerificationCommand = { command: 'npm', args: ['run', 'lint'], env: {}, timeoutSeconds: 120 };
    expect(summarizeCommands([baseCommand, lint])).toBe(
      'npm test · 600s timeout · npm run lint · 120s timeout',
    );
  });

  it('summarizes a single-command list the same as summarizeCommand', () => {
    expect(summarizeCommands([baseCommand])).toBe(summarizeCommand(baseCommand));
  });
});

describe('setCriticField (issue #165)', () => {
  it('sets a free-text field', () => {
    expect(setCriticField(baseCritic, 'model', 'gpt-5')).toEqual({ ...baseCritic, model: 'gpt-5' });
    expect(setCriticField(baseCritic, 'prompt', 'check tests')).toEqual({ ...baseCritic, prompt: 'check tests' });
  });
});

describe('summarizeCritic (issue #165)', () => {
  it('names the reviewer model for a configured critic', () => {
    expect(summarizeCritic(baseCritic)).toBe('Critic model: claude-opus-5');
  });

  it('reads the empty seed back as "Not configured"', () => {
    expect(summarizeCritic(EMPTY_CRITIC)).toBe('Not configured');
  });
});
