import { describe, expect, it } from 'vitest';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import { buildClassifierPrompt } from '../src/execution/prompt-assembly.js';
import type { ClassifierInput } from '../src/domain/route-classifier.js';

const input: ClassifierInput = {
  title: 'Fix the flaky login test',
  description: 'It fails one run in ten.',
  labels: ['bug', 'tests'],
  attemptNumber: 2,
  previousVerdict: 'failed',
  previousFailureReason: 'timeout in login.spec',
  options: [
    { id: 'cheap-fix', description: 'cheap, small fixes', harness: 'claude', model: 'haiku' },
    { id: 'deep-work', description: 'hard, cross-cutting work', harness: 'codex', model: 'gpt' },
  ],
};

describe('Route Classifier prompt', () => {
  it('resolves to a prompt with every Model Option id and description and the Ticket inputs', () => {
    const prompt = buildClassifierPrompt(input, bundledEnginePrompts());
    for (const option of input.options) {
      expect(prompt).toContain(option.id);
      expect(prompt).toContain(option.description);
    }
    for (const value of [input.title, input.description, ...input.labels, 'timeout in login.spec', '"attemptNumber": 2']) {
      expect(prompt).toContain(value);
    }
    expect(prompt).not.toMatch(/\{(options|ticket)\}/);
  });

  it('replaces the default with an edited prompt', () => {
    const edited = { ...bundledEnginePrompts(), routeClassifier: 'EDITED {options} / {ticket}' };
    expect(buildClassifierPrompt(input, edited)).toMatch(/^EDITED - cheap-fix: cheap, small fixes/);
    expect(buildClassifierPrompt(input, bundledEnginePrompts())).not.toContain('EDITED');
  });
});
