import { describe, expect, it } from 'vitest';
import { collectUsage, mergeUsage, type AttemptUsage, type ModelUsage } from '../src/execution/usage.js';

const mu = (n: number, extra: Partial<ModelUsage> = {}): ModelUsage => ({ inputTokens: n, outputTokens: n * 2, cacheReadTokens: n * 3, cacheWriteTokens: n * 4, ...extra });
const run = (over: Partial<AttemptUsage>): AttemptUsage => ({ models: {}, totals: null, toolCalls: {}, source: 'session-log', ...over });

describe('mergeUsage', () => {
  it('returns null for no runs and a null-source aggregate for runs with nothing', () => {
    expect(mergeUsage([])).toBeNull();
    expect(mergeUsage([run({})])).toEqual({ models: {}, totals: null, toolCalls: {}, source: null });
  });

  it('sums totals, nulls totalTokens once any run lacks it, and sums tool calls', () => {
    const totals = (n: number, totalTokens: number | null) => ({ ...mu(n), totalTokens });
    const merged = mergeUsage([
      run({ totals: totals(1, 5), toolCalls: { Read: 1 } }),
      run({ totals: null, toolCalls: { Read: 2, Bash: 1 } }),
      run({ totals: totals(2, 7), toolCalls: {} }),
    ])!;
    expect(merged.totals).toEqual({ ...mu(3), totalTokens: 12 });
    expect(merged.toolCalls).toEqual({ Read: 3, Bash: 1 });

    expect(mergeUsage([run({ totals: totals(1, 5) }), run({ totals: totals(2, null) }), run({ totals: totals(4, 1) })])!.totals).toEqual({ ...mu(7), totalTokens: null });
  });

  it('merges per-agent buckets with AI Units only where reported, and omits agents when none ran', () => {
    const merged = mergeUsage([
      run({ agents: { root: mu(1), reviewer: mu(1, { aiUnits: 1.5 }) } }),
      run({ agents: { root: mu(2), reviewer: mu(1, { aiUnits: 2 }) } }),
      run({}),
    ])!;
    expect(merged.agents).toEqual({ root: mu(3), reviewer: mu(2, { aiUnits: 3.5 }) });
    expect(merged.agents!.root).not.toHaveProperty('aiUnits');
    expect(mergeUsage([run({}), run({})])).not.toHaveProperty('agents');
  });

  it('drops an attribution cost the moment any run has none, and never invents one', () => {
    const merged = mergeUsage([
      run({ toolTokens: { A: { outputTokens: 1, cost: 1 }, B: { outputTokens: 1 }, C: { outputTokens: 1, cost: 2 } }, reasoning: { outputTokens: 1, cost: 1 } }),
      run({ toolTokens: { A: { outputTokens: 2, cost: 2 }, B: { outputTokens: 2, cost: 5 }, C: { outputTokens: 2 } }, reasoning: { outputTokens: 2, cost: 2 } }),
      run({ toolTokens: { A: { outputTokens: 4, cost: 4 } }, reasoning: { outputTokens: 4 } }),
      run({ toolTokens: { A: { outputTokens: 8, cost: 8 } }, reasoning: { outputTokens: 8, cost: 8 } }),
    ])!;
    expect(merged.toolTokens).toEqual({
      A: { outputTokens: 15, cost: 15 },
      B: { outputTokens: 3 },
      C: { outputTokens: 3 },
    });
    expect(merged.reasoning).toEqual({ outputTokens: 15 });
  });

  it('copies the first attribution so later merges never mutate an input run', () => {
    const first = run({ toolTokens: { A: { outputTokens: 1, cost: 1 } }, reasoning: { outputTokens: 1, cost: 1 } });
    mergeUsage([first, run({ toolTokens: { A: { outputTokens: 2, cost: 2 } }, reasoning: { outputTokens: 2, cost: 2 } })]);
    expect(first.toolTokens).toEqual({ A: { outputTokens: 1, cost: 1 } });
    expect(first.reasoning).toEqual({ outputTokens: 1, cost: 1 });
  });
});

describe('collectUsage selection', () => {
  const harness = { command: 'x', args: [], env: {}, models: [], defaultModel: 'x', cacheWarmSeconds: 300, sessionLogDir: '/nowhere' };
  const base = { harness, cwd: '/w', sessionId: 's', events: [] };

  it('returns null when neither ACP totals nor per-model usage exist', () => {
    expect(collectUsage({ ...base, harnessId: 'opencode' })).toBeNull();
    expect(collectUsage({ ...base, harnessId: 'opencode', promptResult: {} })).toBeNull();
  });

  it('reports ACP totals and context fill from the prompt result alone', () => {
    const usage = collectUsage({ ...base, harnessId: 'opencode', promptResult: { usage: { inputTokens: 5, outputTokens: 1, cachedWriteTokens: 2, totalTokens: 9 } } })!;
    expect(usage).toEqual({
      models: {},
      totals: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 2, totalTokens: 9 },
      toolCalls: {},
      contextTokens: 7,
      source: 'acp',
    });
  });

  it('prefers the prompt result per-model split (codex) and marks the source combined', () => {
    const promptResult = {
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      _meta: { quota: { model_usage: [{ model: 'gpt', token_count: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 } }, { model: 5 }, { model: 'none' }] } },
    };
    const usage = collectUsage({ ...base, harnessId: 'codex', promptResult })!;
    expect(usage.models).toEqual({ gpt: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 } });
    expect(usage.totals).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 110 });
    expect(usage.source).toBe('combined');
    expect(usage).not.toHaveProperty('agents');
  });
});
