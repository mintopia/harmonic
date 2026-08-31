import { useEffect, useState, type ReactNode } from 'react';
import { formatAvgCostPerRun, formatCost, usd } from '../cost';
import { api } from '../api';
import { card, displayTitle, labelType, tableHead } from '../ui';
import {
  cacheHitRate,
  failureRate,
  orderedFailureReasons,
  reliabilityStates,
  subagentShare,
  usageBars,
  type Stats,
} from '../stats-model';
import { fmtDuration } from '../format-duration';
import { CostBars } from './CostBars';
import { CumulativeCurve } from './CumulativeCurve';
import { BarChart, type Bar } from './BarChart';
import { Donut, type DonutSegment } from './Donut';
import { fillSeries, METRIC_LABEL, type StatMetric } from './costChart-model';
import { EmptyState } from './EmptyState';
import { AttemptHeatmap } from './AttemptHeatmap';
import { FlowThroughput } from './FlowThroughput';

const STATE_DONUT_COLOR: Record<string, string> = {
  running: 'var(--hm-running-dot)',
  completed: 'var(--hm-merged-dot)',
  failed: 'var(--hm-fail-dot)',
  cancelled: 'var(--hm-faint)',
};

const TOOL_TOKEN_COLORS = [
  'var(--hm-accent)',
  'var(--hm-ink)',
  'var(--hm-muted)',
  'var(--hm-faint)',
  'var(--hm-edge-strong)',
];

/** Friendly labels for the failures-by-reason buckets (the winning terminal
 * disposition). Any bucket not mapped falls back to its raw key, so a newer
 * disposition still renders rather than vanishing. */
const REASON_LABEL: Record<string, string> = {
  failed: 'Error',
  escalate: 'Escalated',
  'process-death': 'Interrupted',
  'guardrail-trip': 'Guardrail',
  'verify-fail': 'Verification',
  'branch-violation': 'Branch',
  'agent-finish/unresolved': 'Unresolved',
  unknown: 'Unknown',
};

const RANGES: Record<string, number | null> = {
  '24 hours': 24 * 3600_000,
  '7 days': 7 * 24 * 3600_000,
  '30 days': 30 * 24 * 3600_000,
  'All time': null,
};

const METRICS: Record<string, StatMetric> = { USD: 'usd', Tokens: 'tokens', Attempts: 'attempts' };

const fmt = (n: number) => n.toLocaleString();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-md bg-raised p-0.5" role="group" aria-label={ariaLabel}>
      {options.map(({ label, value: v }) => (
        <button
          key={label}
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className={`rounded-sm px-2.5 py-1.5 transition-colors duration-150 ${
            v === value ? 'bg-surface font-semibold text-ink shadow-card' : 'font-medium text-muted hover:text-ink'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function StatLabel({ children }: { children: ReactNode }) {
  return <div className={`${labelType} mb-1.5 text-muted`}>{children}</div>;
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <StatLabel>{label}</StatLabel>
      <div className={`text-title font-semibold tabular-nums ${value === '—' ? 'text-faint' : 'text-ink'}`}>
        {value}
      </div>
    </div>
  );
}

export function StatsPage({ workspaceId }: { workspaceId: number | null }) {
  const [range, setRange] = useState('7 days');
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<StatMetric>('usd');

  useEffect(() => {
    if (workspaceId === null) return;
    const span = RANGES[range] ?? null;
    const from = span === null ? 0 : Date.now() - span;
    let cancelled = false;
    setError(null);
    api
      .stats(from, Date.now(), workspaceId)
      .then((s) => !cancelled && setStats(s))
      .catch((e) => {
        if (cancelled) return;
        setStats(null);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [range, workspaceId]);

  const filled = stats ? fillSeries(stats.series, stats.from, stats.to) : [];
  const costText = stats ? formatCost(stats.cost) : null;
  const share = stats ? subagentShare(stats.agents) : null;
  const pct = (r: number | null) => (r == null ? '—' : `${Math.round(r * 100)}%`);
  const cacheHit = stats ? cacheHitRate(stats.totals) : null;
  const failRate = stats ? failureRate(stats.failedAttempts, stats.attemptCount) : null;
  const avgCostText = stats ? formatAvgCostPerRun(stats.cost, stats.attemptCount) : null;
  const medDuration = stats?.durationMs ? fmtDuration(stats.durationMs.p50) : null;
  const modelBars: Bar[] = stats
    ? usageBars(stats.models).map((b) => {
        const c = stats.cost?.byModel[b.key];
        return {
          key: b.key,
          value: b.tokens,
          valueLabel: c == null ? compact.format(b.tokens) : `${compact.format(b.tokens)} · ${usd(c)}`,
        };
      })
    : [];
  const agentBars: Bar[] = stats?.agents
    ? usageBars(stats.agents).map((b) => ({ key: b.key, value: b.tokens, valueLabel: compact.format(b.tokens) }))
    : [];
  const toolBars: Bar[] = stats
    ? Object.entries(stats.toolCalls)
        .map(([key, count]) => ({ key, value: count, valueLabel: fmt(count) }))
        .sort((a, b) => b.value - a.value)
    : [];
  const reliabilitySegments: DonutSegment[] = stats
    ? reliabilityStates(stats.attemptsByState, stats.failedAttempts).map(({ state, count }) => ({
        key: state,
        label: state,
        value: count,
        color: STATE_DONUT_COLOR[state] ?? 'var(--hm-edge)',
      }))
    : [];
  const toolTokenSegments: DonutSegment[] = stats
    ? [
        ...Object.entries(stats.toolTokens ?? {})
          .filter(([, attribution]) => attribution.outputTokens > 0)
          .sort(([, a], [, b]) => b.outputTokens - a.outputTokens)
          .map(([key, attribution], index) => ({
            key,
            value: attribution.outputTokens,
            valueLabel:
              attribution.cost === undefined
                ? compact.format(attribution.outputTokens)
                : `${compact.format(attribution.outputTokens)} · ${usd(attribution.cost)}`,
            color: TOOL_TOKEN_COLORS[index % TOOL_TOKEN_COLORS.length]!,
          })),
        ...(stats.reasoning && stats.reasoning.outputTokens > 0
          ? [
              {
                key: 'reasoning',
                label: 'Reasoning',
                value: stats.reasoning.outputTokens,
                valueLabel:
                  stats.reasoning.cost === undefined
                    ? compact.format(stats.reasoning.outputTokens)
                    : `${compact.format(stats.reasoning.outputTokens)} · ${usd(stats.reasoning.cost)}`,
                color: 'var(--hm-muted)',
              },
            ]
          : []),
      ]
    : [];
  const toolTokenTotal = toolTokenSegments.reduce((sum, segment) => sum + segment.value, 0);
  const reasonBars: Bar[] = stats
    ? orderedFailureReasons(stats.failuresByReason).map(({ reason, count }) => ({
        key: reason,
        label: REASON_LABEL[reason] ?? reason,
        value: count,
        valueLabel: fmt(count),
      }))
    : [];
  // Fails/day: the failed-only count spread across the span of days that
  // actually held runs (first to last bucket, inclusive), not the raw request
  // window — so "All time" (from epoch 0) reads as an honest daily rate rather
  // than a near-zero one. Null with no runs.
  const DAY_MS = 24 * 3600_000;
  const dataDays =
    stats && stats.series.length > 0
      ? Math.max(1, Math.round((stats.series[stats.series.length - 1]!.day - stats.series[0]!.day) / DAY_MS) + 1)
      : 0;
  const failsPerDay = dataDays > 0 ? stats!.failedAttempts / dataDays : null;
  const cancelledRuns = stats?.attemptsByState.cancelled ?? 0;
  const durP50 = stats?.durationMs ? fmtDuration(stats.durationMs.p50) : null;
  const durP95 = stats?.durationMs ? fmtDuration(stats.durationMs.p95) : null;
  const failsTotal = filled.reduce((sum, s) => sum + (s.fails ?? 0), 0);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className={displayTitle}>Usage &amp; statistics</h1>
        <div className="flex-1" />
        <SegmentedControl
          ariaLabel="Time range"
          options={Object.keys(RANGES).map((r) => ({ label: r, value: r }))}
          value={range}
          onChange={setRange}
        />
      </div>

      {workspaceId !== null && <AttemptHeatmap workspaceId={workspaceId} />}

      {error && (
        <p className="rounded-lg bg-fail-tint px-4 py-2 text-fail">Couldn’t load statistics: {error}</p>
      )}

      {!stats && !error && <div className={`${card} p-5 text-muted`}>Loading…</div>}

      {stats && stats.attemptCount === 0 && (
        <EmptyState title="No runs to chart yet">
          Cost, tokens, and the per-model breakdown appear here once an agent has run. If you’ve run
          tasks before, try a wider range.
        </EmptyState>
      )}

      {stats && stats.attemptCount > 0 && (
        <>
          <div className="mb-5">
            <StatLabel>Cost · {range}</StatLabel>
            <div
              className={`text-hero font-display-weight tabular-nums ${costText == null ? 'text-faint' : 'text-ink'}`}
            >
              {costText ?? '—'}
            </div>
          </div>

          <div className={`${card} mb-4 grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:grid-cols-3 lg:grid-cols-5`}>
            <SummaryCell label="Attempts" value={fmt(stats.attemptCount)} />
            <SummaryCell label="Tokens in" value={stats.totals ? compact.format(stats.totals.inputTokens) : '—'} />
            <SummaryCell label="Tokens out" value={stats.totals ? compact.format(stats.totals.outputTokens) : '—'} />
            <SummaryCell label="Cache read" value={stats.totals ? compact.format(stats.totals.cacheReadTokens) : '—'} />
            <SummaryCell label="Cache write" value={stats.totals ? compact.format(stats.totals.cacheWriteTokens) : '—'} />
            <SummaryCell label="Cache hit rate" value={pct(cacheHit)} />
            <SummaryCell label="Failure rate" value={pct(failRate)} />
            <SummaryCell label="Avg cost / run" value={avgCostText ?? '—'} />
            <SummaryCell label="Median duration" value={medDuration ?? '—'} />
            <SummaryCell label="Subagent share" value={pct(share)} />
          </div>

          <FlowThroughput
            tasksMergedByDay={stats.tasksMergedByDay}
            attemptsPerTask={stats.attemptsPerTask}
            costPerMergedTask={stats.costPerMergedTask}
            from={stats.from}
            to={stats.to}
          />

          {filled.length >= 2 && (
            <section className={`${card} mb-4 p-5`}>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <h2 className="text-title font-semibold">{METRIC_LABEL[metric]} per day</h2>
                <div className="flex-1" />
                <SegmentedControl
                  ariaLabel="Chart metric"
                  options={Object.entries(METRICS).map(([label, m]) => ({ label, value: m }))}
                  value={metric}
                  onChange={setMetric}
                />
              </div>
              <CostBars series={filled} metric={metric} />
              <CumulativeCurve series={filled} metric={metric} />
            </section>
          )}

          {stats.byWorkspace.length > 0 && (
            <section className={`${card} mb-4 p-5`}>
              <h2 className="mb-3 text-title font-semibold">Where the spend goes</h2>
              <div tabIndex={0} role="region" aria-label="Spend by workspace" className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className={tableHead}>
                    <tr>
                      <th className="py-1.5">Workspace</th>
                      <th className="py-1.5 text-right">Cost</th>
                      <th className="py-1.5 text-right">Tokens in</th>
                      <th className="py-1.5 text-right">Tokens out</th>
                      <th className="py-1.5 text-right">Tasks</th>
                      <th className="py-1.5 text-right">Fail rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byWorkspace.map((ws) => (
                      <tr key={ws.workspaceId} className="border-t border-hairline">
                        <td className="py-2 font-medium text-ink">{ws.name}</td>
                        <td className="py-2 text-right font-semibold tabular-nums text-ink">
                          {formatCost(ws.cost) ?? '—'}
                        </td>
                        <td className="py-2 text-right tabular-nums text-muted">{compact.format(ws.inputTokens)}</td>
                        <td className="py-2 text-right tabular-nums text-muted">{compact.format(ws.outputTokens)}</td>
                        <td className="py-2 text-right tabular-nums text-muted">{fmt(ws.tasks)}</td>
                        <td className="py-2 text-right tabular-nums text-ink">{pct(ws.failureRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className={`${card} mb-4 p-5`}>
            <h2 className="mb-4 text-title font-semibold">Reliability</h2>
            <div className="grid gap-6 md:grid-cols-2">
              <Donut segments={reliabilitySegments} total={stats.attemptCount} ariaLabel="Attempts by outcome" />
              <div className="grid grid-cols-2 gap-x-6 gap-y-5 self-start sm:grid-cols-3">
                <SummaryCell label="Failure rate" value={pct(failRate)} />
                <SummaryCell
                  label="Fails / day"
                  value={failsPerDay == null ? '—' : failsPerDay.toFixed(failsPerDay < 10 ? 1 : 0)}
                />
                <SummaryCell label="Cancelled" value={fmt(cancelledRuns)} />
                <SummaryCell label="Duration p50" value={durP50 ?? '—'} />
                <SummaryCell label="Duration p95" value={durP95 ?? '—'} />
              </div>
            </div>

            {filled.length >= 2 && failsTotal > 0 && (
              <div className="mt-6">
                <StatLabel>Fails per day</StatLabel>
                <CostBars series={filled} metric="fails" />
              </div>
            )}

            <div className="mt-6">
              <StatLabel>Failures by reason</StatLabel>
              {reasonBars.length === 0 ? (
                <p className="text-muted">No failures in range.</p>
              ) : (
                <BarChart bars={reasonBars} ariaLabel="Failures by reason" />
              )}
            </div>
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <section className={`${card} p-5`}>
              <h2 className="mb-3 text-title font-semibold">Tokens &amp; cost per model</h2>
              {modelBars.length === 0 ? (
                <p className="text-muted">No per-model data in range.</p>
              ) : (
                <BarChart
                  bars={modelBars}
                  ariaLabel={'Tokens & cost per model'}
                  columns={{ label: 'Model', value: 'Tokens & cost' }}
                />
              )}
            </section>

            <section className={`${card} p-5`}>
              <h2 className="mb-3 text-title font-semibold">Tool calls</h2>
              {toolBars.length === 0 ? (
                <p className="text-muted">No tool calls in range.</p>
              ) : (
                <BarChart bars={toolBars} ariaLabel="Tool calls by tool" />
              )}
            </section>
          </div>

          {agentBars.length > 0 && (
            <section className={`${card} mt-4 p-5`}>
              <h2 className="mb-3 text-title font-semibold">Tokens per agent</h2>
              <BarChart bars={agentBars} ariaLabel="Tokens per agent type" />
            </section>
          )}

          {toolTokenSegments.length > 0 && (
            <section className={`${card} mt-4 p-5`}>
              <h2 className="mb-3 text-title font-semibold">Tokens by tool</h2>
              <Donut
                segments={toolTokenSegments}
                total={toolTokenTotal}
                totalLabel="TOKENS"
                ariaLabel="Output tokens and cost by tool"
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
