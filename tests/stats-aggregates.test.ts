import { describe, it, expect } from 'vitest';
import {
  attemptsPerTask,
  byWorkspace,
  costPerMergedTask,
  gateOutcomes,
  guardrailTripsByDimension,
  tasksMergedByDay,
  verdicts,
  type WorkspaceAttempt,
} from '../src/server/stats-aggregates.js';
import type { GateReason, SettleEventRow, SettledTaskAttempt } from '../src/db/stats-reader.js';

const merged = (taskId: number, ts: number): SettleEventRow => ({ taskId, ts, kind: 'merged', gate: null });
const escalated = (taskId: number, ts: number, gate: GateReason | null = null): SettleEventRow => ({
  taskId,
  ts,
  kind: 'escalated',
  gate,
});
const att = (taskId: number): SettledTaskAttempt => ({ taskId, cost: null });
const cost = (usd: number | null, model = 'sonnet-5'): string =>
  JSON.stringify({ totalUsd: usd, byModel: { [model]: usd }, incomplete: usd === null });
const usage = (input: number, output: number): string =>
  JSON.stringify({
    models: {},
    totals: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
    toolCalls: {},
    source: 'acp',
  });

// A local-day timestamp helper, tz-independent: noon on the given calendar day.
const dayAt = (y: number, m: number, d: number, h = 12): number => new Date(y, m, d, h, 0, 0).getTime();

describe('tasksMergedByDay (ADR-0014 §1)', () => {
  it('buckets a merge by its merge-event day and counts each Task once', () => {
    const jan15 = dayAt(2026, 0, 15);
    const jan16 = dayAt(2026, 0, 16);
    const series = tasksMergedByDay([merged(1, jan15), merged(2, jan15), merged(3, jan16)]);
    expect(series).toEqual([
      { day: new Date(jan15).setHours(0, 0, 0, 0), count: 2 },
      { day: new Date(jan16).setHours(0, 0, 0, 0), count: 1 },
    ]);
  });

  it('counts a self-healed Task once, on its merge day — an earlier escalation is not a settle', () => {
    const jan15 = dayAt(2026, 0, 15);
    const series = tasksMergedByDay([escalated(1, jan15 - 1000), merged(1, jan15)]);
    expect(series).toEqual([{ day: new Date(jan15).setHours(0, 0, 0, 0), count: 1 }]);
  });

  it('omits days with no merges and excludes never-merged Tasks', () => {
    const jan15 = dayAt(2026, 0, 15);
    expect(tasksMergedByDay([escalated(1, jan15)])).toEqual([]);
  });
});

describe('attemptsPerTask (ADR-0014 §2)', () => {
  it('buckets by Attempts-to-settle over merged Tasks; a 3-Attempt merged Task lands in 3×', () => {
    const settle = [escalated(1, 100), escalated(1, 200), merged(1, 300)];
    const attempts = [att(1), att(1), att(1)];
    expect(attemptsPerTask(settle, attempts)).toEqual({ '1': 0, '2': 0, '3': 1, '4+': 0 });
  });

  it('buckets first-try merges in 1× and 4-or-more in 4+', () => {
    const settle = [merged(1, 10), merged(2, 20)];
    const attempts = [att(1), att(2), att(2), att(2), att(2), att(2)];
    expect(attemptsPerTask(settle, attempts)).toEqual({ '1': 1, '2': 0, '3': 0, '4+': 1 });
  });

  it('excludes escalated (non-merged) Tasks even when their attempts are present', () => {
    const settle = [escalated(9, 10)];
    const attempts = [att(9), att(9)];
    expect(attemptsPerTask(settle, attempts)).toEqual({ '1': 0, '2': 0, '3': 0, '4+': 0 });
  });
});

describe('costPerMergedTask (ADR-0014 §3)', () => {
  it('sums merged spend over merged Tasks and reports reverted/abandoned spend as wasted', () => {
    const settle = [merged(1, 100), escalated(2, 100, 'post-merge-red'), escalated(3, 100)];
    const attempts = [
      { taskId: 1, cost: cost(2) },
      { taskId: 1, cost: cost(1) },
      { taskId: 2, cost: cost(4) },
      { taskId: 3, cost: cost(1.5) },
    ];
    const result = costPerMergedTask(settle, attempts);
    expect(result.mergedTasks).toBe(1);
    expect(result.mergedCost?.totalUsd).toBeCloseTo(3);
    expect(result.wastedCost?.totalUsd).toBeCloseTo(5.5);
  });

  it('null-sticks an unpriceable attempt (a floor, never a fake zero) per ADR-0008', () => {
    const settle = [merged(1, 100)];
    const attempts = [{ taskId: 1, cost: cost(2) }, { taskId: 1, cost: cost(null) }];
    const result = costPerMergedTask(settle, attempts);
    expect(result.mergedCost?.incomplete).toBe(true);
  });

  it('leaves cost null when nothing in range could be priced', () => {
    expect(costPerMergedTask([], []).mergedCost).toBeNull();
  });
});

describe('verdicts (ADR-0014 §4)', () => {
  it('counts critic verdicts (fail → block) and keeps command verdicts separate', () => {
    const result = verdicts([
      { mechanism: 'critic', verdict: 'pass' },
      { mechanism: 'critic', verdict: 'fail' },
      { mechanism: 'critic', verdict: 'inconclusive' },
      { mechanism: 'command', verdict: 'pass' },
      { mechanism: 'command', verdict: 'pass' },
    ]);
    expect(result.critic).toEqual({ pass: 1, block: 1, inconclusive: 1 });
    expect(result.command).toEqual({ pass: 2, block: 0, inconclusive: 0 });
  });
});

describe('gateOutcomes (ADR-0014 §5)', () => {
  it('classifies settled Tasks by their terminal gate; reverted-on-red is its own bucket', () => {
    const result = gateOutcomes([
      merged(1, 10),
      merged(2, 10),
      escalated(3, 10, 'conflict'),
      escalated(4, 10, 'post-merge-red'),
      escalated(5, 10),
    ]);
    expect(result).toEqual({ autoMerged: 2, escalated: 2, revertedOnRed: 1 });
  });

  it('counts a self-healed Task once, as auto-merged (terminal wins over its earlier escalation)', () => {
    expect(gateOutcomes([escalated(1, 100), merged(1, 200)])).toEqual({
      autoMerged: 1,
      escalated: 0,
      revertedOnRed: 0,
    });
  });
});

describe('guardrailTripsByDimension (ADR-0014 §6)', () => {
  it('counts an Attempt that tripped two dimensions in both', () => {
    const trips = [
      { attemptId: 1, dimension: 'tokens' },
      { attemptId: 1, dimension: 'wall-clock' },
      { attemptId: 2, dimension: 'tokens' },
    ];
    expect(guardrailTripsByDimension(trips)).toEqual({ tokens: 2, 'wall-clock': 1 });
  });
});

describe('byWorkspace (ADR-0014 §7)', () => {
  const workspaces = [
    { id: 1, name: 'alpha' },
    { id: 2, name: 'beta' },
  ];
  const taskWorkspaces = [
    { taskId: 10, workspaceId: 1 },
    { taskId: 11, workspaceId: 1 },
    { taskId: 20, workspaceId: 2 },
  ];

  it('groups attempts by owning Workspace, splits tokens, and orders by cost', () => {
    const rows: WorkspaceAttempt[] = [
      { taskId: 10, state: 'passed', usage: usage(100, 20), cost: cost(1) },
      { taskId: 11, state: 'failed', usage: usage(50, 10), cost: cost(1) },
      { taskId: 20, state: 'passed', usage: usage(10, 5), cost: cost(9) },
    ];
    const result = byWorkspace(rows, taskWorkspaces, workspaces);
    expect(result.map((r) => r.workspaceId)).toEqual([2, 1]);
    const alpha = result.find((r) => r.workspaceId === 1)!;
    expect(alpha).toMatchObject({ name: 'alpha', inputTokens: 150, outputTokens: 30, tasks: 2 });
    expect(alpha.cost?.totalUsd).toBeCloseTo(2);
    expect(alpha.failureRate).toBeCloseTo(0.5);
  });

  it('returns a single row when the rows were already scoped to one Workspace', () => {
    const rows: WorkspaceAttempt[] = [{ taskId: 20, state: 'passed', usage: null, cost: cost(9) }];
    const result = byWorkspace(rows, taskWorkspaces, workspaces);
    expect(result).toHaveLength(1);
    expect(result[0]?.workspaceId).toBe(2);
  });

  it('reports a null failure rate for a Workspace whose attempts were all cancelled', () => {
    const rows: WorkspaceAttempt[] = [{ taskId: 10, state: 'cancelled', usage: null, cost: null }];
    const result = byWorkspace(rows, taskWorkspaces, workspaces);
    expect(result[0]?.failureRate).toBeNull();
  });
});
