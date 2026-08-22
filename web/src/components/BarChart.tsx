export interface Bar {
  key: string;
  label?: string;
  value: number;
  valueLabel: string;
}

export function BarChart({
  bars,
  ariaLabel,
  columns,
}: {
  bars: Bar[];
  ariaLabel?: string;
  columns?: { label: string; value: string };
}) {
  const max = Math.max(...bars.map((b) => b.value), 1);
  const ROW = 'grid grid-cols-[minmax(4rem,7rem)_1fr_auto] items-center gap-3';
  const track = (b: Bar) => (
    <span className="h-2 overflow-hidden rounded-full bg-raised" aria-hidden="true">
      <span
        className="block h-full rounded-full bg-accent"
        style={{ width: `${Math.max(3, (b.value / max) * 100)}%` }}
      />
    </span>
  );
  if (columns) {
    return (
      <div role="table" aria-label={ariaLabel} className="flex flex-col gap-2.5">
        <div role="rowgroup">
          <div role="row" className="sr-only">
            <span role="columnheader">{columns.label}</span>
            <span role="columnheader">{columns.value}</span>
          </div>
        </div>
        <div role="rowgroup" className="flex flex-col gap-2.5">
          {bars.map((b) => (
            <div key={b.key} role="row" className={ROW}>
              <span role="cell" className="truncate text-data text-ink" title={b.label ?? b.key}>
                {b.label ?? b.key}
              </span>
              {track(b)}
              <span role="cell" className="whitespace-nowrap text-right text-data tabular-nums text-muted">
                <span className="sr-only">{columns.value}: </span>
                {b.valueLabel}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2.5" aria-label={ariaLabel}>
      {bars.map((b) => (
        <li key={b.key} className={ROW}>
          <span className="truncate text-data text-ink" title={b.label ?? b.key}>
            {b.label ?? b.key}
          </span>
          {track(b)}
          <span className="whitespace-nowrap text-right text-data tabular-nums text-muted">{b.valueLabel}</span>
        </li>
      ))}
    </ul>
  );
}
