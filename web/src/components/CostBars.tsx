import { usd } from '../cost';
import { costFloor, type DayCost } from './costChart-model';

const dateLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const dayLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short' });

/**
 * Cost per day as a compact bar chart (DESIGN.md § Charts): one cobalt series,
 * a friendly 1/2/5×10ⁿ ceiling, ≤~12 date labels. Honest numbers — an
 * unpriceable day is a hollow dashed column (no value asserted), never a zero
 * bar; a day whose cost is a floor tooltips with a "≥". Replaces the old
 * full-width area chart with something that reads at a glance and stays small.
 */
export function CostBars({ series }: { series: DayCost[] }) {
  const max = Math.max(...series.map((s) => s.totalUsd ?? 0), 0.01);
  const pow = 10 ** Math.floor(Math.log10(max));
  const ceil = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= max) ?? max;

  const short = series.length <= 8;
  const step = Math.max(1, Math.ceil(series.length / 12));
  const { total, isFloor } = costFloor(series);
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last) return null;

  return (
    <figure
      role="img"
      aria-label={`Cost per day, ${dateLabel(first.day)} to ${dateLabel(last.day)}, totalling ${isFloor ? 'at least ' : ''}${usd(total)}.`}
    >
      <div className="flex h-28 items-end gap-1">
        {series.map((s) => {
          const title = `${dateLabel(s.day)} · ${s.totalUsd === null ? 'unpriced' : `${s.incomplete ? '≥' : ''}${usd(s.totalUsd)}`}`;
          const h = s.totalUsd === null ? 100 : (s.totalUsd / ceil) * 100;
          return (
            <div key={s.day} className="flex h-full flex-1 items-end" title={title}>
              {s.totalUsd === null ? (
                <div className="h-full w-full rounded-sm border border-dashed border-edge" />
              ) : (
                <div
                  className="w-full rounded-sm bg-accent"
                  style={{ height: `${s.totalUsd === 0 ? 0 : Math.max(3, h)}%` }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-1">
        {series.map((s, i) => (
          <div key={s.day} className="flex-1 truncate text-center text-[10px] text-muted">
            {i % step === 0 || i === series.length - 1 ? (short ? dayLabel(s.day) : dateLabel(s.day)) : ''}
          </div>
        ))}
      </div>
    </figure>
  );
}
