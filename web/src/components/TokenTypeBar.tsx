import type { ModelUsage } from '../stats-model';
import { totalTokens } from '../stats-model';

const TOKEN_SEGMENTS = [
  { key: 'inputTokens', label: 'input', fill: 'bg-token-input' },
  { key: 'outputTokens', label: 'output', fill: 'bg-token-output' },
  { key: 'cacheReadTokens', label: 'cache read', fill: 'bg-token-cache-read' },
  { key: 'cacheWriteTokens', label: 'cache write', fill: 'bg-token-cache-write' },
] as const satisfies readonly { key: keyof ModelUsage; label: string; fill: string }[];

const compactTokens = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const fullTokens = new Intl.NumberFormat();

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

/** Hover/focus popover carrying the exact per-class counts and cost the compact bar can't show. */
function TokenTooltip({
  usage,
  total,
  trailing,
  align = 'left',
}: {
  usage: ModelUsage;
  total: number;
  trailing?: string;
  align?: 'left' | 'right';
}) {
  return (
    <div
      role="tooltip"
      className={`pointer-events-none absolute bottom-full z-20 mb-2 hidden w-52 rounded-md border border-edge bg-surface p-3 text-left shadow-card group-hover:block group-focus-within:block ${
        align === 'right' ? 'right-0' : 'left-0'
      }`}
    >
      <div className="grid gap-1">
        {TOKEN_SEGMENTS.map((s) => (
          <div key={s.key} className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-label text-muted">
              <span className={`size-2 rounded-[2px] ${s.fill}`} aria-hidden="true" />
              {s.label}
            </span>
            <span className="tabular-nums text-label text-ink">{fullTokens.format(usage[s.key])}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-hairline pt-2">
        <span className="text-label font-semibold text-muted">total</span>
        <span className="tabular-nums text-label font-semibold text-ink">{fullTokens.format(total)}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="text-label font-semibold text-muted">cost</span>
        <span className="tabular-nums text-label font-semibold text-ink">{trailing ?? 'unpriced'}</span>
      </div>
    </div>
  );
}

/** One key's stacked input/output/cache-read/cache-write bar, scaled so the widest
 * bar is the row with the most tokens. Per-class values sit beneath so the split is
 * honest without a total-token scalar; `trailing` carries an optional cost tag,
 * which also surfaces in the hover tooltip. */
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
    <div className="group relative grid gap-1.5" tabIndex={0}>
      <TokenTooltip usage={usage} total={total} trailing={trailing} />
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

/** A summed token total for dense rows, over a slim four-class underline, with the
 * same hover tooltip revealing the per-class split and cost. */
export function TokenSum({ usage, trailing }: { usage: ModelUsage; trailing?: string }) {
  const total = totalTokens(usage);
  const seg = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  return (
    <span className="group relative inline-flex flex-col items-end gap-1" tabIndex={0}>
      <TokenTooltip usage={usage} total={total} trailing={trailing} align="right" />
      <span className="tabular-nums text-small text-ink">{compactTokens.format(total)}</span>
      <span className="flex h-1 w-12 overflow-hidden rounded-full bg-raised" aria-hidden="true">
        {TOKEN_SEGMENTS.map((s) => (
          <span key={s.key} className={`h-full ${s.fill}`} style={{ width: `${seg(usage[s.key])}%` }} />
        ))}
      </span>
    </span>
  );
}
