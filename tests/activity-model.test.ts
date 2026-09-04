import { describe, expect, it } from 'vitest';
import {
  activitySummary,
  activityWorkspaces,
  contextFillFraction,
  elapsedMs,
  fleetLanes,
  filterActivity,
  mergeRunUsage,
  resolveActivityFilter,
  sumCosts,
  tokensPerSecond,
  usageTotalTokens,
} from '../web/src/activity-model.js';
import type { ActivityProcess, Cost, AttemptUsage, AttemptUsageEvent } from '../web/src/types.js';

function usage(total: number | null, extra: Partial<AttemptUsage> = {}): AttemptUsage {
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
    type: 'attempt',
    attemptId: 1,
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

describe('filterActivity', () => {
  const run = proc({ type: 'attempt', attemptId: 1, workspaceId: 1, workspaceName: 'harmonic' });
  const chat = proc({ type: 'chat', attemptId: null, conversationId: 7, workspaceId: 2, workspaceName: 'sidecar' });

  it('keeps everything under the "all" type + no workspace', () => {
    expect(filterActivity([run, chat], { type: 'all', workspaceId: null })).toEqual([run, chat]);
  });
  it('narrows to Runs', () => {
    expect(filterActivity([run, chat], { type: 'attempts', workspaceId: null })).toEqual([run]);
  });
  it('narrows to Chats', () => {
    expect(filterActivity([run, chat], { type: 'chats', workspaceId: null })).toEqual([chat]);
  });
  it('narrows to a single Workspace', () => {
    expect(filterActivity([run, chat], { type: 'all', workspaceId: 2 })).toEqual([chat]);
  });
  it('combines type and workspace (an empty intersection is honest)', () => {
    expect(filterActivity([run, chat], { type: 'attempts', workspaceId: 2 })).toEqual([]);
  });
});

describe('fleetLanes', () => {
  it('orders roots by context fill and shows direct subagents beneath their root', () => {
    const cool = proc({ attemptId: 1, contextTokens: 10_000, contextWindow: 200_000, tree: { id: 'root', name: 'root', model: 'sonnet-5', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 10_000, lastTool: null, status: 'active', depth: 0, toolUseId: null, children: [{ id: 'child', name: 'child', model: 'sonnet-5', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 1, lastTool: null, status: 'active', depth: 1, toolUseId: 'tool', children: [{ id: 'grandchild', name: 'grandchild', model: 'sonnet-5', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 1, lastTool: null, status: 'active', depth: 2, toolUseId: 'nested-tool', children: [] }] }] } });
    const hot = proc({ attemptId: 2, contextTokens: 180_000, contextWindow: 200_000 });
    expect(fleetLanes([cool, hot]).map((lane) => [lane.process.attemptId, lane.depth])).toEqual([[2, 0], [1, 0], [1, 1]]);
  });
});

describe('activityWorkspaces', () => {
  it('lists the distinct Workspaces present, sorted by name', () => {
    const procs = [
      proc({ attemptId: 1, workspaceId: 2, workspaceName: 'sidecar' }),
      proc({ attemptId: 2, workspaceId: 1, workspaceName: 'harmonic' }),
      proc({ attemptId: 3, workspaceId: 2, workspaceName: 'sidecar' }),
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
    const filter = { type: 'attempts' as const, workspaceId: null };
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

describe('usageTotalTokens', () => {
  it('prefers the harness-reported total', () => {
    expect(usageTotalTokens(usage(4200))).toBe(4200);
  });
  it('sums the four counters when totalTokens is null', () => {
    const u: AttemptUsage = {
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
    expect(tokensPerSecond(proc({ startedAt: 1_000, usage: usage(6000) }), 4_000)).toBeCloseTo(2000);
  });
  it('is 0 before any tokens or before any elapsed time', () => {
    expect(tokensPerSecond(proc({ usage: usage(null) }), 5_000)).toBe(0);
    expect(tokensPerSecond(proc({ startedAt: 5_000, usage: usage(1000) }), 5_000)).toBe(0);
    expect(tokensPerSecond(proc({ startedAt: 9_000, usage: usage(1000) }), 5_000)).toBe(0);
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
  const event = (over: Partial<AttemptUsageEvent> = {}): AttemptUsageEvent => ({
    attemptId: 2,
    usage: usage(9999),
    contextTokens: 123,
    activity: 'Editing foo.ts',
    tree: { id: 's', name: 'root', model: 'sonnet-5', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 123, lastTool: null, status: 'active', depth: 0, toolUseId: null, children: [] },
    cost: { totalUsd: 2.0, byModel: {}, incomplete: false },
    ...over,
  });

  it('updates the matching Run row in place (usage, context, activity, tree, cost)', () => {
    const before = [proc({ attemptId: 1 }), proc({ attemptId: 2, activity: null, contextTokens: null })];
    const after = mergeRunUsage(before, event());
    const merged = after.find((p) => p.attemptId === 2)!;
    expect(merged.activity).toBe('Editing foo.ts');
    expect(merged.contextTokens).toBe(123);
    expect(merged.cost?.totalUsd).toBe(2.0);
    expect(usageTotalTokens(merged.usage)).toBe(9999);
    expect(after.find((p) => p.attemptId === 1)!.activity).toBeNull();
  });

  it('returns the same array reference when no row matches (no needless re-render)', () => {
    const before = [proc({ attemptId: 1 })];
    expect(mergeRunUsage(before, event({ attemptId: 99 }))).toBe(before);
  });

  it('never targets a chat row that happens to share the id space', () => {
    const chat = proc({ type: 'chat', attemptId: null, conversationId: 2, activity: null });
    const input = [chat];
    const after = mergeRunUsage(input, event({ attemptId: 2 }));
    expect(after).toBe(input);
    expect(after[0]!.activity).toBeNull();
  });

  it('preserves the object reference of every unchanged Run row (lets React.memo skip them)', () => {
    const r1 = proc({ attemptId: 1 });
    const r2 = proc({ attemptId: 2, activity: null });
    const before = [r1, r2];
    const after = mergeRunUsage(before, event({ attemptId: 2 }));
    expect(after).not.toBe(before);
    expect(after.find((p) => p.attemptId === 1)!).toBe(r1);
    expect(after.find((p) => p.attemptId === 2)!).not.toBe(r2);
  });
});

describe('activitySummary', () => {
  it('counts Agents, Subagents, fleet cost, tok/s, and ceiling usage', () => {
    const now = 4_000;
    const procs = [
      proc({ attemptId: 1, type: 'attempt', startedAt: 1_000, usage: usage(6000), tree: { id: 'root', name: 'root', model: 'sonnet-5', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 1, lastTool: null, status: 'active', depth: 0, toolUseId: null, children: [{ id: 'child', name: 'child', model: 'sonnet-5', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 1, lastTool: null, status: 'active', depth: 1, toolUseId: 'tool', children: [] }] }, cost: { totalUsd: 1, byModel: {}, incomplete: false } }),
      proc({ attemptId: 2, type: 'attempt', escalated: true, startedAt: 2_000, usage: usage(3000), cost: { totalUsd: null, byModel: {}, incomplete: true } }),
      proc({ type: 'chat', attemptId: null, conversationId: 5, startedAt: 2_000, usage: usage(3000), cost: { totalUsd: 0.5, byModel: {}, incomplete: false } }),
    ];
    const s = activitySummary(procs, 4, now);
    expect(s.agentCount).toBe(3);
    expect(s.subagentCount).toBe(1);
    expect(s.runningCount).toBe(2);
    expect(s.ceiling).toEqual({ running: 2, max: 4 });
    expect(s.cost?.totalUsd).toBeCloseTo(1.5);
    expect(s.cost?.incomplete).toBe(true);
    expect(s.tokensPerSecond).toBeCloseTo(5000);
  });

  it('an empty fleet is all zeros and a null cost', () => {
    const s = activitySummary([], 3, 1_000);
    expect(s).toEqual({ agentCount: 0, subagentCount: 0, runningCount: 0, cost: null, tokensPerSecond: 0, ceiling: { running: 0, max: 3 } });
  });
});
