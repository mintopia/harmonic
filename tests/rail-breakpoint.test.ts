// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { isRailLayout } from '../web/src/useRailBreakpoint.js';

describe('isRailLayout', () => {
  it('falls back to 900px when --breakpoint-rail is unset', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    expect(isRailLayout({ matchMedia })).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith('(min-width: 900px)');
  });
});
