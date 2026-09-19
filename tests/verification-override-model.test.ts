import { describe, expect, it } from 'vitest';
import {
  newCommand,
  newCritic,
  newEpicCritic,
  setCommandField,
  setCriticField,
  summarizeCommand,
  summarizeCommands,
  summarizeCritic,
  withMissingGlobals,
} from '../web/src/components/verification-override-model.js';
import type { CommandOverlayEntry, TaskVerificationCritic, VerificationCommand } from '../web/src/types.js';

const baseCommand: VerificationCommand = { id: 'cmd-1', command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
const baseCritic: TaskVerificationCritic = { id: 'critic-1', name: 'Test critic', issuePrompt: 'review the issue diff', noIssuePrompt: 'review the Task diff', model: 'claude-opus-5', timeoutSeconds: 300 };

describe('setCommandField (issue #165)', () => {
  it('sets the executable from a text input', () => {
    expect(setCommandField(baseCommand, 'command', 'pnpm')).toEqual({ ...baseCommand, command: 'pnpm' });
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

describe('summarizeCommand (issue #165)', () => {
  it('shows the argv and timeout for a configured command', () => {
    expect(summarizeCommand(baseCommand)).toBe('npm test · 600s timeout');
  });

  it('reads the empty seed back as "Not configured"', () => {
    expect(summarizeCommand(newCommand())).toBe('Not configured');
  });
});

describe('summarizeCommands (issue #338)', () => {
  it('reads an empty list as "No commands"', () => {
    expect(summarizeCommands([])).toBe('No commands');
  });

  it('joins each command summary for a non-empty list', () => {
    const lint: VerificationCommand = { id: 'cmd-lint', command: 'npm', args: ['run', 'lint'], env: {}, timeoutSeconds: 120 };
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
    expect(setCriticField(baseCritic, 'noIssuePrompt', 'check tests')).toEqual({ ...baseCritic, noIssuePrompt: 'check tests' });
  });
});

describe('summarizeCritic (issue #165)', () => {
  it('names the reviewer model for a configured critic', () => {
    expect(summarizeCritic(baseCritic)).toBe('Test critic (claude-opus-5)');
  });

  it('reads the empty seed back as "Not configured"', () => {
    expect(summarizeCritic(newCritic())).toBe('Not configured');
  });
});

describe('newCommand/newCritic/newEpicCritic (ADR-0037)', () => {
  it('seeds each with its own id, never the same one twice', () => {
    expect(newCommand().id).not.toBe(newCommand().id);
    expect(newCritic().id).not.toBe(newCritic().id);
    expect(newEpicCritic().id).not.toBe(newEpicCritic().id);
  });
});

describe('withMissingGlobals (ADR-0037)', () => {
  it('renders every global, in order, as an enabled row when the overlay is null', () => {
    expect(withMissingGlobals<CommandOverlayEntry>(null, ['a', 'b'])).toEqual([
      { kind: 'global', ref: 'a', enabled: true },
      { kind: 'global', ref: 'b', enabled: true },
    ]);
  });

  it('leaves an overlay that already names every global untouched', () => {
    const overlay: CommandOverlayEntry[] = [{ kind: 'global', ref: 'a', enabled: false }];
    expect(withMissingGlobals(overlay, ['a'])).toEqual(overlay);
  });

  it('appends a global not named by any entry, enabled, at the end', () => {
    const overlay: CommandOverlayEntry[] = [{ kind: 'local', enabled: true, command: newCommand() }];
    const rows = withMissingGlobals(overlay, ['a']);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ kind: 'global', ref: 'a', enabled: true });
  });
});
