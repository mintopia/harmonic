export interface Bar {
  /** Stable react key + the accessible category name. */
  key: string;
  /** The row label (rendered left, truncated); defaults to `key`. */
  label?: string;
  /** The bar magnitude — bars scale to the largest value in the set. */
  value: number;
  /** The formatted figure shown at the row's right (e.g. "18.2M · $0.52"). */
  valueLabel: string;
}

/**
 * A compact horizontal bar chart for a categorical breakdown (tokens per
 * model, per agent-type, tool calls). One cobalt series only — the accent is
 * the interface's single chart voice (DESIGN.md § Charts, the One Cobalt
 * Rule); categories are told apart by their labels, never by colour. Bars
 * scale to the set's max, with a floor so the smallest non-zero row stays
 * visible.
 */
export function BarChart({ bars, ariaLabel }: { bars: Bar[]; ariaLabel?: string }) {
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <ul className="flex flex-col gap-2.5" aria-label={ariaLabel}>
      {bars.map((b) => (
        <li key={b.key} className="grid grid-cols-[minmax(4rem,7rem)_1fr_auto] items-center gap-3">
          <span className="truncate text-data text-ink" title={b.label ?? b.key}>
            {b.label ?? b.key}
          </span>
          <span className="h-2 overflow-hidden rounded-full bg-raised" aria-hidden="true">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.max(3, (b.value / max) * 100)}%` }}
            />
          </span>
          <span className="whitespace-nowrap text-right text-data tabular-nums text-muted">{b.valueLabel}</span>
        </li>
      ))}
    </ul>
  );
}
