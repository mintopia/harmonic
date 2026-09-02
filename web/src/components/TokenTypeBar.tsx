import type { ModelUsage } from '../stats-model';
import { totalTokens } from '../stats-model';

const TOKEN_SEGMENTS = [
  { key: 'inputTokens', label: 'input', fill: 'bg-token-input' },
  { key: 'outputTokens', label: 'output', fill: 'bg-token-output' },
  { key: 'cacheReadTokens', label: 'cache read', fill: 'bg-token-cache-read' },
  { key: 'cacheWriteTokens', label: 'cache write', fill: 'bg-token-cache-write' },
] as const satisfies readonly { key: keyof ModelUsage; label: string; fill: string }[];

const compactTokens = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** The four-class colour key, shown once per card so the stacked bars beneath repeat no swatches. */
export function TokenTypeLegend() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-label text-faint">
      {TOKEN_SEGMENTS.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className={`size-2 rounded-[2px] ${s.fill}`} aria-hidden="true" />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** One key's stacked input/output/cache-read/cache-write bar, scaled so the widest
 * bar is the row with the most tokens. Per-class values sit beneath so the split is
 * honest without a total-token scalar; `trailing` carries an optional cost tag. */
export function TokenTypeBar({
  label,
  usage,
  maxTotal,
  trailing,
}: {
  label: string;
  usage: ModelUsage;
  maxTotal: number;
  trailing?: string;
}) {
  const total = totalTokens(usage);
  const widthPct = maxTotal > 0 ? (total / maxTotal) * 100 : 0;
  const seg = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-data text-data font-semibold text-ink" title={label}>
          {label}
        </span>
        <span className="shrink-0 tabular-nums text-data text-muted">
          {compactTokens.format(total)}
          {trailing ? <span className="text-faint"> · {trailing}</span> : null}
        </span>
      </div>
      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-raised"
        style={{ width: `${Math.max(4, widthPct)}%` }}
        aria-hidden="true"
      >
        {TOKEN_SEGMENTS.map((s) => (
          <span key={s.key} className={`h-full ${s.fill}`} style={{ width: `${seg(usage[s.key])}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-label tabular-nums text-faint">
        {TOKEN_SEGMENTS.map((s) => (
          <span key={s.key}>
            {s.label} {compactTokens.format(usage[s.key])}
          </span>
        ))}
      </div>
    </div>
  );
}
