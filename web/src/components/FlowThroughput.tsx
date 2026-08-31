import { formatCost, usd } from '../cost';
import { card } from '../ui';
import {
  attemptsPerTaskBars,
  attemptsPerTaskTotal,
  costPerMergedTaskFigure,
  costSplit,
  mergedDaySeries,
  mergedPerDayAverage,
  totalMerged,
  type AttemptsPerTask,
  type CostPerMergedTask,
  type MergedDay,
} from './flow-throughput-model';

const LABEL = 'text-label font-semibold uppercase mb-1.5 text-muted';

const SPARK_W = 300;
const SPARK_H = 40;
const SPARK_PAD = 2;

function MergedSparkline({ series, total }: { series: MergedDay[]; total: number }) {
  const max = Math.max(...series.map((p) => p.count), 1);
  const x = (i: number) => SPARK_PAD + (i / (series.length - 1)) * (SPARK_W - SPARK_PAD * 2);
  const y = (v: number) => SPARK_H - SPARK_PAD - (v / max) * (SPARK_H - SPARK_PAD * 2);
  const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.count).toFixed(1)}`).join(' ');
  const area = `${line} L${x(series.length - 1).toFixed(1)} ${SPARK_H - SPARK_PAD} L${x(0).toFixed(1)} ${SPARK_H - SPARK_PAD} Z`;

  return (
    <figure className="mt-3" role="img" aria-label={`Tasks merged per day, ${total} total.`}>
      <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className="h-10 w-full">
        <line
          x1={0}
          y1={SPARK_H - SPARK_PAD}
          x2={SPARK_W}
          y2={SPARK_H - SPARK_PAD}
          stroke="var(--hm-edge)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <path d={area} fill="var(--hm-accent)" fillOpacity={0.12} stroke="none" />
        <path
          d={line}
          fill="none"
          stroke="var(--hm-accent)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </figure>
  );
}

function MergedPerDayCard({ tasksMergedByDay, from, to }: { tasksMergedByDay: MergedDay[]; from: number; to: number }) {
  const avg = mergedPerDayAverage(tasksMergedByDay);
  const series = mergedDaySeries(tasksMergedByDay, from, to);
  const total = totalMerged(tasksMergedByDay);

  return (
    <div className={`${card} p-5`}>
      <div className={LABEL}>Tasks merged / day</div>
      {avg === null ? (
        <p className="text-muted">No merges in range.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-1.5">
            <span className="text-title font-semibold tabular-nums text-ink">{avg.toFixed(avg < 10 ? 1 : 0)}</span>
            <span className="text-label text-muted">avg / day</span>
          </div>
          {series.length >= 2 && <MergedSparkline series={series} total={total} />}
        </>
      )}
    </div>
  );
}

const HISTO_BAR_H = 64;

function AttemptsPerTaskCard({ attemptsPerTask }: { attemptsPerTask: AttemptsPerTask }) {
  const bars = attemptsPerTaskBars(attemptsPerTask);
  const total = attemptsPerTaskTotal(attemptsPerTask);
  const max = Math.max(...bars.map((b) => b.count), 1);
  const ariaLabel = `Attempts per task: ${bars.map((b) => `${b.count} at ${b.label}`).join(', ')}`;

  return (
    <div className={`${card} p-5`}>
      <div className={LABEL}>Attempts per task</div>
      {total === 0 ? (
        <p className="text-muted">No merged tasks yet.</p>
      ) : (
        <>
          <div className="flex items-end gap-3" role="img" aria-label={ariaLabel}>
            {bars.map((b) => {
              const h = b.count === 0 ? 0 : Math.max(2, (b.count / max) * HISTO_BAR_H);
              return (
                <div key={b.bucket} className="flex flex-1 flex-col items-center gap-1">
                  <span className="text-label tabular-nums text-muted">{b.count}</span>
                  <div className="flex h-16 w-full items-end">
                    <div className="w-full rounded-t bg-accent" style={{ height: `${h}px` }} />
                  </div>
                  <span className="text-label text-faint">{b.label}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-label text-muted">self-heal depth · lower is better</p>
        </>
      )}
    </div>
  );
}

function CostPerMergedTaskCard({ costPerMergedTask }: { costPerMergedTask: CostPerMergedTask }) {
  const figure = costPerMergedTaskFigure(costPerMergedTask);
  const split = costSplit(costPerMergedTask);
  const wastedText = formatCost(costPerMergedTask.wastedCost);

  return (
    <div className={`${card} p-5`}>
      <div className={LABEL}>Cost / merged task</div>
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className={`text-title font-semibold tabular-nums ${figure === null ? 'text-faint' : 'text-ink'}`}>
          {figure === null ? '—' : `${figure.isFloor ? '≥ ' : ''}${usd(figure.value)}`}
        </span>
        <span className="text-label text-muted">per merged task</span>
        {wastedText && <span className="text-label text-muted">· {wastedText} wasted</span>}
      </div>

      {split && (
        <div className="mt-3">
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-raised" aria-hidden="true">
            <div className="h-full" style={{ width: `${split.mergedPct}%`, background: 'var(--hm-merged-dot)' }} />
            <div className="h-full" style={{ width: `${split.wastedPct}%`, background: 'var(--hm-fail-dot)' }} />
          </div>
          <span className="sr-only">
            {`${split.isFloor ? 'approximately ' : ''}${Math.round(split.mergedPct)}% merged, ${Math.round(
              split.wastedPct,
            )}% wasted${split.isFloor ? ' (some spend unpriced)' : ''}`}
          </span>
          <div className="mt-1.5 flex gap-3 text-label text-muted">
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full" style={{ background: 'var(--hm-merged-dot)' }} /> merged
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full" style={{ background: 'var(--hm-fail-dot)' }} /> wasted
            </span>
          </div>
          {split.isFloor && <p className="mt-1 text-label text-faint">Some spend unpriced — split is approximate.</p>}
        </div>
      )}
    </div>
  );
}

export function FlowThroughput({
  tasksMergedByDay,
  attemptsPerTask,
  costPerMergedTask,
  from,
  to,
}: {
  tasksMergedByDay: MergedDay[];
  attemptsPerTask: AttemptsPerTask;
  costPerMergedTask: CostPerMergedTask;
  from: number;
  to: number;
}) {
  return (
    <section className="mb-4">
      <h2 className="mb-3 text-title font-semibold">Flow &amp; throughput</h2>
      <div className="grid gap-4 md:grid-cols-3">
        <MergedPerDayCard tasksMergedByDay={tasksMergedByDay} from={from} to={to} />
        <AttemptsPerTaskCard attemptsPerTask={attemptsPerTask} />
        <CostPerMergedTaskCard costPerMergedTask={costPerMergedTask} />
      </div>
    </section>
  );
}
