import { usd } from '../cost';
import { costFloor, formatMetric, metricValue, METRIC_LABEL, type DayCost, type StatMetric } from './costChart-model';

const dateLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const dayLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short' });

export function CostBars({ series, metric = 'usd' }: { series: DayCost[]; metric?: StatMetric }) {
  const values = series.map((s) => metricValue(s, metric) ?? 0);
  const max = Math.max(...values, metric === 'usd' ? 0.01 : 1);
  const pow = 10 ** Math.floor(Math.log10(max));
  const ceil = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= max) ?? max;

  const short = series.length <= 8;
  const step = Math.max(1, Math.ceil(series.length / 12));
  const { total, isFloor } = costFloor(series);
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last) return null;

  const totalLabel =
    metric === 'usd'
      ? `totalling ${isFloor ? 'at least ' : ''}${usd(total)}`
      : `totalling ${formatMetric(
          series.reduce((sum, s) => sum + (metricValue(s, metric) ?? 0), 0),
          metric,
        )} ${metric}`;

  return (
    <figure role="img" aria-label={`${METRIC_LABEL[metric]} per day, ${dateLabel(first.day)} to ${dateLabel(last.day)}, ${totalLabel}.`}>
      <div className="flex h-28 items-end gap-1">
        {series.map((s) => {
          const v = metricValue(s, metric);
          const unpriceable = metric === 'usd' && v === null;
          const title = `${dateLabel(s.day)} · ${
            metric === 'usd' && v === null ? 'unpriced' : `${metric === 'usd' && s.incomplete ? '≥' : ''}${formatMetric(v, metric)}`
          }`;
          const h = unpriceable ? 100 : ((v ?? 0) / ceil) * 100;
          return (
            <div key={s.day} className="flex h-full flex-1 items-end" title={title}>
              {unpriceable ? (
                <div className="h-full w-full rounded-sm border border-dashed border-edge" />
              ) : (
                <div
                  className="w-full rounded-sm bg-accent"
                  style={{ height: `${(v ?? 0) === 0 ? 0 : Math.max(3, h)}%` }}
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
