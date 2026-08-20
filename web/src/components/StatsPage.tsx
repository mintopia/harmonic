import { useEffect, useState, type ReactNode } from 'react';
import { formatCost, usd } from '../cost';
import type { Cost } from '../types';
import { card, displayTitle, labelType } from '../ui';
import { orderedRunStates, subagentShare, usageBars } from '../stats-model';
import { CostBars } from './CostBars';
import { BarChart, type Bar } from './BarChart';
import { Donut, type DonutSegment } from './Donut';
import { fillSeries, type DayCost } from './costChart-model';
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
  cancelled: 'var(--hm-faint)',
};

type ModelUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

interface Stats {
  from: number;
  to: number;
  runCount: number;
  runsByState: Record<string, number>;
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

const fmt = (n: number) => n.toLocaleString();
/** Summary figures compact ("18.2M"); tables keep exact numbers. */
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

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
  const runStateSegments: DonutSegment[] = stats
    ? orderedRunStates(stats.runsByState).map(({ state, count }) => ({
        key: state,
        label: state,
        value: count,
        color: STATE_DONUT_COLOR[state] ?? 'var(--hm-edge)',
      }))
    : [];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className={displayTitle}>Usage &amp; statistics</h1>
        <div className="flex-1" />
        <div className="flex gap-0.5 rounded-md bg-raised p-0.5" role="group" aria-label="Time range">
          {Object.keys(RANGES).map((r) => (
            <button
              key={r}
              aria-pressed={r === range}
              onClick={() => setRange(r)}
              className={`rounded-sm px-2.5 py-1.5 transition-colors duration-150 ${
                r === range ? 'bg-surface font-semibold text-ink shadow-card' : 'font-medium text-muted hover:text-ink'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
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
          <div className={`${card} mb-4 grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:grid-cols-3 lg:grid-cols-6`}>
            <SummaryCell label="Runs" value={fmt(stats.runCount)} />
            <SummaryCell label="Tokens in" value={stats.totals ? compact.format(stats.totals.inputTokens) : '—'} />
            <SummaryCell label="Tokens out" value={stats.totals ? compact.format(stats.totals.outputTokens) : '—'} />
            <SummaryCell label="Cache read" value={stats.totals ? compact.format(stats.totals.cacheReadTokens) : '—'} />
            <SummaryCell label="Cache write" value={stats.totals ? compact.format(stats.totals.cacheWriteTokens) : '—'} />
            <SummaryCell label="Subagent share" value={share == null ? '—' : `${Math.round(share * 100)}%`} />
          </div>

          {filled.length >= 2 && (
            <section className={`${card} mb-4 p-5`}>
              <h2 className="mb-3 text-title font-semibold">Cost per day</h2>
              <CostBars series={filled} />
            </section>
          )}

          <section className={`${card} mb-4 p-5`}>
            <h2 className="mb-3 text-title font-semibold">Run states</h2>
            <Donut segments={runStateSegments} total={stats.runCount} ariaLabel="Runs by state" />
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
