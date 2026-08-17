import { describe, expect, it } from 'vitest';
import { nextTabIndex } from '../web/src/tablist-model.js';

/**
 * Keyboard model for the task-detail review tablist (issue #95). The tabs
 * used a roving tabindex with no arrow-key handling, so Output/Changes/Details
 * were unreachable by keyboard. `nextTabIndex` is the pure part: given the
 * pressed key, the current tab index and the tab count, it returns the index
 * to move focus to (WAI-ARIA tablist pattern: Left/Right wrap, Home/End jump),
 * or `null` when the key is not a navigation key and the event should be left
 * alone.
 */
describe('nextTabIndex', () => {
  const COUNT = 5;

  it('ArrowRight moves to the next tab', () => {
    expect(nextTabIndex('ArrowRight', 0, COUNT)).toBe(1);
    expect(nextTabIndex('ArrowRight', 3, COUNT)).toBe(4);
  });

  it('ArrowRight wraps from the last tab to the first', () => {
    expect(nextTabIndex('ArrowRight', COUNT - 1, COUNT)).toBe(0);
  });

  it('ArrowLeft moves to the previous tab', () => {
    expect(nextTabIndex('ArrowLeft', 3, COUNT)).toBe(2);
    expect(nextTabIndex('ArrowLeft', 1, COUNT)).toBe(0);
  });

  it('ArrowLeft wraps from the first tab to the last', () => {
    expect(nextTabIndex('ArrowLeft', 0, COUNT)).toBe(COUNT - 1);
  });

  it('Home jumps to the first tab, End to the last', () => {
    expect(nextTabIndex('Home', 3, COUNT)).toBe(0);
    expect(nextTabIndex('End', 1, COUNT)).toBe(COUNT - 1);
  });

  it('returns null for keys that are not tablist navigation', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a', 'Escape']) {
      expect(nextTabIndex(key, 2, COUNT)).toBeNull();
    }
  });

  it('handles a current index outside the list without throwing', () => {
    // Focus not on any tab yet (querySelector index of -1): Right/Left still
    // land on a valid, in-range tab rather than NaN or a negative index.
    expect(nextTabIndex('ArrowRight', -1, COUNT)).toBe(0);
    expect(nextTabIndex('ArrowLeft', -1, COUNT)).toBe(COUNT - 1);
  });

  it('is a no-op-safe single-tab list', () => {
    expect(nextTabIndex('ArrowRight', 0, 1)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 1)).toBe(0);
    expect(nextTabIndex('End', 0, 1)).toBe(0);
  });
});
