import { describe, expect, it } from 'vitest';
import { inheritState, toggleOverride } from '../web/src/components/inherit-field-model.js';

describe('inheritState', () => {
  it('reads null as inheriting, so the effective value is the global default', () => {
    expect(inheritState(null, 'claude')).toEqual({ overridden: false, effective: 'claude' });
  });

  it('reads undefined (not-yet-migrated row) as inheriting too', () => {
    expect(inheritState(undefined, 'claude')).toEqual({ overridden: false, effective: 'claude' });
  });

  it('reads a stored value as an override, and it wins over the default', () => {
    expect(inheritState('codex', 'claude')).toEqual({ overridden: true, effective: 'codex' });
  });

  it('treats a stored value equal to the default as an explicit override (still pinned)', () => {
    expect(inheritState('claude', 'claude')).toEqual({ overridden: true, effective: 'claude' });
  });

  it('works for number fields (the concurrency cap)', () => {
    expect(inheritState(null, 4)).toEqual({ overridden: false, effective: 4 });
    expect(inheritState(8, 4)).toEqual({ overridden: true, effective: 8 });
  });

  it('does not read 0 as inherit (falsy but a real override)', () => {
    expect(inheritState(0, 4)).toEqual({ overridden: true, effective: 0 });
  });
});

describe('toggleOverride', () => {
  it('seeds a new override from the inherited default when turned on from inherit', () => {
    expect(toggleOverride(true, null, 'claude')).toBe('claude');
  });

  it('keeps the current override value when re-affirmed on', () => {
    expect(toggleOverride(true, 'codex', 'claude')).toBe('codex');
  });

  it('clears back to inherit (null) when turned off', () => {
    expect(toggleOverride(false, 'codex', 'claude')).toBeNull();
  });

  it('seeds from a 0 default without mistaking it for inherit', () => {
    expect(toggleOverride(true, null, 0)).toBe(0);
  });
});
