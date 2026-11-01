import { describe, expect, it } from 'vitest';
import { addVar, overriddenIn, readRunsOn, readVars, removeVar, setVar } from '../web/src/workflow-yaml-vars-model.js';

const SAMPLE = `name: w
description: d
runs_on: kind
vars:
  # keep: retries are costly
  max_loops: 3
  strict: true
  branch: main
steps:
  - id: a
    run: "true"
`;

describe('workflow yaml vars model', () => {
  it('reads declared vars with their types and runs_on', () => {
    expect(readVars(SAMPLE)).toEqual([
      { name: 'max_loops', type: 'number', value: '3' },
      { name: 'strict', type: 'boolean', value: 'true' },
      { name: 'branch', type: 'string', value: 'main' },
    ]);
    expect(readRunsOn(SAMPLE)).toBe('kind');
    expect(readVars('name: [')).toEqual([]);
  });

  it('sets a default keeping its type and the surrounding comments', () => {
    const next = setVar(SAMPLE, 'max_loops', '5');
    expect(next).toContain('max_loops: 5');
    expect(next).toContain('# keep: retries are costly');
    expect(setVar(SAMPLE, 'strict', 'false')).toContain('strict: false');
    expect(setVar(SAMPLE, 'max_loops', 'abc')).toContain('max_loops: abc');
  });

  it('adds and removes vars, creating and dropping the vars map', () => {
    const added = addVar(SAMPLE, 'extra', 'x');
    expect(readVars(added).map((v) => v.name)).toContain('extra');
    const bare = 'name: w\ndescription: d\nsteps:\n  - id: a\n    run: "true"\n';
    expect(readVars(addVar(bare, 'first', '1'))).toEqual([{ name: 'first', type: 'number', value: '1' }]);
    const gone = removeVar(addVar(bare, 'first', '1'), 'first');
    expect(gone).not.toContain('vars:');
    expect(removeVar(SAMPLE, 'branch')).not.toContain('branch');
  });

  it('refuses to add a duplicate and leaves invalid text alone', () => {
    expect(addVar(SAMPLE, 'branch', 'x')).toBe(SAMPLE);
    expect(setVar('name: [', 'a', '1')).toBe('name: [');
  });

  it('lists the workspaces that override a var', () => {
    const workspaces: { name: string; workflowVars: Record<string, Record<string, string>> | null }[] = [
      { name: 'api', workflowVars: { w: { branch: 'dev' } } },
      { name: 'web', workflowVars: { other: { branch: 'x' } } },
      { name: 'ops', workflowVars: null },
    ];
    expect(overriddenIn('w', 'branch', workspaces)).toEqual(['api']);
    expect(overriddenIn('w', 'strict', workspaces)).toEqual([]);
  });
});
