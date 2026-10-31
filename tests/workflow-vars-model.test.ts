import { describe, expect, it } from 'vitest';
import {
  defaultHint,
  overridesFrom,
  parseVarInput,
  resetRow,
  setRowValue,
  ticketInherited,
  ticketVarRows,
  withWorkflowOverrides,
  workspaceVarRows,
} from '../web/src/components/workflow-vars-model.js';

const defaults = { maxAttempts: 3, continueAttempts: true, testCommand: 'npm test' };

describe('workflow vars model', () => {
  it('builds Workspace rows with type and source', () => {
    const rows = workspaceVarRows(defaults, { maxAttempts: 5, continueAttempts: 'no' as unknown as boolean });
    expect(rows.map((r) => [r.name, r.type, r.value, r.source])).toEqual([
      ['maxAttempts', 'number', 5, 'workspace'],
      ['continueAttempts', 'boolean', true, 'default'],
      ['testCommand', 'string', 'npm test', 'default'],
    ]);
  });

  it('types input by the default without coercion', () => {
    expect(parseVarInput('maxAttempts', 3, '5')).toEqual({ ok: true, value: 5 });
    expect(parseVarInput('maxAttempts', 3, 'three')).toEqual({ ok: false, message: 'maxAttempts must be a number (the workflow default is 3).' });
    expect(parseVarInput('maxAttempts', 3, '')).toMatchObject({ ok: false });
    expect(parseVarInput('flag', true, 'false')).toEqual({ ok: true, value: false });
    expect(parseVarInput('flag', true, 'yes')).toMatchObject({ ok: false });
    expect(parseVarInput('cmd', 'npm test', '3')).toEqual({ ok: true, value: '3' });
  });

  it('a value equal to the inherited one clears the override; Reset restores it', () => {
    const [row] = workspaceVarRows(defaults, null);
    const set = setRowValue(row!, 5, 'workspace');
    expect(set.source).toBe('workspace');
    expect(setRowValue(set, 3, 'workspace').source).toBe('default');
    expect(resetRow(set)).toMatchObject({ value: 3, source: 'default' });
  });

  it('Ticket rows inherit the Workspace value', () => {
    const vars = [{ name: 'maxAttempts', default: 3, workspace: 5, ticket: 2, value: 2, source: 'ticket' as const }];
    const [row] = ticketVarRows(vars);
    expect(defaultHint(vars[0]!)).toBe('3 ← Workspace 5');
    expect(resetRow(row!, ticketInherited(vars[0]!))).toMatchObject({ value: 5, source: 'workspace' });
    expect(setRowValue(row!, 3, 'ticket', ticketInherited(vars[0]!)).source).toBe('ticket');
    expect(overridesFrom([row!], 'ticket')).toEqual({ maxAttempts: 2 });
  });

  it('writes and prunes per-workflow overrides', () => {
    const one = withWorkflowOverrides(null, 'wf', { a: 1 });
    expect(one).toEqual({ wf: { a: 1 } });
    expect(withWorkflowOverrides(one, 'other', { b: true })).toEqual({ wf: { a: 1 }, other: { b: true } });
    expect(withWorkflowOverrides(one, 'wf', {})).toBeNull();
  });
});
