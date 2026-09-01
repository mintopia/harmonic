import { describe, it, expect } from 'vitest';
import { renameRecordKey } from '../web/src/components/settings-rename.js';

describe('renameRecordKey', () => {
  it('renames a key while preserving its position and value', () => {
    const obj = { A: '1', B: '2', C: '3' };
    const next = renameRecordKey(obj, 'B', 'BETA');
    expect(Object.entries(next)).toEqual([
      ['A', '1'],
      ['BETA', '2'],
      ['C', '3'],
    ]);
    expect(next).not.toBe(obj);
    expect(obj).toEqual({ A: '1', B: '2', C: '3' });
  });

  it('preserves position when renaming the first and last keys', () => {
    expect(Object.keys(renameRecordKey({ A: 1, B: 2, C: 3 }, 'A', 'Z'))).toEqual(['Z', 'B', 'C']);
    expect(Object.keys(renameRecordKey({ A: 1, B: 2, C: 3 }, 'C', 'Z'))).toEqual(['A', 'B', 'Z']);
  });

  it('trims whitespace from the new name', () => {
    expect(Object.keys(renameRecordKey({ A: 1 }, 'A', '  NEW  '))).toEqual(['NEW']);
  });

  it('is a no-op (same reference) when the name is unchanged', () => {
    const obj = { A: 1 };
    expect(renameRecordKey(obj, 'A', 'A')).toBe(obj);
  });

  it('is a no-op when the trimmed name is empty', () => {
    const obj = { A: 1 };
    expect(renameRecordKey(obj, 'A', '')).toBe(obj);
    expect(renameRecordKey(obj, 'A', '   ')).toBe(obj);
  });

  it('is a no-op when the new name collides with a different existing key', () => {
    const obj = { A: 1, B: 2 };
    expect(renameRecordKey(obj, 'A', 'B')).toBe(obj);
  });

  it('allows renaming to an inherited name like toString (own-key collision only)', () => {
    const obj = { A: 1 };
    const next = renameRecordKey(obj, 'A', 'toString');
    expect(Object.prototype.hasOwnProperty.call(next, 'toString')).toBe(true);
    expect(next['toString']).toBe(1);
  });

  it('works with object values (model-price shape)', () => {
    const prices = { 'old-model': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
    const next = renameRecordKey(prices, 'old-model', 'new-model');
    expect(next['new-model']).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    expect(next['old-model']).toBeUndefined();
  });
});
