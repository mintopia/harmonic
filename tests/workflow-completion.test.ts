import { describe, expect, it } from 'vitest';
import { completeWorkflow } from '../src/domain/workflow-completion.js';

const at = (text: string) => completeWorkflow(text, text.length);
const labels = (text: string) => at(text)?.options.map((o) => o.label);

describe('completeWorkflow', () => {
  it('offers the closed action set after uses:, filtered by prefix', () => {
    const text = 'steps:\n  - id: a\n    uses: c';
    const hit = at(text)!;
    expect(hit.from).toBe(text.length - 1);
    expect(hit.options.map((o) => o.label)).toEqual(['command', 'critic', 'comment', 'cleanup', 'close-ticket']);
    expect(hit.options.find((o) => o.label === 'command')!.detail).toBe('shell verify command');
    expect(labels('steps:\n  - uses: ')).toHaveLength(12);
  });

  it('offers step keys inside a step, top-level keys at the root', () => {
    expect(labels('steps:\n  - id: a\n    ')).toEqual(['id', 'uses', 'with', 'if', 'run', 'parallel']);
    expect(labels('steps:\n  - id: a\n    u')).toEqual(['uses']);
    expect(labels('na')).toEqual(['name']);
    expect(labels('name: x\n')).toEqual(['name', 'description', 'vars', 'steps', 'cleanup']);
    expect(labels('steps:\n  - attempts:\n      ')).toEqual(['max', 'steps']);
  });

  it('offers with keys for agent and critic steps only', () => {
    expect(labels('steps:\n  - id: a\n    uses: agent\n    with:\n      ')).toEqual(['prompt', 'harness', 'model', 'continueAttempts', 'continuePrompt']);
    expect(labels('steps:\n  - id: a\n    uses: critic\n    with:\n      pro')).toEqual(['prompt']);
    expect(labels('steps:\n  - id: a\n    uses: merge\n    with:\n      ')).toBeUndefined();
  });

  it('does not throw on invalid YAML or bad offsets', () => {
    expect(() => completeWorkflow('steps: [\n  - : :\n\t\tuses: c', 20)).not.toThrow();
    expect(completeWorkflow('x', 99)).toBeNull();
    expect(at('name: "unterminated')).toBeNull();
  });
});
