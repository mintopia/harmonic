import { describe, expect, it } from 'vitest';
import { PromptLibrary } from '../src/domain/prompt-library-store.js';
import { parseWorkflow } from '../src/domain/workflow.js';
import { renderAgentPrompt } from '../src/execution/prompt-assembly.js';
import { inBlock } from './helpers.js';

describe('renderAgentPrompt', () => {
  it('fills known fields, leaves unknown placeholders, and never re-expands a value', () => {
    expect(renderAgentPrompt('{a} {b} {nope}', { a: '{b}', b: 2 })).toBe('{b} 2 {nope}');
  });

  it('evaluates expressions in one pass with the fields', () => {
    const context = { ticket: { title: '{a}' } };
    expect(renderAgentPrompt('{a} ${{ ticket.title }}', { a: 'x' }, context)).toBe('x {a}');
  });
});

describe('PromptLibrary.resolve', () => {
  it('expands a bundled code and the includes in free text, leaving unknown includes', async () => {
    const library = new PromptLibrary(null);
    const [first] = await library.list();
    expect(await library.resolve(first!.code)).toBe(first!.resolved);
    expect(await library.resolve('plain ${{ prompts.nope-x }}')).toBe('plain ${{ prompts.nope-x }}');
  });
});

describe('workflow parser', () => {
  const flow = (step: string): string => `name: flow\ndescription: d\nsteps:\n${inBlock(`  - id: s\n${step}`)}`;

  it('accepts ticket.origin in expressions', () => {
    expect(() => parseWorkflow(flow(`    if: ticket.origin == 'mirrored'\n    run: "true"\n`))).not.toThrow();
  });

  it('makes post-merge-check with.run optional and strict', () => {
    expect(() => parseWorkflow(flow('    uses: post-merge-check\n'))).not.toThrow();
    expect(() => parseWorkflow(flow('    uses: post-merge-check\n    with:\n      other: 1\n'))).toThrow(/unknown key: other/);
  });
});
