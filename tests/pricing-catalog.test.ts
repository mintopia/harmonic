import { describe, expect, it } from 'vitest';
import { costOfUsages, pricesForHarness, resolveContextWindowForHarness } from '../src/domain/pricing.js';

const usage = (model: string) => ({
  models: { [model]: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  totals: null,
  toolCalls: {},
  source: 'acp' as const,
});

describe('per-harness model catalog', () => {
  it('prices shared ids by their owning harness and flags unknown ids as incomplete', () => {
    const claude = { models: [{ id: 'shared', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10 }] };
    const copilot = { models: [{ id: 'shared', price: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20 }] };

    expect(costOfUsages([usage('shared')], pricesForHarness(claude))?.totalUsd).toBe(1);
    expect(costOfUsages([usage('shared')], pricesForHarness(copilot))?.totalUsd).toBe(2);
    expect(costOfUsages([usage('custom')], pricesForHarness(claude))).toMatchObject({ totalUsd: null, byModel: { custom: null }, incomplete: true });
    expect(resolveContextWindowForHarness('shared-20260902', copilot)).toBe(20);
  });

  it('prefers an exact context-window entry over its dated-id fallback', () => {
    const harness = { models: [{ id: 'shared', contextWindow: 10 }, { id: 'shared-20260902', contextWindow: 20 }] };

    expect(resolveContextWindowForHarness('shared-20260902', harness)).toBe(20);
  });
});
