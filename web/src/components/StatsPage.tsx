import { useEffect, useState } from 'react';
import { formatCost, usd } from '../cost';
import type { Cost, TaskState } from '../types';
import { card, chip, displayTitle, labelType, STATE_CHIP_STYLES, tableHead } from '../ui';
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

/** One cell of the summary grid: muted label over a weighted, tabular value.
 * The hero (cost) is the one loud figure — big sans, not mono (Mono Is Code
 * Rule) — and spans its own full-width row so it leads. */
function SummaryCell({ label, value, hero = false }: { label: string; value: string; hero?: boolean }) {
  return (
    <div className={hero ? 'col-span-full' : ''}>
      <div className={`${labelType} mb-1.5 text-muted`}>{label}</div>
      <div
        className={`font-semibold tabular-nums ${value === '—' ? 'text-faint' : 'text-ink'} ${
          hero ? 'text-hero font-bold' : 'text-title'
        }`}
      >
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

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className={displayTitle}>Usage &amp; statistics</h2>
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

      {stats && stats.runCount === 0 && (
        <EmptyState title="No runs to chart yet">
          Cost, tokens, and the per-model breakdown appear here once an agent has run. If you’ve run
          tasks before, try a wider range.
        </EmptyState>
      )}

      {stats && stats.runCount > 0 && (
        <>
          {/* The one loud element of the view: cost — the number the
              operator glances at. Everything else answers alongside. */}
          <div className={`${card} mb-4 grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:grid-cols-3 lg:grid-cols-5`}>
            <SummaryCell hero label={`Cost · ${range}`} value={formatCost(stats.cost) ?? '—'} />
            <SummaryCell label="Runs" value={fmt(stats.runCount)} />
            <SummaryCell label="Tokens in" value={stats.totals ? compact.format(stats.totals.inputTokens) : '—'} />
            <SummaryCell label="Tokens out" value={stats.totals ? compact.format(stats.totals.outputTokens) : '—'} />
            <SummaryCell label="Cache read" value={stats.totals ? compact.format(stats.totals.cacheReadTokens) : '—'} />
            <SummaryCell label="Cache write" value={stats.totals ? compact.format(stats.totals.cacheWriteTokens) : '—'} />
          </div>

          {filled.length >= 2 && (
            <section className={`${card} mb-4 p-5`}>
              <h3 className="mb-3 text-title font-semibold">Cost per day</h3>
              <CostChart series={filled} />
            </section>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <section className={`${card} p-5`}>
              <h3 className="mb-3 text-title font-semibold">Tokens &amp; cost per model</h3>
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
              <h3 className="mb-3 text-title font-semibold">Tool calls</h3>
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
                        // Cyan is the documented voice for tooling metadata
                        // (the Signal Rule) — its one use on this page.
                        <tr key={tool} className="border-t border-hairline">
                          <td className="py-2 text-data text-tool">{tool}</td>
                          <td className="text-right text-data tabular-nums text-ink">{fmt(count)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {Object.entries(stats.runsByState).map(([state, count]) => (
              <span
                key={state}
                className={`${chip} ${count > 0 ? (STATE_CHIP_STYLES[state as TaskState] ?? 'bg-raised text-muted') : 'bg-raised text-faint'}`}
              >
                {state} <span className="font-semibold">{fmt(count)}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
