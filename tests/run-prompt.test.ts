import { describe, it, expect } from 'vitest';
import { promptForTask } from '../src/execution/run-prompt.js';

describe('promptForTask', () => {
  it('returns the prompt unchanged when there is no feedback', () => {
    expect(promptForTask({ prompt: 'Do the thing', feedback: null })).toBe('Do the thing');
    expect(promptForTask({ prompt: 'Do the thing' })).toBe('Do the thing');
    // whitespace-only feedback counts as none
    expect(promptForTask({ prompt: 'Do the thing', feedback: '   \n ' })).toBe('Do the thing');
  });

  it('appends re-attempt feedback as a labelled section, in full', () => {
    const feedback = 'Add a header row.\n\nHandle empty result sets.';
    const out = promptForTask({ prompt: 'Export CSV', feedback });
    expect(out).toBe(`Export CSV\n\n## Feedback from the previous attempt\n\n${feedback}`);
    // the feedback is preserved verbatim, not truncated
    expect(out).toContain(feedback);
  });
});
