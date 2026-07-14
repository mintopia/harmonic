import { useEffect, useState } from 'react';
import { formatCost, usd } from '../cost';
import type { Cost } from '../types';

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

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs uppercase tracking-wider text-zinc-400">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-zinc-100">{value}</div>
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
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-2">
        <h2 className="text-base font-semibold">Usage & statistics</h2>
        <div className="flex-1" />
        {Object.keys(RANGES).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`rounded-md border px-2 py-1 text-xs ${
              r === range ? 'border-amber-500 text-amber-300' : 'border-zinc-700 text-zinc-400'
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      {stats && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
            <Tile label="Runs" value={fmt(stats.runCount)} />
            <Tile label="Cost" value={formatCost(stats.cost) ?? '—'} />
            <Tile label="Input tokens" value={stats.totals ? fmt(stats.totals.inputTokens) : '—'} />
            <Tile label="Output tokens" value={stats.totals ? fmt(stats.totals.outputTokens) : '—'} />
            <Tile label="Cache read" value={stats.totals ? fmt(stats.totals.cacheReadTokens) : '—'} />
            <Tile label="Cache write" value={stats.totals ? fmt(stats.totals.cacheWriteTokens) : '—'} />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-400">Tokens & cost per model</h3>
              {Object.keys(stats.models).length === 0 && (
                <p className="text-sm text-zinc-400">No per-model data in range.</p>
              )}
              <table className="w-full text-left text-sm">
                <tbody>
                  {Object.entries(stats.models).map(([model, u]) => {
                    const modelCost = stats.cost?.byModel[model];
                    return (
                      <tr key={model} className="border-t border-zinc-800 first:border-t-0">
                        <td className="py-1.5 font-mono text-xs">{model}</td>
                        <td className="text-right text-xs tabular-nums text-zinc-400">
                          {fmt(u.inputTokens)} in · {fmt(u.outputTokens)} out
                        </td>
                        <td
                          className="pl-3 text-right text-xs tabular-nums text-amber-300/80"
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

            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-400">Tool calls</h3>
              {Object.keys(stats.toolCalls).length === 0 && (
                <p className="text-sm text-zinc-400">No tool calls in range.</p>
              )}
              <table className="w-full text-left text-sm">
                <tbody>
                  {Object.entries(stats.toolCalls)
                    .sort(([, a], [, b]) => b - a)
                    .map(([tool, count]) => (
                      <tr key={tool} className="border-t border-zinc-800 first:border-t-0">
                        <td className="py-1.5">{tool}</td>
                        <td className="text-right tabular-nums text-zinc-400">{fmt(count)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2 text-xs tabular-nums text-zinc-400">
            {Object.entries(stats.runsByState).map(([state, count]) => (
              <span key={state} className="rounded bg-zinc-900 px-2 py-1">
                {state}: {count}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
