import { describe, expect, it } from 'vitest';
import {
  activitySummary,
  attentionTier,
  ATTENTION_TIERS,
  contextFillFraction,
  elapsedMs,
  HIGH_LOAD_FILL,
  mergeRunUsage,
  rankActivity,
  sumCosts,
  tierLabel,
  tokensPerSecond,
  usageTotalTokens,
} from '../web/src/activity-model.js';
import type { ActivityProcess, Cost, RunUsage, RunUsageEvent } from '../web/src/types.js';

/** A RunUsage with a single-model total; `null` totals model the pre-first-token state. */
function usage(total: number | null, extra: Partial<RunUsage> = {}): RunUsage {
  return {
    models: {},
    totals:
      total === null
        ? null
        : { inputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: total },
    toolCalls: {},
    source: 'acp',
    ...extra,
  };
}

function proc(over: Partial<ActivityProcess> = {}): ActivityProcess {
  return {
    type: 'run',
    runId: 1,
    conversationId: null,
    taskId: 10,
    title: 'A task',
    workspaceId: 1,
    workspaceName: 'harmonic',
    harness: 'claude',
    model: 'sonnet-5',
    state: 'running',
    isolation: 'worktree',
    startedAt: 1_000,
    trackerRef: null,
    escalated: false,
    usage: usage(1000),
    contextTokens: null,
    contextWindow: null,
    activity: null,
    tree: null,
    cost: { totalUsd: 0.5, byModel: { 'sonnet-5': 0.5 }, incomplete: false },
    ...over,
  };
}

describe('contextFillFraction', () => {
  it('is null when the window is unconfigured (honest degradation, no fake %)', () => {
    expect(contextFillFraction(proc({ contextTokens: 5000, contextWindow: null }))).toBeNull();
  });
  it('is null when the fill is unknown', () => {
    expect(contextFillFraction(proc({ contextTokens: null, contextWindow: 200_000 }))).toBeNull();
  });
  it('is the fraction when both are known — deliberately unclamped past 1', () => {
    expect(contextFillFraction(proc({ contextTokens: 150_000, contextWindow: 200_000 }))).toBeCloseTo(0.75);
    expect(contextFillFraction(proc({ contextTokens: 220_000, contextWindow: 200_000 }))).toBeCloseTo(1.1);
  });
});

describe('attentionTier', () => {
  it('an escalated Run needs you', () => {
    expect(attentionTier(proc({ escalated: true }))).toBe('needs-you');
  });
  it('a process over its context window needs you (degrading)', () => {
    expect(attentionTier(proc({ contextTokens: 210_000, contextWindow: 200_000 }))).toBe('needs-you');
  });
  it('a process at/over the high-load fill but under the window is high load', () => {
    const fill = Math.round(HIGH_LOAD_FILL * 200_000);
    expect(attentionTier(proc({ contextTokens: fill, contextWindow: 200_000 }))).toBe('high-load');
  });
  it('a comfortable process is steady', () => {
    expect(attentionTier(proc({ contextTokens: 20_000, contextWindow: 200_000 }))).toBe('steady');
  });
  it('an unknown-window process is steady — no threshold to judge it against', () => {
    expect(attentionTier(proc({ contextTokens: 999_999, contextWindow: null }))).toBe('steady');
  });
  it('escalation outranks a merely-comfortable fill', () => {
    expect(attentionTier(proc({ escalated: true, contextTokens: 10, contextWindow: 200_000 }))).toBe('needs-you');
  });
  it('every tier has a human label', () => {
    for (const t of ATTENTION_TIERS) expect(tierLabel(t)).toMatch(/\w/);
  });
});

describe('rankActivity', () => {
  it('orders needs-you before high-load before steady, then by fill desc, then oldest first', () => {
    const steady = proc({ runId: 1, contextTokens: 10_000, contextWindow: 200_000 });
    const highA = proc({ runId: 2, contextTokens: 160_000, contextWindow: 200_000, startedAt: 500 });
    const highB = proc({ runId: 3, contextTokens: 190_000, contextWindow: 200_000, startedAt: 400 });
    const needs = proc({ runId: 4, escalated: true });
    const ranked = rankActivity([steady, highA, highB, needs]);
    expect(ranked.map((p) => p.runId)).toEqual([4, 3, 2, 1]);
  });

  it('within a tier, the longer-running process (older startedAt) leads on a fill tie', () => {
    const older = proc({ runId: 1, startedAt: 100, contextTokens: null, contextWindow: null });
    const newer = proc({ runId: 2, startedAt: 900, contextTokens: null, contextWindow: null });
    const ranked = rankActivity([newer, older]);
    expect(ranked.map((p) => p.runId)).toEqual([1, 2]);
  });

  it('does not mutate its input', () => {
    const input = [proc({ runId: 1 }), proc({ runId: 2, escalated: true })];
    const copy = [...input];
    rankActivity(input);
    expect(input).toEqual(copy);
  });
});

describe('usageTotalTokens', () => {
  it('prefers the harness-reported total', () => {
    expect(usageTotalTokens(usage(4200))).toBe(4200);
  });
  it('sums the four counters when totalTokens is null', () => {
    const u: RunUsage = {
      models: {},
      totals: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalTokens: null },
      toolCalls: {},
      source: 'acp',
    };
    expect(usageTotalTokens(u)).toBe(100);
  });
  it('is null before any usage (never a fake zero)', () => {
    expect(usageTotalTokens(null)).toBeNull();
    expect(usageTotalTokens(usage(null))).toBeNull();
  });
});

describe('tokensPerSecond', () => {
  it('is tokens over elapsed seconds', () => {
    // 6000 tokens over 3s = 2000 tok/s
    expect(tokensPerSecond(proc({ startedAt: 1_000, usage: usage(6000) }), 4_000)).toBeCloseTo(2000);
  });
  it('is 0 before any tokens or before any elapsed time', () => {
    expect(tokensPerSecond(proc({ usage: usage(null) }), 5_000)).toBe(0);
    expect(tokensPerSecond(proc({ startedAt: 5_000, usage: usage(1000) }), 5_000)).toBe(0);
    expect(tokensPerSecond(proc({ startedAt: 9_000, usage: usage(1000) }), 5_000)).toBe(0); // clock skew
  });
});

describe('elapsedMs', () => {
  it('is now minus startedAt, floored at 0', () => {
    expect(elapsedMs(proc({ startedAt: 1_000 }), 4_000)).toBe(3_000);
    expect(elapsedMs(proc({ startedAt: 9_000 }), 4_000)).toBe(0);
  });
});

describe('sumCosts', () => {
  const c = (totalUsd: number | null, incomplete = false, byModel: Record<string, number | null> = {}): Cost => ({
    totalUsd,
    byModel,
    incomplete,
  });

  it('is null when nothing is priceable', () => {
    expect(sumCosts([null, undefined])).toBeNull();
  });
  it('sums priced totals', () => {
    expect(sumCosts([c(0.5), c(1.25)])?.totalUsd).toBeCloseTo(1.75);
  });
  it('a null-priced member makes the aggregate an incomplete floor', () => {
    const sum = sumCosts([c(0.5), c(null, true)]);
    expect(sum?.totalUsd).toBeCloseTo(0.5);
    expect(sum?.incomplete).toBe(true);
  });
  it('propagates an incomplete flag from any member', () => {
    expect(sumCosts([c(0.5, true), c(0.5)])?.incomplete).toBe(true);
  });
  it('merges per-model costs', () => {
    const sum = sumCosts([c(0.5, false, { 'sonnet-5': 0.5 }), c(0.25, false, { 'sonnet-5': 0.25, 'opus-4.8': 0.0 })]);
    expect(sum!.byModel['sonnet-5'] ?? 0).toBeCloseTo(0.75);
  });
});

describe('mergeRunUsage', () => {
  const event = (over: Partial<RunUsageEvent> = {}): RunUsageEvent => ({
    runId: 2,
    usage: usage(9999),
    contextTokens: 123,
    activity: 'Editing foo.ts',
    tree: { id: 's', name: 'root', model: 'sonnet-5', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 123, status: 'active', depth: 0, children: [] },
    cost: { totalUsd: 2.0, byModel: {}, incomplete: false },
    ...over,
  });

  it('updates the matching Run row in place (usage, context, activity, tree, cost)', () => {
    const before = [proc({ runId: 1 }), proc({ runId: 2, activity: null, contextTokens: null })];
    const after = mergeRunUsage(before, event());
    const merged = after.find((p) => p.runId === 2)!;
    expect(merged.activity).toBe('Editing foo.ts');
    expect(merged.contextTokens).toBe(123);
    expect(merged.cost?.totalUsd).toBe(2.0);
    expect(usageTotalTokens(merged.usage)).toBe(9999);
    // The untouched row is preserved.
    expect(after.find((p) => p.runId === 1)!.activity).toBeNull();
  });

  it('returns the same array reference when no row matches (no needless re-render)', () => {
    const before = [proc({ runId: 1 })];
    expect(mergeRunUsage(before, event({ runId: 99 }))).toBe(before);
  });

  it('never targets a chat row that happens to share the id space', () => {
    const chat = proc({ type: 'chat', runId: null, conversationId: 2, activity: null });
    const input = [chat];
    const after = mergeRunUsage(input, event({ runId: 2 }));
    expect(after).toBe(input); // no Run matched (a chat has no runId) → same reference
    expect(after[0]!.activity).toBeNull(); // chat untouched
  });
});

describe('activitySummary', () => {
  it('counts running Runs, needs-you rows, fleet cost, tok/s, and ceiling usage', () => {
    const now = 4_000;
    const procs = [
      proc({ runId: 1, type: 'run', startedAt: 1_000, usage: usage(6000), cost: { totalUsd: 1, byModel: {}, incomplete: false } }),
      proc({ runId: 2, type: 'run', escalated: true, startedAt: 2_000, usage: usage(3000), cost: { totalUsd: null, byModel: {}, incomplete: true } }),
      proc({ type: 'chat', runId: null, conversationId: 5, startedAt: 2_000, usage: usage(3000), cost: { totalUsd: 0.5, byModel: {}, incomplete: false } }),
    ];
    const s = activitySummary(procs, 4, now);
    expect(s.runningCount).toBe(2); // two Runs; the chat is not a Run
    expect(s.needsYouCount).toBe(1); // the escalated Run
    expect(s.ceiling).toEqual({ running: 2, max: 4 });
    // cost floor: 1 priced + 0.5 chat, with an unpriced member → incomplete
    expect(s.cost?.totalUsd).toBeCloseTo(1.5);
    expect(s.cost?.incomplete).toBe(true);
    // tok/s: 6000/3 + 3000/2 + 3000/2 = 2000 + 1500 + 1500 = 5000
    expect(s.tokensPerSecond).toBeCloseTo(5000);
  });

  it('an empty fleet is all zeros and a null cost', () => {
    const s = activitySummary([], 3, 1_000);
    expect(s).toEqual({ runningCount: 0, needsYouCount: 0, cost: null, tokensPerSecond: 0, ceiling: { running: 0, max: 3 } });
  });
});
