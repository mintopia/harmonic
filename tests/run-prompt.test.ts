import { describe, it, expect } from 'vitest';
import { buildTaskPrompt, promptForTask } from '../src/execution/run-prompt.js';
import { DEFAULT_TASK_PROMPT } from '../src/config.js';

/** A native Task's fields as promptForTask consumes them. */
const task = (over: Partial<Parameters<typeof promptForTask>[0]> = {}) => ({
  id: 7,
  prompt: 'Do the thing',
  workingDir: '/home/dev/harmonic',
  harness: 'claude',
  model: 'claude-sonnet-5',
  ...over,
});

describe('promptForTask', () => {
  it('sends the prompt verbatim under the default bare {prompt} template', () => {
    expect(promptForTask(task(), DEFAULT_TASK_PROMPT)).toBe('Do the thing');
    expect(promptForTask(task({ feedback: null }), DEFAULT_TASK_PROMPT)).toBe('Do the thing');
    // whitespace-only feedback counts as none
    expect(promptForTask(task({ feedback: '   \n ' }), DEFAULT_TASK_PROMPT)).toBe('Do the thing');
  });

  it('appends re-attempt feedback as a labelled section, in full', () => {
    const feedback = 'Add a header row.\n\nHandle empty result sets.';
    const out = promptForTask(task({ prompt: 'Export CSV', feedback }), DEFAULT_TASK_PROMPT);
    expect(out).toBe(`Export CSV\n\n## Feedback from the previous attempt\n\n${feedback}`);
    // the feedback is preserved verbatim, not truncated
    expect(out).toContain(feedback);
  });

  it('wraps the prompt in the operator template, then appends feedback after it', () => {
    const template = 'You are working on task #{id} in {workingDir}.\n\n{prompt}\n\nWhen done, stop.';
    const out = promptForTask(task({ feedback: 'Try again.' }), template);
    expect(out).toBe(
      'You are working on task #7 in /home/dev/harmonic.\n\nDo the thing\n\nWhen done, stop.' +
        '\n\n## Feedback from the previous attempt\n\nTry again.',
    );
  });
});

describe('buildTaskPrompt', () => {
  it('fills every placeholder from the Task, leaving unknown braces untouched', () => {
    const out = buildTaskPrompt('{harness}/{model} on #{id}: {prompt} [{workingDir}] {unknown}', {
      prompt: 'ship it',
      id: 42,
      workingDir: '/repo',
      harness: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(out).toBe('codex/gpt-5.6-sol on #42: ship it [/repo] {unknown}');
  });
});
