import { describe, expect, it } from 'vitest';
import { RAIL_COLLAPSED_KEY, VIEW_LABELS, VIEWS, loadRailCollapsed, storeRailCollapsed } from '../web/src/rail-model.js';

/** Minimal Storage stand-in — node tests have no localStorage. */
const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
};

describe('rail collapse persistence', () => {
  it('defaults to expanded when nothing is stored', () => {
    expect(loadRailCollapsed(memoryStorage())).toBe(false);
  });

  it('round-trips the collapsed choice', () => {
    const storage = memoryStorage();
    storeRailCollapsed(storage, true);
    expect(loadRailCollapsed(storage)).toBe(true);
    storeRailCollapsed(storage, false);
    expect(loadRailCollapsed(storage)).toBe(false);
  });

  it('treats unrecognized stored values as the expanded default', () => {
    expect(loadRailCollapsed(memoryStorage({ [RAIL_COLLAPSED_KEY]: 'garbage' }))).toBe(false);
  });

  it('survives a storage that throws (private browsing)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadRailCollapsed(throwing)).toBe(false);
    expect(() => storeRailCollapsed(throwing, true)).not.toThrow();
  });
});

describe('rail primary views', () => {
  it('promotes API to a primary nav view alongside Board/Table/Stats (issue 5)', () => {
    expect(VIEWS).toEqual(['board', 'table', 'stats', 'api', 'settings']);
  });

  it('labels every view', () => {
    for (const v of VIEWS) expect(VIEW_LABELS[v]).toBeTruthy();
    expect(VIEW_LABELS.api).toBe('API');
    expect(VIEW_LABELS.settings).toBe('Settings');
  });
});
