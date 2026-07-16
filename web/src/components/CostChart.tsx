import { useMemo, useState } from 'react';
import { usd } from '../cost';

export interface DayCost {
  day: number;
  totalUsd: number | null;
  incomplete: boolean;
}

const W = 720;
const H = 180;
const PAD_L = 44;
const PAD_R = 56; // room for the endpoint label
const PAD_T = 14;
const PAD_B = 28;

const dayLabel = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: undefined });
const dateLabel = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Zero-fill the gaps between buckets so a quiet day reads as $0, not as
 * a skipped point — but only over ranges small enough to label honestly. */
export function fillSeries(series: DayCost[], from: number, to: number): DayCost[] {
  const first = series[0];
  if (!first) return [];
  const DAY = 24 * 3600_000;
  const start = new Date(Math.max(from, first.day));
  start.setHours(0, 0, 0, 0);
  const end = new Date(Math.min(to, Date.now()));
  end.setHours(0, 0, 0, 0);
  const span = Math.round((end.getTime() - start.getTime()) / DAY) + 1;
  if (span < 2 || span > 62) return series; // all-time sprawl: plot the data as-is
  const byDay = new Map(series.map((s) => [s.day, s]));
  const out: DayCost[] = [];
  for (let i = 0; i < span; i++) {
    const d = new Date(start.getTime() + i * DAY + DAY / 2); // DST-safe: mid-day, then floor
    d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    out.push(byDay.get(key) ?? { day: key, totalUsd: 0, incomplete: false });
  }
  return out;
}

/**
 * Cost-per-day area chart (DESIGN.md § Charts): one cobalt series, faint
 * grid, emphasized endpoint, crosshair on hover — arrow keys walk the
 * days when focused. Honest numbers: incomplete days tooltip as floors.
 */
export function CostChart({ series }: { series: DayCost[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const { points, gridValues, xOf, yOf } = useMemo(() => {
    const max = Math.max(...series.map((s) => s.totalUsd ?? 0), 0.01);
    // A friendly ceiling: 1/2/5 × 10^n at or above the observed max.
    const pow = 10 ** Math.floor(Math.log10(max));
    const ceil = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= max) ?? max;
    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B;
    const xOf = (i: number) => PAD_L + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
    const yOf = (v: number) => PAD_T + innerH - (v / ceil) * innerH;
    const points = series.map((s, i) => ({ x: xOf(i), y: yOf(s.totalUsd ?? 0), ...s }));
    return { points, gridValues: [ceil, ceil / 2], xOf, yOf };
  }, [series]);

  const firstPoint = points[0];
  const last = points[points.length - 1];
  const firstDay = series[0];
  const lastDay = series[series.length - 1];
  if (series.length < 2 || !firstPoint || !last || !firstDay || !lastDay) return null;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${last.x.toFixed(1)} ${H - PAD_B} L${firstPoint.x.toFixed(1)} ${H - PAD_B} Z`;

  // ≤8 x labels, always including first and last.
  const step = Math.max(1, Math.ceil(series.length / 8));
  const labeled = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  const short = series.length <= 8;

  const pick = (clientX: number, rect: DOMRect) => {
    const x = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(p.x - x);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    setHover(best);
  };

  const hovered = hover === null ? null : (points[hover] ?? null);
  const total = series.reduce((sum, s) => sum + (s.totalUsd ?? 0), 0);
  const anyIncomplete = series.some((s) => s.incomplete);

  return (
    <svg
      role="img"
      aria-label={`Cost per day, ${dateLabel(firstDay.day)} to ${dateLabel(lastDay.day)}, totalling ${anyIncomplete ? 'at least ' : ''}${usd(total)}. Use arrow keys to inspect days.`}
      tabIndex={0}
      viewBox={`0 0 ${W} ${H}`}
      className="block w-full focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
      onMouseMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') setHover((h) => Math.min((h ?? -1) + 1, points.length - 1));
        else if (e.key === 'ArrowLeft') setHover((h) => Math.max((h ?? points.length) - 1, 0));
        else if (e.key === 'Escape') setHover(null);
        else return;
        e.preventDefault();
      }}
    >
      <defs>
        <linearGradient id="hm-cost-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--hm-accent)" stopOpacity="0.18" />
          <stop offset="1" stopColor="var(--hm-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {gridValues.map((v) => (
        <g key={v}>
          <line className="stroke-hairline" x1={PAD_L} y1={yOf(v)} x2={W - PAD_R} y2={yOf(v)} />
          <text className="fill-muted tabular-nums" fontSize="10" textAnchor="end" x={PAD_L - 6} y={yOf(v) + 3}>
            {usd(v)}
          </text>
        </g>
      ))}
      <line className="stroke-hairline" x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} />

      <path d={area} fill="url(#hm-cost-fill)" />
      <path d={line} className="stroke-accent" fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle className="fill-accent" cx={last.x} cy={last.y} r="3.5" />
      {hover === null && (
        <text className="fill-ink tabular-nums" fontSize="11" fontWeight="600" x={last.x + 8} y={last.y + 4}>
          {`${last.incomplete ? '≥' : ''}${usd(last.totalUsd ?? 0)}`}
        </text>
      )}

      {labeled.map((p) => (
        <text key={p.day} className="fill-muted" fontSize="10" textAnchor="middle" x={p.x} y={H - PAD_B + 16}>
          {short ? dayLabel(p.day) : dateLabel(p.day)}
        </text>
      ))}

      {hovered && (
        <g>
          <line className="stroke-edge" x1={hovered.x} y1={PAD_T} x2={hovered.x} y2={H - PAD_B} />
          <circle className="fill-accent" cx={hovered.x} cy={hovered.y} r="3.5" />
          {(() => {
            const label = `${dateLabel(hovered.day)}  ${hovered.totalUsd === null ? 'unpriced' : `${hovered.incomplete ? '≥' : ''}${usd(hovered.totalUsd)}`}`;
            const w = label.length * 6.2 + 16;
            const x = Math.min(Math.max(hovered.x - w / 2, PAD_L), W - PAD_R - w);
            return (
              <g>
                {/* Separation reads in both themes: a 1px edge stroke (the pure-black
                    drop-shadow alone vanished on dark) plus a softened shadow. */}
                <rect
                  className="fill-surface stroke-edge"
                  strokeWidth="1"
                  filter="drop-shadow(0 1px 2px rgb(0 0 0 / 0.12))"
                  height="22"
                  rx="6"
                  width={w}
                  x={x}
                  y={PAD_T}
                />
                <text className="fill-ink" fontSize="10.5" x={x + 8} y={PAD_T + 14.5}>
                  {label}
                </text>
              </g>
            );
          })()}
        </g>
      )}
    </svg>
  );
}
