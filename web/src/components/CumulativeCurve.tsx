import { cumulative, formatMetric, METRIC_LABEL, type DayCost, type StatMetric } from './costChart-model';

const dateLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const W = 300;
const H = 56;
const PAD = 2;

/**
 * Cumulative curve for the selected metric, beneath the daily bars
 * (DESIGN.md § Stats: "a single-cobalt cost-per-day chart — 2px line, soft
 * area, faint grid, honest ≥ floor for partial days"). One cobalt series, a
 * soft accent-tint area fill, a faint baseline — a short strip, not a hero
 * chart. Scales to its container width via viewBox; height stays fixed.
 */
export function CumulativeCurve({ series, metric }: { series: DayCost[]; metric: StatMetric }) {
  const points = cumulative(series, metric);
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2) return null;

  const max = Math.max(...points.map((p) => p.value), metric === 'usd' ? 0.01 : 1);
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${H - PAD} L${x(0).toFixed(1)} ${H - PAD} Z`;

  const total = last.value;
  const totalLabel = `${last.isFloor ? 'at least ' : ''}${formatMetric(total, metric)}${metric === 'usd' ? '' : ` ${metric}`}`;

  return (
    <figure className="mt-3" role="img" aria-label={`Cumulative ${METRIC_LABEL[metric].toLowerCase()}, ${dateLabel(first.day)} to ${dateLabel(last.day)}, reaching ${totalLabel}.`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-14 w-full">
        {/* Faint baseline grid — the zero line the curve rises from. */}
        <line x1={0} y1={H - PAD} x2={W} y2={H - PAD} stroke="var(--hm-edge)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <path d={area} fill="var(--hm-accent)" fillOpacity={0.12} stroke="none" />
        <path d={line} fill="none" stroke="var(--hm-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}
