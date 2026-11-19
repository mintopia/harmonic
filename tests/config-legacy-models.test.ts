import { describe, expect, it } from 'vitest';
import { baselineConfig, mergeConfig } from '../src/config.js';

const base = baselineConfig();
const def = base.harnesses.codex.defaultModel;
const codexModels = (overrides: Record<string, unknown>) => mergeConfig(base, overrides as never).harnesses.codex.models;
const entry = (models: { id: string }[], id: string) => models.find((m) => m.id === id);

describe('legacy model catalog migration in mergeConfig', () => {
  it('passes non-record overrides through to the schema untouched', () => {
    expect(() => mergeConfig(base, 'nope' as never)).toThrow();
  });

  it('drops the legacy prices and modelInfo keys', () => {
    expect(mergeConfig(base, { prices: {}, modelInfo: {} } as never)).toEqual(base);
  });

  it('upgrades string models in an override catalog to entries', () => {
    const models = codexModels({ harnesses: { codex: { models: [def, 'extra'] } } });
    expect(models).toEqual([{ id: def }, { id: 'extra' }]);
  });

  it('fills price and context window from legacy data for override models lacking them', () => {
    const price = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
    const models = codexModels({
      harnesses: { codex: { models: [{ id: def }, { id: 'extra' }] } },
      prices: { [def]: price },
      modelInfo: { [def]: { contextWindow: 1000 }, extra: { contextWindow: 'big' } },
    });
    expect(entry(models, def)).toEqual({ id: def, price, contextWindow: 1000 });
    expect(entry(models, 'extra')).toEqual({ id: 'extra' });
  });

  it('keeps explicit price and context window on override models over legacy data', () => {
    const own = { input: 5, output: 6, cacheRead: 0.5, cacheWrite: 0.6 };
    const models = codexModels({
      harnesses: { codex: { models: [{ id: def, price: own, contextWindow: 7 }] } },
      prices: { [def]: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } },
      modelInfo: { [def]: { contextWindow: 1000 } },
    });
    expect(entry(models, def)).toEqual({ id: def, price: own, contextWindow: 7 });
  });

  it('appends legacy-only models to every harness catalog, with whichever data they have', () => {
    const price = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
    const merged = mergeConfig(base, {
      prices: { 'only-priced': price },
      modelInfo: { 'only-window': { contextWindow: 9 }, 'junk-info': 'x' },
    } as never);
    for (const id of ['claude', 'codex', 'copilot'] as const) {
      const models = merged.harnesses[id].models;
      expect(entry(models, 'only-priced')).toEqual({ id: 'only-priced', price });
      expect(entry(models, 'only-window')).toEqual({ id: 'only-window', contextWindow: 9 });
      expect(entry(models, 'junk-info')).toEqual({ id: 'junk-info' });
    }
  });

  it('skips a harness whose override is not a record', () => {
    expect(() => mergeConfig(base, { harnesses: { codex: 'bad' }, prices: { x: {} } } as never)).toThrow();
  });
});
