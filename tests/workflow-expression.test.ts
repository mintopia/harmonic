import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/domain/errors.js';
import { evaluateCondition, evaluateExpression, ExpressionError, interpolate } from '../src/domain/workflow-expression.js';
import { parseWorkflow } from '../src/domain/workflow.js';

const ctx = {
  steps: { build: { outcome: 'pass', outputs: { stdout: 'ok\n', exitCode: 0 } } },
  ticket: { title: 'Fix login', labels: ['bug', 'ui'], ref: '#7' },
  attempt: { number: 2 },
  workspace: { name: 'web' },
  vars: { env: 'prod', limit: 3 },
};

describe('workflow expression evaluator', () => {
  it.each([
    ["steps.build.outcome == 'pass'", true],
    ["steps.build.outcome != 'pass'", false],
    ["steps.build.outcome == 'PASS'", true],
    ['attempt.number > 1', true],
    ['attempt.number >= 3', false],
    ['attempt.number < vars.limit', true],
    ['attempt.number <= 2', true],
    ["!(vars.env == 'dev')", true],
    ["vars.env == 'prod' && attempt.number == 2", true],
    ["vars.env == 'dev' || attempt.number == 2", true],
    ["vars.env == 'dev' || attempt.number == 9", false],
    ["contains(ticket.labels, 'bug')", true],
    ["contains(ticket.labels, 'nope')", false],
    ["contains(ticket.title, 'login')", true],
    ["startsWith(ticket.title, 'fix')", true],
    ["startsWith(ticket.title, 'login')", false],
    ['steps.build.outputs.exitCode == 0', true],
    ['steps.missing.outcome', false],
    ['true', true],
    ['null', false],
    ["'it''s' == 'it''s'", true],
  ])('%s -> %s', (src, expected) => {
    expect(evaluateCondition(src, ctx)).toBe(expected);
  });

  it('formats and interpolates', () => {
    expect(evaluateExpression("format('{0}-{1}-{2}', ticket.ref, attempt.number, '{9}')", ctx)).toBe('#7-2-{9}');
    expect(interpolate('echo ${{ vars.env }} ${{ steps.build.outputs.exitCode }}', ctx)).toBe('echo prod 0');
  });

  it('accepts a condition wrapped in delimiters', () => {
    expect(evaluateCondition("${{ steps.build.outcome == 'pass' }}", ctx)).toBe(true);
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('does not walk the prototype via %s', (key) => {
    expect(evaluateExpression(`ticket.${key}`, ctx)).toBeNull();
    expect(evaluateExpression(`vars.${key}.x`, ctx)).toBeNull();
  });

  it.each([
    'ticket.title.constructor.constructor("return 1")()',
    'process.exit()',
    'require("fs")',
    'eval("1")',
    'Function("x")',
    'ticket["title"]',
    'a = 1',
    'ticket.',
    '(1',
    "'open",
    '1 +',
    '`x`',
    '${x}',
  ])('rejects %s', (src) => {
    expect(() => evaluateExpression(src, ctx)).toThrow(ExpressionError);
  });

  it('rejects deep nesting and long input', () => {
    expect(() => evaluateExpression('('.repeat(200) + '1' + ')'.repeat(200), ctx)).toThrow(ExpressionError);
    expect(() => evaluateExpression('!'.repeat(200) + 'true', ctx)).toThrow(ExpressionError);
    expect(() => evaluateExpression('1 || '.repeat(1000) + '1', ctx)).toThrow(ExpressionError);
  });

  it('never throws anything but ExpressionError for 1,000 random strings', () => {
    const alphabet = "abcxyz09 .()'!&|=<>,{}$-_\\\"`[]";
    let seed = 42;
    const next = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 1000; i++) {
      const length = Math.floor(next() * 40);
      const src = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
      try {
        evaluateExpression(src, ctx);
      } catch (error) {
        expect(error).toBeInstanceOf(ExpressionError);
      }
    }
  });
});

describe('workflow expression save-time validation', () => {
  const refusal = (text: string): DomainError => {
    try {
      parseWorkflow(text);
    } catch (error) {
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  };
  const head = 'name: f\ndescription: d\n';

  it('refuses a reference to a later step at its line and column', () => {
    const error = refusal(`${head}steps:\n  - id: first\n    run: echo\n    if: \${{ steps.later.outcome == 'pass' }}\n  - id: later\n    run: echo\n`);
    expect(error.issues?.[0]).toMatchObject({ line: 6, column: 13 });
    expect(error.message).toContain('steps.later is not an earlier step');
  });

  it('refuses a syntax error with its column', () => {
    const error = refusal(`${head}steps:\n  - id: a\n    run: echo\n    if: "vars.x == "\n`);
    expect(error.issues?.[0]?.line).toBe(6);
  });

  it.each([
    ['if: ${{ vars.nope }}', 'unknown var nope'],
    ['if: ${{ ticket.nothing }}', 'unknown reference ticket.nothing'],
    ['if: ${{ bogus.x }}', 'unknown reference bogus.x'],
    ['if: ${{ ticket.title.x }}', 'unknown reference ticket.title.x'],
    ['run: echo ${{ ( }}', 'invalid expression'],
  ])('refuses %s', (line, message) => {
    const key = line.startsWith('run') ? '' : '    run: echo\n';
    const error = refusal(`${head}vars:\n  ok: 1\nsteps:\n  - id: a\n${key}    ${line}\n`);
    expect(error.message).toContain(message);
  });

  it('accepts earlier-step, vars and secrets references', () => {
    const wf = parseWorkflow(`${head}vars:\n  mode: fast\nsteps:\n  - id: a\n    run: echo \${{ secrets.TOKEN }}\n  - id: b\n    run: echo\n    if: \${{ steps.a.outcome == 'pass' && vars.mode == 'fast' }}\n`);
    expect(wf.vars).toEqual({ mode: 'fast' });
    expect(wf.steps[1]?.if).toContain('steps.a.outcome');
  });
});
