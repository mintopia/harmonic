import { useEffect, useState, type ReactNode } from 'react';
import { formatCost, usd } from '../cost';
import type { Cost, TaskState } from '../types';
import { card, chip, displayTitle, labelType, STATE_CHIP_STYLES, tableHead } from '../ui';
import { orderedRunStates } from '../stats-model';
import { CostChart } from './CostChart';
import { fillSeries, type DayCost } from './costChart-model';
import { EmptyState } from './EmptyState';

interface Stats {
  from: number;
  to: number;
  runCount: number;
  runsByState: Record<string, number>;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number | null;
  } | null;
  models: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>;
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

          {/* A quiet stat row answers alongside the hero. */}
          <div className={`${card} mb-4 grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:grid-cols-3 lg:grid-cols-5`}>
            <SummaryCell label="Runs" value={fmt(stats.runCount)} />
            <SummaryCell label="Tokens in" value={stats.totals ? compact.format(stats.totals.inputTokens) : '—'} />
            <SummaryCell label="Tokens out" value={stats.totals ? compact.format(stats.totals.outputTokens) : '—'} />
            <SummaryCell label="Cache read" value={stats.totals ? compact.format(stats.totals.cacheReadTokens) : '—'} />
            <SummaryCell label="Cache write" value={stats.totals ? compact.format(stats.totals.cacheWriteTokens) : '—'} />
          </div>

          {filled.length >= 2 && (
            <section className={`${card} mb-4 p-5`}>
              <h2 className="mb-3 text-title font-semibold">Cost per day</h2>
              <CostChart series={filled} />
            </section>
          )}

          <section className={`${card} mb-4 p-5`}>
            <h2 className="mb-3 text-title font-semibold">Run states</h2>
            <div className="flex flex-wrap gap-2">
              {orderedRunStates(stats.runsByState).map(({ state, count }) => (
                <span
                  key={state}
                  className={`${chip} ${STATE_CHIP_STYLES[state as TaskState] ?? 'bg-raised text-muted'}`}
                >
                  {state} <span className="font-semibold">{count.toLocaleString()}</span>
                </span>
              ))}
            </div>
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <section className={`${card} p-5`}>
              <h2 className="mb-3 text-title font-semibold">Tokens &amp; cost per model</h2>
              {Object.keys(stats.models).length === 0 && <p className="text-muted">No per-model data in range.</p>}
              {Object.keys(stats.models).length > 0 && (
                <table className="w-full text-left">
                  <thead className={tableHead}>
                    <tr>
                      <th className="pb-2 font-semibold">Model</th>
                      <th className="pb-2 text-right font-semibold">Tokens</th>
                      <th className="pb-2 pl-3 text-right font-semibold">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(stats.models).map(([model, u]) => {
                      const modelCost = stats.cost?.byModel[model];
                      return (
                        <tr key={model} className="border-t border-hairline">
                          <td className="py-2 text-data text-ink">{model}</td>
                          <td className="text-right text-data tabular-nums text-muted">
                            {fmt(u.inputTokens)} in · {fmt(u.outputTokens)} out
                          </td>
                          <td
                            className="pl-3 text-right text-data tabular-nums text-ink"
                            title={modelCost == null ? 'No price configured for this model' : undefined}
                          >
                            {modelCost == null ? '—' : usd(modelCost)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>

            <section className={`${card} p-5`}>
              <h2 className="mb-3 text-title font-semibold">Tool calls</h2>
              {Object.keys(stats.toolCalls).length === 0 && <p className="text-muted">No tool calls in range.</p>}
              {Object.keys(stats.toolCalls).length > 0 && (
                <table className="w-full text-left">
                  <thead className={tableHead}>
                    <tr>
                      <th className="pb-2 font-semibold">Tool</th>
                      <th className="pb-2 text-right font-semibold">Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(stats.toolCalls)
                      .sort(([, a], [, b]) => b - a)
                      .map(([tool, count]) => (
                        // The tool name is a row label, not a state — colour stays
                        // off content and lives only on the state/signal layer (the
                        // Signal Rule; issue #87). So the name renders in ink.
                        <tr key={tool} className="border-t border-hairline">
                          <td className="py-2 text-data text-ink">{tool}</td>
                          <td className="text-right text-data tabular-nums text-ink">{fmt(count)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
