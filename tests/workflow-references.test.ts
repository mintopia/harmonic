import { describe, expect, it } from 'vitest';
import { parseWorkflow } from '../src/domain/workflow.js';
import { inBlock } from './helpers.js';

const head = 'name: f\ndescription: d\nvars:\n  ok: 1\n';
const refusal = (steps: string): string => {
  try {
    parseWorkflow(`${head}steps:\n${inBlock(steps)}`);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
};
const withRef = (ref: string): string => refusal(`  - id: a\n    run: echo\n  - id: b\n    run: echo \${{ ${ref} }}\n`);

describe('expression reference validation', () => {
  it.each([
    'ticket.title',
    'attempt.number',
    'attempt.previousVerdict',
    'workspace.name',
    'vars.ok',
    'secrets.TOKEN',
    'steps.a.outcome',
    'steps.a.outputs',
    'steps.a.outputs.stdout',
    'steps.a.outputs.exitCode',
  ])('accepts %s', (ref) => {
    expect(withRef(ref)).toBe('');
  });

  it.each([
    ['attempt.nope', 'unknown reference attempt.nope'],
    ['attempt.number.x', 'unknown reference attempt.number.x'],
    ['workspace.nope', 'unknown reference workspace.nope'],
    ['vars.ok.x', 'unknown var ok'],
    ['secrets', 'secrets needs a name: secrets.NAME'],
    ['secrets.A.B', 'secrets needs a name: secrets.NAME'],
    ['steps', 'steps. is not an earlier step'],
    ['steps.zzz.outcome', 'steps.zzz is not an earlier step'],
    ['steps.b.outcome', 'steps.b is not an earlier step'],
    ['steps.a.foo', 'steps.a has outcome and outputs, not foo'],
    ['steps.a', 'steps.a has outcome and outputs, not'],
    ['steps.a.outcome.x', 'unknown reference steps.a.outcome.x'],
    ['steps.a.outputs.bogus', 'unknown reference steps.a.outputs.bogus'],
    ['steps.a.outputs.stdout.x', 'unknown reference steps.a.outputs.stdout.x'],
  ])('refuses %s', (ref, message) => {
    expect(withRef(ref)).toContain(message);
  });
});

describe('step invariants', () => {
  it.each([
    ['  - id: a\n    run: echo\n    uses: merge\n', 'step a needs exactly one of run, uses or parallel'],
    ['  - id: a\n    run: echo\n    with:\n      x: 1\n', 'with is only valid beside uses'],
    ['  - id: a\n    uses: agent\n    with:\n      option: fast\n      harness: claude\n', 'with.option cannot be combined with with.harness'],
    ['  - id: a\n    uses: agent\n    with:\n      option: fast\n      model: m\n', 'with.option cannot be combined with with.model'],
    ['  - id: a\n    uses: post-merge-check\n    with:\n      bogus: 1\n', 'bogus'],
    ['  - id: a\n    uses: verify\n    with:\n      bogus: 1\n', 'bogus'],
    ['  - id: a\n    run: echo\n  - id: a\n    run: echo\n', 'duplicate step id: a'],
  ])('refuses %j', (steps, message) => {
    expect(refusal(steps)).toContain(message);
  });
});

describe('step rule order', () => {
  it('reports a step’s problems in rule order', () => {
    const message = refusal('  - id: x\n    run: echo\n    uses: verify\n    with:\n      foo: 1\n');
    const form = message.indexOf('step x needs exactly one of run, uses or parallel');
    const key = message.indexOf('foo');
    expect(form).toBeGreaterThanOrEqual(0);
    expect(key).toBeGreaterThan(form);
  });
});
