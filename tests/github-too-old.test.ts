import { describe, expect, it } from 'vitest';
import { GhError, isGhTooOld } from '../src/tracker/github.js';

describe('isGhTooOld', () => {
  it('recognises the old-gh unknown JSON field failure', () => {
    expect(isGhTooOld(new GhError('x', 'Unknown JSON field: "parent"'))).toBe(true);
  });
  it('ignores other gh failures and non-gh errors', () => {
    expect(isGhTooOld(new GhError('x', 'HTTP 404'))).toBe(false);
    expect(isGhTooOld(new Error('Unknown JSON field'))).toBe(false);
  });
});
