import { describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { buildClassifierPrompt } from '../src/execution/prompt-assembly.js';
import { resolvePromptFragments } from '../src/domain/setting-override.js';
import { promptFragmentSchema } from '../src/config.js';
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

describe('Route Classifier Prompt Fragment', () => {
  const config = baselineConfig();

  it('resolves to a prompt with every Model Option id and description and the Ticket inputs', () => {
    const prompt = buildClassifierPrompt(input, config.promptFragments);
    for (const option of input.options) {
      expect(prompt).toContain(option.id);
      expect(prompt).toContain(option.description);
    }
    for (const value of [input.title, input.description, ...input.labels, 'timeout in login.spec', '"attemptNumber": 2']) {
      expect(prompt).toContain(value);
    }
    expect(prompt).not.toMatch(/\{(options|ticket)\}/);
  });

  it('replaces the default with a Workspace edit, and reset restores the default', () => {
    const edited = resolvePromptFragments({ promptFragmentRouteClassifier: 'EDITED {options} / {ticket}' } as never, config);
    expect(buildClassifierPrompt(input, edited)).toMatch(/^EDITED - cheap-fix: cheap, small fixes/);
    const reset = resolvePromptFragments({ promptFragmentRouteClassifier: null } as never, config);
    expect(buildClassifierPrompt(input, reset)).toBe(buildClassifierPrompt(input, config.promptFragments));
    expect(buildClassifierPrompt(input, reset)).not.toContain('EDITED');
  });

  it('rejects an edit that drops the options or the Ticket inputs', () => {
    const schema = promptFragmentSchema('routeClassifier');
    expect(schema.safeParse('only {options}').success).toBe(false);
    expect(schema.safeParse('only {ticket}').success).toBe(false);
    expect(schema.safeParse('{options} {ticket}').success).toBe(true);
  });
});
