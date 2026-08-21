import { useEffect, useState, type ReactNode } from 'react';
import { formatAvgCostPerRun, formatCost, usd } from '../cost';
import type { Cost } from '../types';
import { card, displayTitle, labelType } from '../ui';
import {
  cacheHitRate,
  failureRate,
  orderedFailureReasons,
  reliabilityStates,
  subagentShare,
  usageBars,
} from '../stats-model';
import { fmtDuration } from '../phase-timeline-model';
import { CostBars } from './CostBars';
import { CumulativeCurve } from './CumulativeCurve';
import { BarChart, type Bar } from './BarChart';
import { Donut, type DonutSegment } from './Donut';
import { fillSeries, METRIC_LABEL, type DayCost, type StatMetric } from './costChart-model';
import { EmptyState } from './EmptyState';

/** Each run state's signal colour, for the run-states donut — the same
 * state-signal family the chips use (the Signal Rule), so the segment colour
 * reads as the state. Unknown states fall back to a neutral edge grey. */
const STATE_DONUT_COLOR: Record<string, string> = {
  draft: 'var(--hm-muted)',
  blocked: 'var(--hm-blocked)',
  ready: 'var(--hm-ready-dot)',
  running: 'var(--hm-running-dot)',
  'awaiting-review': 'var(--hm-accent)',
  completed: 'var(--hm-accept-dot)',
  failed: 'var(--hm-fail-dot)',
  // A review rejection lives in the Failed-rose family (DESIGN.md § 2), but on a
  // darker rose than failed's bright dot so the two read as distinct slices —
  // never the cobalt accent, which is the interface's own voice (the Signal Rule).
  rejected: 'var(--hm-fail)',
  cancelled: 'var(--hm-faint)',
};

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
  'review-sla-expiry': 'Review timeout',
  'agent-finish/unresolved': 'Unresolved',
  unknown: 'Unknown',
};

type ModelUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

interface Stats {
  from: number;
  to: number;
  runCount: number;
  runsByState: Record<string, number>;
  /** Failed-only Run count (excludes review-rejected); the honest failure-rate numerator. */
  failedRuns: number;
  /** Review-rejected Run count; shown as its own slice, kept out of the failure numerator. */
  rejectedRuns: number;
  /** Execution failures bucketed by winning terminal disposition; empty when nothing failed. */
  failuresByReason: Record<string, number>;
  /** p50 / p95 active-execution duration (ms); null when no run has a measurable duration. */
  durationMs: { p50: number; p95: number } | null;
  totals: (ModelUsage & { totalTokens: number | null }) | null;
  models: Record<string, ModelUsage>;
  /** Per-agent-type token breakdown (root + each Subagent type); may be absent on older data. */
  agents?: Record<string, ModelUsage>;
  toolCalls: Record<string, number>;
  cost: Cost | null;
  series: DayCost[];
}

const RANGES: Record<string, number | null> = {
  '24 hours': 24 * 3600_000,
  '7 days': 7 * 24 * 3600_000,
  '30 days': 30 * 24 * 3600_000,
  'All time': null,
};

const METRICS: Record<string, StatMetric> = { USD: 'usd', Tokens: 'tokens', Runs: 'runs' };

const fmt = (n: number) => n.toLocaleString();
/** Summary figures compact ("18.2M"); tables keep exact numbers. */
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** A segmented pill toggle — the shared control behind both the time-range and
 * the chart-metric switch, so the two can't drift in style (DESIGN.md: the
 * accent marks the current selection; state colours stay off it). */
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

/** The muted uppercase label above a stat figure — shared by the hero and the
 * quiet stat row so the two can't drift (Label role, DESIGN.md § 3). */
function StatLabel({ children }: { children: ReactNode }) {
  return <div className={`${labelType} mb-1.5 text-muted`}>{children}</div>;
}

/** One cell of the quiet stat row: muted label over a weighted, tabular value.
 * (The hero cost figure is rendered separately — it leads on the canvas, never
 * boxed in this row: DESIGN.md § Stats, "the Hero cost figure leads, no
 * card-in-a-card".) */
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
  // Local only — re-plots the already-fetched series in place, never refetches.
  const [metric, setMetric] = useState<StatMetric>('usd');

  useEffect(() => {
    if (workspaceId === null) return;
    const span = RANGES[range] ?? null;
    const from = span === null ? 0 : Date.now() - span;
    let cancelled = false;
    setError(null);
    // A non-200 body ({error:{…}}) has none of the fields the render path
    // reads — storing it would throw and blank the page. Check ok, like api.ts.
    fetch(`/api/stats?from=${from}&to=${Date.now()}&workspaceId=${workspaceId}`)
      .then(async (r) => {
        const text = await r.text();
        const json = text ? JSON.parse(text) : null;
        if (!r.ok) throw new Error(json?.error?.message ?? r.statusText);
        return json as Stats;
      })
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
  // KPI band figures — each "—" when its inputs are missing (honest numbers).
  const pct = (r: number | null) => (r == null ? '—' : `${Math.round(r * 100)}%`);
  const cacheHit = stats ? cacheHitRate(stats.totals) : null;
  const failRate = stats ? failureRate(stats.failedRuns, stats.runCount) : null;
  const avgCostText = stats ? formatAvgCostPerRun(stats.cost, stats.runCount) : null;
  const medDuration = stats?.durationMs ? fmtDuration(stats.durationMs.p50) : null;
  // Token bars, largest first. Per-model rows carry their Cost too (the table
  // this replaced showed both); agent + tool rows are single-figure.
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
  // The run-states donut, regrouped for reliability: review-rejected Runs are
  // split out of the folded-in `failed` count into their own slice (ADR-0028).
  const reliabilitySegments: DonutSegment[] = stats
    ? reliabilityStates(stats.runsByState, stats.failedRuns, stats.rejectedRuns).map(({ state, count }) => ({
        key: state,
        label: state,
        value: count,
        color: STATE_DONUT_COLOR[state] ?? 'var(--hm-edge)',
      }))
    : [];
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
  const failsPerDay = dataDays > 0 ? stats!.failedRuns / dataDays : null;
  const cancelledRuns = stats?.runsByState.cancelled ?? 0;
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

      {error && (
        <p className="rounded-lg bg-fail-tint px-4 py-2 text-fail">Couldn’t load statistics: {error}</p>
      )}

      {!stats && !error && <div className={`${card} p-5 text-muted`}>Loading…</div>}

      {stats && stats.runCount === 0 && (
        <EmptyState title="No runs to chart yet">
          Cost, tokens, and the per-model breakdown appear here once an agent has run. If you’ve run
          tasks before, try a wider range.
        </EmptyState>
      )}

      {stats && stats.runCount > 0 && (
        <>
          {/* The one loud figure of the view: cost — the number the operator
              glances at. It leads on the canvas (no card-in-a-card, DESIGN.md
              § Stats), big sans + tabular-nums, never mono (Mono Is Code). */}
          <div className="mb-5">
            <StatLabel>Cost · {range}</StatLabel>
            <div className={`text-hero font-bold tabular-nums ${costText == null ? 'text-faint' : 'text-ink'}`}>
              {costText ?? '—'}
            </div>
          </div>

          {/* A quiet stat row answers alongside the hero. Subagent share is
              the fraction of tokens spent below the root session (issue #48
              made Subagent tokens visible); "—" when no per-agent data. */}
          <div className={`${card} mb-4 grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:grid-cols-3 lg:grid-cols-5`}>
            <SummaryCell label="Runs" value={fmt(stats.runCount)} />
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

          {/* Reliability (issue #197): are runs failing, and how long do they
              take? The run-states donut is regrouped here so cancelled and
              review-rejected Runs read as their own slices (ADR-0028), never
              folded into failures — the whole picture the failure rate must be
              reconciled against. */}
          <section className={`${card} mb-4 p-5`}>
            <h2 className="mb-4 text-title font-semibold">Reliability</h2>
            <div className="grid gap-6 md:grid-cols-2">
              <Donut segments={reliabilitySegments} total={stats.runCount} ariaLabel="Runs by outcome" />
              <div className="grid grid-cols-2 gap-x-6 gap-y-5 self-start sm:grid-cols-3">
                <SummaryCell label="Failure rate" value={pct(failRate)} />
                <SummaryCell
                  label="Fails / day"
                  value={failsPerDay == null ? '—' : failsPerDay.toFixed(failsPerDay < 10 ? 1 : 0)}
                />
                <SummaryCell label="Rejected" value={fmt(stats.rejectedRuns)} />
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
                <BarChart bars={modelBars} ariaLabel="Tokens per model" />
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

          {/* Per-agent-type spend (root session vs each Subagent type). Only
              runs whose harness parsed a Process Tree carry this, so older
              data may leave it empty — then the card is simply omitted. */}
          {agentBars.length > 0 && (
            <section className={`${card} mt-4 p-5`}>
              <h2 className="mb-3 text-title font-semibold">Tokens per agent</h2>
              <BarChart bars={agentBars} ariaLabel="Tokens per agent type" />
            </section>
          )}
        </>
      )}
    </div>
  );
}
