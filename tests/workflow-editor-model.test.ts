import { describe, expect, it } from 'vitest';
import { serverRefusalIssues, validateWorkflowText } from '../web/src/workflow-editor-model.js';

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

  it('maps server issues, falling back to line 1', () => {
    expect(serverRefusalIssues({ message: 'm', issues: [{ message: 'x', line: 3, column: 2 }] })).toEqual([{ line: 3, column: 2, message: 'x', source: 'server' }]);
    expect(serverRefusalIssues({ message: 'name taken' })[0]).toMatchObject({ line: 1, source: 'server' });
  });
});
