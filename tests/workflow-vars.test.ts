import { describe, expect, it } from 'vitest';
import { resolveVars, resolveVarSources, validateVarOverrides } from '../src/domain/workflow-vars.js';

const defaults = { maxAttempts: 2, mode: 'fast', strict: false };

describe('workflow var resolution', () => {
  it('uses the workflow default when nothing overrides it', () => {
    expect(resolveVars(defaults, null, null)).toEqual(defaults);
  });

  it('prefers a Workspace override to the default', () => {
    expect(resolveVars(defaults, { maxAttempts: 4 }, null)).toEqual({ ...defaults, maxAttempts: 4 });
  });

  it('prefers a Ticket override to a Workspace override', () => {
    expect(resolveVars(defaults, { maxAttempts: 4, mode: 'slow' }, { maxAttempts: 7 })).toEqual({ maxAttempts: 7, mode: 'slow', strict: false });
  });

  it('reports which level each value came from', () => {
    const sources = resolveVarSources(defaults, { mode: 'slow' }, { maxAttempts: 7 });
    expect(Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.source]))).toEqual({ maxAttempts: 'ticket', mode: 'workspace', strict: 'default' });
  });

  it('skips an override that no longer fits the pinned version', () => {
    expect(resolveVars(defaults, null, { maxAttempts: 'many', gone: 1 })).toEqual(defaults);
  });

  it('keeps a falsy override', () => {
    expect(resolveVars(defaults, null, { strict: false, maxAttempts: 0 })).toMatchObject({ maxAttempts: 0 });
  });
});

describe('validateVarOverrides', () => {
  it('accepts values of the default\'s type', () => {
    expect(validateVarOverrides(defaults, { maxAttempts: 3, mode: 'x', strict: true })).toEqual([]);
  });

  it('refuses a type mismatch without coercing', () => {
    expect(validateVarOverrides(defaults, { maxAttempts: '3', strict: 'true' })).toEqual(['maxAttempts: expected number, got string', 'strict: expected boolean, got string']);
  });

  it('refuses an undeclared name, including prototype keys', () => {
    expect(validateVarOverrides(defaults, { nope: 1 })).toEqual(['nope: the workflow declares no such var']);
    expect(validateVarOverrides(defaults, { constructor: 'x' })).toHaveLength(1);
  });
});
