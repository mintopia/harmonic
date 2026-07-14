import { useEffect, useState } from 'react';
import { formatCost, usd } from '../cost';
import type { Cost } from '../types';
import { chip, labelType } from '../ui';

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
}

const RANGES: Record<string, number | null> = {
  '24 hours': 24 * 3600_000,
  '7 days': 7 * 24 * 3600_000,
  '30 days': 30 * 24 * 3600_000,
  'All time': null,
};

const fmt = (n: number) => n.toLocaleString();
const panel = 'rounded-md border border-hairline bg-surface p-4';

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className={panel}>
      {/* Counts stay in their surrounding role (DESIGN.md § Typography):
          the tile speaks Headline, tabular-nums comes from the base layer. */}
      <div className={`${labelType} text-muted`}>{label}</div>
      <div className="mt-1 text-headline font-semibold text-ink">{value}</div>
    </div>
  );
}

export function StatsPage() {
  const [range, setRange] = useState('7 days');
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const span = RANGES[range] ?? null;
    const from = span === null ? 0 : Date.now() - span;
    fetch(`/api/stats?from=${from}&to=${Date.now()}`)
      .then((r) => r.json())
      .then((s) => setStats(s as Stats));
  }, [range]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-display font-semibold tracking-tight">Usage & statistics</h2>
        <div className="flex-1" />
        {Object.keys(RANGES).map((r) => (
          <button
            key={r}
            aria-pressed={r === range}
            onClick={() => setRange(r)}
            className={`rounded-md border px-2 py-1 text-label transition-colors duration-150 ${
              r === range ? 'border-accent text-ink' : 'border-hairline text-muted hover:text-ink'
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      {stats && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
            <Tile label="Runs" value={fmt(stats.runCount)} />
            <Tile label="Cost" value={formatCost(stats.cost) ?? '—'} />
            <Tile label="Input tokens" value={stats.totals ? fmt(stats.totals.inputTokens) : '—'} />
            <Tile label="Output tokens" value={stats.totals ? fmt(stats.totals.outputTokens) : '—'} />
            <Tile label="Cache read" value={stats.totals ? fmt(stats.totals.cacheReadTokens) : '—'} />
            <Tile label="Cache write" value={stats.totals ? fmt(stats.totals.cacheWriteTokens) : '—'} />
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <div className={panel}>
              <h3 className={`mb-2 ${labelType} text-muted`}>Tokens & cost per model</h3>
              {Object.keys(stats.models).length === 0 && (
                <p className="text-muted">No per-model data in range.</p>
              )}
              <table className="w-full text-left">
                <tbody>
                  {Object.entries(stats.models).map(([model, u]) => {
                    const modelCost = stats.cost?.byModel[model];
                    return (
                      <tr key={model} className="border-t border-hairline first:border-t-0">
                        <td className="py-1.5 font-data text-data">{model}</td>
                        <td className="text-right font-data text-data text-muted">
                          {fmt(u.inputTokens)} in · {fmt(u.outputTokens)} out
                        </td>
                        <td
                          className="pl-3 text-right font-data text-data text-muted"
                          title={modelCost == null ? 'No price configured for this model' : undefined}
                        >
                          {modelCost == null ? '—' : usd(modelCost)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className={panel}>
              <h3 className={`mb-2 ${labelType} text-muted`}>Tool calls</h3>
              {Object.keys(stats.toolCalls).length === 0 && (
                <p className="text-muted">No tool calls in range.</p>
              )}
              <table className="w-full text-left">
                <tbody>
                  {Object.entries(stats.toolCalls)
                    .sort(([, a], [, b]) => b - a)
                    .map(([tool, count]) => (
                      <tr key={tool} className="border-t border-hairline first:border-t-0">
                        <td className="py-1.5 font-data text-data">{tool}</td>
                        <td className="text-right text-muted">{fmt(count)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {Object.entries(stats.runsByState).map(([state, count]) => (
              <span key={state} className={`${chip} bg-raised text-muted`}>
                {state}: {count}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
