import type { AttemptState } from '../db/schema.js';
import type { StatsRange, StatsReadResult } from '../db/stats-reader.js';
import { mergeUsage, type AttemptUsage } from '../execution/usage.js';
import { activeExecutionDurationMs, durationPercentiles } from './attempt-duration.js';
import { failuresByReason, isExecutionFailure } from './attempt-failure.js';
import { parseCost, sumCosts } from './pricing.js';
import {
  attemptsPerTask,
  byWorkspace,
  costPerMergedTask,
  gateOutcomes,
  guardrailTripsByDimension,
  tasksMergedByDay,
  verdicts,
} from './stats-aggregates.js';
import { buildDaySeries } from './stats-series.js';

function statsAttemptState(state: AttemptState): 'running' | 'completed' | 'failed' | 'cancelled' {
  if (state === 'passed') return 'completed';
  if (state === 'escalated') return 'failed';
  return state;
}

export function aggregateStats(
  { rows, attemptReasons, toolTotals, workspaces, taskWorkspaces, settleEvents, settledTaskAttempts, verifications, guardrailTrips }: StatsReadResult,
  { from, to }: StatsRange,
) {
  const attemptReasonById = new Map(attemptReasons.map((r) => [r.attemptId, r.reason]));
  const usages = rows
    .map((run) => (run.usage ? (JSON.parse(run.usage) as AttemptUsage) : null))
    .filter((u): u is AttemptUsage => u !== null);
  const merged = mergeUsage(usages);
  const toolCalls: Record<string, number> = {};
  for (const totals of Object.values(toolTotals.byTask)) {
    for (const [toolName, count] of Object.entries(totals)) toolCalls[toolName] = (toolCalls[toolName] ?? 0) + count;
  }

  const attemptsByState: Record<string, number> = {};
  for (const run of rows) {
    const state = statsAttemptState(run.state);
    attemptsByState[state] = (attemptsByState[state] ?? 0) + 1;
  }

  const failures = rows.filter(isExecutionFailure);
  const failedAttempts = failures.length;
  const failReasons = failuresByReason(
    failures.map((r) => ({ attemptReason: attemptReasonById.get(r.id) ?? null, detailReason: r.reason })),
  );

  const durations = rows
    .map((r) =>
      activeExecutionDurationMs({
        startedAt: r.startedAt,
        finishedAt: r.endedAt,
        agentDurationMs: r.agentDurationMs,
      }),
    )
    .filter((d): d is number => d !== null);
  const durationMs = durationPercentiles(durations);

  const costOfAttempts = (attempts: typeof rows) => sumCosts(attempts.map((run) => parseCost(run.cost)));
  const series = buildDaySeries(rows, costOfAttempts);
  const cost = costOfAttempts(rows);
  const flooredCost =
    cost && !cost.incomplete && series.some((s) => s.totalUsd === null) ? { ...cost, incomplete: true } : cost;

  return {
    from,
    to,
    attemptCount: rows.length,
    attemptsByState,
    failedAttempts,
    failuresByReason: failReasons,
    durationMs,
    totals: merged?.totals ?? null,
    models: merged?.models ?? {},
    agents: merged?.agents ?? {},
    ...(merged?.toolTokens ? { toolTokens: merged.toolTokens } : {}),
    ...(merged?.reasoning ? { reasoning: merged.reasoning } : {}),
    toolCalls,
    cost: flooredCost,
    series,
    tasksMergedByDay: tasksMergedByDay(settleEvents),
    attemptsPerTask: attemptsPerTask(settleEvents, settledTaskAttempts),
    costPerMergedTask: costPerMergedTask(settleEvents, settledTaskAttempts),
    verdicts: verdicts(verifications),
    gateOutcomes: gateOutcomes(settleEvents),
    guardrailTrips: guardrailTripsByDimension(guardrailTrips),
    byWorkspace: byWorkspace(rows, taskWorkspaces, workspaces),
  };
}
