import { describe, expect, it } from 'vitest';
import { messageParts, validateWorkflowText } from '../web/src/workflow-editor-model.js';

const good = ['name: w', 'description: d', 'steps:', '  - id: a', '    uses: rebase', '  - attempts:', '      max: 2', '      steps:', '        - id: b', '          uses: agent', ''].join('\n');
const bad = good.replace('uses: agent', 'uses: agent\n          retries: 3');

describe('validateWorkflowText', () => {
  it('builds a diagram for valid text', () => {
    const r = validateWorkflowText(good, null);
    expect(r.issues).toEqual([]);
    expect(r.diagram).not.toBeNull();
    expect(r.stale).toBe(false);
  });

  it('flags an unknown key at its line, keeps the last diagram as stale, and recovers', () => {
    const first = validateWorkflowText(good, null);
    const r = validateWorkflowText(bad, first.diagram);
    expect(r.issues).toEqual([{ line: 11, column: 11, message: 'unknown key: retries', source: 'schema' }]);
    expect(r.diagram).toBe(first.diagram);
    expect(r.stale).toBe(true);
    const fixed = validateWorkflowText(good, r.diagram);
    expect(fixed.issues).toEqual([]);
    expect(fixed.stale).toBe(false);
  });

  it('has no stale diagram when nothing valid was ever parsed', () => {
    const r = validateWorkflowText(bad, null);
    expect(r.diagram).toBeNull();
    expect(r.stale).toBe(false);
  });

});

describe('step-list unknown key hint', () => {
  it('suggests attempts for retries as a step entry', () => {
    const r = validateWorkflowText(['name: w', 'description: d', 'steps:', '  - retries: 2', ''].join('\n'), null);
    expect(r.issues[0]!.message).toContain('(did you mean attempts?)');
  });
});

describe('messageParts', () => {
  it('chips the token and the suggestion', () => {
    expect(messageParts('unknown key: retries (did you mean attempts?)')).toEqual([
      { text: 'unknown key: ', code: false }, { text: 'retries', code: true }, { text: ' (did you mean ', code: false }, { text: 'attempts', code: true }, { text: '?)', code: false },
    ]);
    expect(messageParts('invalid expression')).toEqual([{ text: 'invalid expression', code: false }]);
  });
});
