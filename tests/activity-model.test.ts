import { describe, expect, it } from 'vitest';
import {
  activitySections,
  activitySummary,
  activityWorkspaces,
  attentionTier,
  ATTENTION_TIERS,
  contextFillFraction,
  elapsedMs,
  filterActivity,
  HIGH_LOAD_FILL,
  mergeRunUsage,
  rankActivity,
  resolveActivityFilter,
  sortActivity,
  sortLabel,
  ACTIVITY_SORTS,
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
    trackerUrl: null,
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

describe('filterActivity', () => {
  const run = proc({ type: 'run', runId: 1, workspaceId: 1, workspaceName: 'harmonic' });
  const chat = proc({ type: 'chat', runId: null, conversationId: 7, workspaceId: 2, workspaceName: 'sidecar' });

  it('keeps everything under the "all" type + no workspace', () => {
    expect(filterActivity([run, chat], { type: 'all', workspaceId: null })).toEqual([run, chat]);
  });
  it('narrows to Runs', () => {
    expect(filterActivity([run, chat], { type: 'runs', workspaceId: null })).toEqual([run]);
  });
  it('narrows to Chats', () => {
    expect(filterActivity([run, chat], { type: 'chats', workspaceId: null })).toEqual([chat]);
  });
  it('narrows to a single Workspace', () => {
    expect(filterActivity([run, chat], { type: 'all', workspaceId: 2 })).toEqual([chat]);
  });
  it('combines type and workspace (an empty intersection is honest)', () => {
    expect(filterActivity([run, chat], { type: 'runs', workspaceId: 2 })).toEqual([]);
  });
});

describe('activityWorkspaces', () => {
  it('lists the distinct Workspaces present, sorted by name', () => {
    const procs = [
      proc({ runId: 1, workspaceId: 2, workspaceName: 'sidecar' }),
      proc({ runId: 2, workspaceId: 1, workspaceName: 'harmonic' }),
      proc({ runId: 3, workspaceId: 2, workspaceName: 'sidecar' }),
    ];
    expect(activityWorkspaces(procs)).toEqual([
      { id: 1, name: 'harmonic' },
      { id: 2, name: 'sidecar' },
    ]);
  });
  it('is empty for an empty fleet', () => {
    expect(activityWorkspaces([])).toEqual([]);
  });
});

describe('resolveActivityFilter', () => {
  const workspaces = [
    { id: 1, name: 'harmonic' },
    { id: 2, name: 'sidecar' },
  ];
  it('leaves a filter with no Workspace untouched', () => {
    const filter = { type: 'runs' as const, workspaceId: null };
    expect(resolveActivityFilter(filter, workspaces)).toBe(filter);
  });
  it('keeps a Workspace filter that still matches a live Workspace', () => {
    const filter = { type: 'all' as const, workspaceId: 2 };
    expect(resolveActivityFilter(filter, workspaces)).toBe(filter);
  });
  it('drops a Workspace filter whose Workspace has drained out, preserving type', () => {
    expect(resolveActivityFilter({ type: 'chats', workspaceId: 9 }, workspaces)).toEqual({
      type: 'chats',
      workspaceId: null,
    });
  });
  it('drops a Workspace filter when the fleet is empty', () => {
    expect(resolveActivityFilter({ type: 'all', workspaceId: 1 }, [])).toEqual({ type: 'all', workspaceId: null });
  });
});

describe('sortActivity', () => {
  it('"attention" defers to rankActivity', () => {
    const steady = proc({ runId: 1, contextTokens: 10_000, contextWindow: 200_000 });
    const needs = proc({ runId: 2, escalated: true });
    expect(sortActivity([steady, needs], 'attention', 0)).toEqual(rankActivity([steady, needs]));
  });

  it('"cost" orders by priced total desc, with the Needs-you tier pinned above', () => {
    const cheap = proc({ runId: 1, cost: { totalUsd: 0.1, byModel: {}, incomplete: false } });
    const dear = proc({ runId: 2, cost: { totalUsd: 9.0, byModel: {}, incomplete: false } });
    const needsCheap = proc({ runId: 3, escalated: true, cost: { totalUsd: 0.01, byModel: {}, incomplete: false } });
    // Escalated row stays on top even though it is the cheapest.
    expect(sortActivity([cheap, dear, needsCheap], 'cost', 0).map((p) => p.runId)).toEqual([3, 2, 1]);
  });

  it('"tokens" orders by total tokens desc, unknown last', () => {
    const many = proc({ runId: 1, usage: usage(9000) });
    const few = proc({ runId: 2, usage: usage(100) });
    const none = proc({ runId: 3, usage: usage(null) });
    expect(sortActivity([few, none, many], 'tokens', 0).map((p) => p.runId)).toEqual([1, 2, 3]);
  });

  it('"context" orders by fill desc, unconfigured window last', () => {
    const full = proc({ runId: 1, contextTokens: 180_000, contextWindow: 200_000 });
    const light = proc({ runId: 2, contextTokens: 20_000, contextWindow: 200_000 });
    const unknown = proc({ runId: 3, contextTokens: null, contextWindow: null });
    expect(sortActivity([light, unknown, full], 'context', 0).map((p) => p.runId)).toEqual([1, 2, 3]);
  });

  it('"elapsed" orders by longest-running first', () => {
    const old = proc({ runId: 1, startedAt: 100 });
    const mid = proc({ runId: 2, startedAt: 500 });
    const fresh = proc({ runId: 3, startedAt: 900 });
    expect(sortActivity([fresh, old, mid], 'elapsed', 1_000).map((p) => p.runId)).toEqual([1, 2, 3]);
  });

  it('does not mutate its input', () => {
    const input = [proc({ runId: 1, escalated: true }), proc({ runId: 2 })];
    const copy = [...input];
    sortActivity(input, 'cost', 0);
    expect(input).toEqual(copy);
  });

  it('every sort has a human label', () => {
    for (const s of ACTIVITY_SORTS) expect(sortLabel(s)).toMatch(/\w/);
  });
});

describe('activitySections', () => {
  it('under "attention", groups into non-empty tier bands with Needs-you pinned', () => {
    const steady = proc({ runId: 1, contextTokens: 10_000, contextWindow: 200_000 });
    const needs = proc({ runId: 2, escalated: true });
    const sections = activitySections([steady, needs], 'attention', 0);
    expect(sections.map((s) => s.key)).toEqual(['needs-you', 'steady']); // high-load empty → dropped
    expect(sections[0]!.pinned).toBe(true);
    expect(sections[0]!.rows.map((p) => p.runId)).toEqual([2]);
  });

  it('under a metric sort, pins Needs-you above one sorted section', () => {
    const dear = proc({ runId: 1, cost: { totalUsd: 9, byModel: {}, incomplete: false } });
    const cheap = proc({ runId: 2, cost: { totalUsd: 1, byModel: {}, incomplete: false } });
    const needs = proc({ runId: 3, escalated: true, cost: { totalUsd: 0.01, byModel: {}, incomplete: false } });
    const sections = activitySections([cheap, dear, needs], 'cost', 0);
    expect(sections.map((s) => s.key)).toEqual(['needs-you', 'sorted']);
    expect(sections[0]!.pinned).toBe(true);
    expect(sections[0]!.rows.map((p) => p.runId)).toEqual([3]);
    expect(sections[1]!.rows.map((p) => p.runId)).toEqual([1, 2]); // dear before cheap
  });

  it('under a metric sort with no escalations, is a single sorted section', () => {
    const dear = proc({ runId: 1, cost: { totalUsd: 9, byModel: {}, incomplete: false } });
    const cheap = proc({ runId: 2, cost: { totalUsd: 1, byModel: {}, incomplete: false } });
    const sections = activitySections([cheap, dear], 'cost', 0);
    expect(sections.map((s) => s.key)).toEqual(['sorted']);
    expect(sections[0]!.rows.map((p) => p.runId)).toEqual([1, 2]);
  });

  it('an empty fleet has no sections', () => {
    expect(activitySections([], 'attention', 0)).toEqual([]);
    expect(activitySections([], 'cost', 0)).toEqual([]);
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
