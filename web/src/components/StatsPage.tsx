import { useState, type ReactNode } from 'react';
import { formatAvgCostPerRun, formatCost, usd } from '../cost';
import { api } from '../api';
import { card, displayTitle, labelType, tableHead, touchTarget } from '../ui';
import {
  cacheHitRate,
  failureRate,
  orderedFailureReasons,
  reliabilityStates,
  subagentShare,
  totalTokens,
  type ModelUsage,
  type Stats,
} from '../stats-model';
import { VerificationEscalationCard } from './VerificationEscalationCard';
import { fmtDuration } from '../format-duration';
import { CostBars } from './CostBars';
import { CumulativeCurve } from './CumulativeCurve';
import { BarChart, type Bar } from './BarChart';
import { Donut, type DonutSegment } from './Donut';
import { fillSeries, METRIC_LABEL, type StatMetric } from './costChart-model';
import { EmptyState } from './EmptyState';
import { AttemptHeatmap } from './AttemptHeatmap';
import { useLiveEffect } from '../useLiveEffect';
import { FlowThroughput } from './FlowThroughput';
import { TokenTypeBar, TokenTypeLegend } from './TokenTypeBar';

const STATE_DONUT_COLOR: Record<string, string> = {
  running: 'var(--hm-running-dot)',
  completed: 'var(--hm-merged-dot)',
  failed: 'var(--hm-fail-dot)',
  cancelled: 'var(--hm-faint)',
};

const TOOL_TOKEN_COLORS = [
  'var(--hm-token-output)',
  'var(--hm-token-input)',
  'var(--hm-token-cache-read)',
  'var(--hm-token-cache-write)',
  'var(--hm-accent)',
];

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
          className={`${touchTarget} rounded-sm px-2.5 py-1.5 transition-colors duration-150 ${
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

function SummaryCell({ label, value, swatch }: { label: string; value: string; swatch?: string }) {
  return (
    <div>
      <StatLabel>
        {swatch && <span className={`mr-1.5 inline-block size-2 rounded-[2px] align-middle ${swatch}`} aria-hidden="true" />}
        {label}
      </StatLabel>
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

  useLiveEffect((live) => {
    if (workspaceId === null) return;
    const span = RANGES[range] ?? null;
    const from = span === null ? 0 : Date.now() - span;
    setError(null);
    api
      .stats(from, Date.now(), workspaceId)
      .then((s) => live() && setStats(s))
      .catch((e) => {
        if (!live()) return;
        setStats(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [range, workspaceId]);

  const filled = stats ? fillSeries(stats.series, stats.from, stats.to) : [];
  const costText = stats ? formatCost(stats.cost) : null;
  const share = stats ? subagentShare(stats.agents) : null;
  const pct = (r: number | null) => (r == null ? '—' : `${Math.round(r * 100)}%`);
  const cacheHit = stats ? cacheHitRate(stats.totals) : null;
  const failRate = stats ? failureRate(stats.failedAttempts, stats.attemptCount) : null;
  const avgCostText = stats ? formatAvgCostPerRun(stats.cost, stats.attemptCount) : null;
  const medDuration = stats?.durationMs ? fmtDuration(stats.durationMs.p50) : null;
  const sortedUsage = (byKey: Record<string, ModelUsage>): { key: string; usage: ModelUsage }[] =>
    Object.entries(byKey)
      .map(([key, usage]) => ({ key, usage }))
      .filter((r) => totalTokens(r.usage) > 0)
      .sort((a, b) => totalTokens(b.usage) - totalTokens(a.usage) || a.key.localeCompare(b.key));
  const modelRows = stats ? sortedUsage(stats.models) : [];
  const agentRows = stats?.agents ? sortedUsage(stats.agents) : [];
  const modelMax = Math.max(1, ...modelRows.map((r) => totalTokens(r.usage)));
  const agentMax = Math.max(1, ...agentRows.map((r) => totalTokens(r.usage)));
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
                color: 'var(--hm-token-cache-write)',
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

      {workspaceId !== null && (
        <AttemptHeatmap
          workspaceId={workspaceId}
          aside={
            stats && stats.attemptCount > 0 ? (
              <div>
                <StatLabel>At a glance · {range}</StatLabel>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-2">
                  <SummaryCell label="Attempts" value={fmt(stats.attemptCount)} />
                  <SummaryCell label="Failure rate" value={pct(failRate)} />
                  <SummaryCell label="Avg cost / attempt" value={avgCostText ?? '—'} />
                  <SummaryCell label="Median duration" value={medDuration ?? '—'} />
                  <SummaryCell label="Cache hit rate" value={pct(cacheHit)} />
                  <SummaryCell label="Subagent share" value={pct(share)} />
                </div>
              </div>
            ) : undefined
          }
        />
      )}

      {error && (
        <p className="rounded-lg bg-fail-tint px-4 py-2 text-fail">Couldn’t load statistics: {error}</p>
      )}

      {!stats && !error && <div className={`${card} p-5 text-muted`}>Loading…</div>}

      {stats && stats.attemptCount === 0 && (
        <EmptyState title="No attempts to chart yet">
          Cost, tokens, and the per-model breakdown appear here once an agent has run. If you’ve run
          tasks before, try a wider range.
        </EmptyState>
      )}

      {stats && stats.attemptCount > 0 && (
        <>
          <section className={`${card} mb-4 p-5`}>
            <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
              <div>
                <StatLabel>Cost · {range}</StatLabel>
                <div
                  className={`text-hero font-display-weight tabular-nums ${costText == null ? 'text-faint' : 'text-ink'}`}
                >
                  {costText ?? '—'}
                </div>
              </div>
              <div className="text-right">
                <StatLabel>Avg / attempt</StatLabel>
                <div className={`text-title font-semibold tabular-nums ${avgCostText == null ? 'text-faint' : 'text-ink'}`}>
                  {avgCostText ?? '—'}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-t border-hairline pt-5 sm:grid-cols-3 lg:grid-cols-5">
              <SummaryCell label="Attempts" value={fmt(stats.attemptCount)} />
              <SummaryCell label="Tokens in" swatch="bg-token-input" value={stats.totals ? compact.format(stats.totals.inputTokens) : '—'} />
              <SummaryCell label="Tokens out" swatch="bg-token-output" value={stats.totals ? compact.format(stats.totals.outputTokens) : '—'} />
              <SummaryCell label="Cache read" swatch="bg-token-cache-read" value={stats.totals ? compact.format(stats.totals.cacheReadTokens) : '—'} />
              <SummaryCell label="Cache write" swatch="bg-token-cache-write" value={stats.totals ? compact.format(stats.totals.cacheWriteTokens) : '—'} />
            </div>
          </section>

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
              <div className="pl-[calc(2.75rem+0.5rem)]">
                <CumulativeCurve series={filled} metric={metric} />
              </div>
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

          <VerificationEscalationCard
            verdicts={stats.verdicts}
            gateOutcomes={stats.gateOutcomes}
            guardrailTrips={stats.guardrailTrips}
          />

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <section className={`${card} p-5`}>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h2 className="text-title font-semibold">Tokens &amp; cost per model</h2>
                {modelRows.length > 0 && <TokenTypeLegend />}
              </div>
              {modelRows.length === 0 ? (
                <p className="text-muted">No per-model data in range.</p>
              ) : (
                <div className="flex flex-col gap-4">
                  {modelRows.map(({ key, usage }) => {
                    const c = stats.cost?.byModel[key];
                    return (
                      <TokenTypeBar
                        key={key}
                        label={key}
                        usage={usage}
                        maxTotal={modelMax}
                        trailing={c == null ? undefined : usd(c)}
                      />
                    );
                  })}
                </div>
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

          {agentRows.length > 0 && (
            <section className={`${card} mt-4 p-5`}>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h2 className="text-title font-semibold">Tokens per agent</h2>
                <TokenTypeLegend />
              </div>
              <div className="flex flex-col gap-4">
                {agentRows.map(({ key, usage }) => (
                  <TokenTypeBar key={key} label={key} usage={usage} maxTotal={agentMax} />
                ))}
              </div>
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
