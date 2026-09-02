import { describe, expect, it } from 'vitest';
import { inheritSource, inheritState, layerState, toggleOverride } from '../web/src/components/inherit-field-model.js';

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

describe('inheritSource', () => {
  it('names the workspace when it pinned the field (a Task inherits that)', () => {
    expect(inheritSource('codex')).toBe('workspace');
  });

  it('falls through to the global default when the workspace also inherits (null)', () => {
    expect(inheritSource(null)).toBe('global default');
  });

  it('reads undefined (unset field) as the global default too', () => {
    expect(inheritSource(undefined)).toBe('global default');
  });

  it('treats a falsy-but-real workspace value (0) as the workspace source', () => {
    expect(inheritSource(0)).toBe('workspace');
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

describe('layerState', () => {
  it('mutes a global value that comes from the distributed baseline', () => {
    expect(layerState(2, 2, true)).toEqual({ effective: 2, inherited: true, modified: false });
  });

  it('marks a global value that differs from the distributed baseline as modified', () => {
    expect(layerState(3, 2, false)).toEqual({ effective: 3, inherited: false, modified: true });
  });

  it('keeps an explicit workspace value modified even when it equals its inherited value', () => {
    expect(layerState('claude', 'claude', false)).toEqual({
      effective: 'claude',
      inherited: false,
      modified: true,
    });
  });
});
