import { useEffect, useState } from 'react';
import { api } from '../api';
import { card } from '../ui';
import type { DayCost } from './costChart-model';
import { buildHeatmap, HEATMAP_WEEKS, type Heatmap } from './heatmap-model';

const DAY_MS = 24 * 3600_000;
const CELL = 11;
const STEP = 14; // cell + gap
const LEFT = 26; // gutter for weekday labels
const TOP = 16; // gutter for month labels
const RADIUS = 2;
const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

const fullDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const monthLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short' });
const rangeLabel = (from: number, to: number) =>
  `${new Date(from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${new Date(to).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

/** Month labels along the top: one per column where the month first appears. */
function monthTicks(hm: Heatmap): { x: number; label: string }[] {
  const ticks: { x: number; label: string }[] = [];
  let prev = -1;
  hm.weeks.forEach((col, w) => {
    const anchor = col.find((c) => c !== null);
    if (!anchor) return;
    const month = new Date(anchor.day).getMonth();
    if (month !== prev) {
      ticks.push({ x: LEFT + w * STEP, label: monthLabel(anchor.day) });
      prev = month;
    }
  });
  return ticks;
}

export function AttemptHeatmap({ workspaceId }: { workspaceId: number | null }) {
  // Capture `now` at fetch time so the grid's "today" stays stable across
  // re-renders (a bare Date.now() in render is impure and drifts the anchor).
  const [loaded, setLoaded] = useState<{ series: DayCost[]; now: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceId === null) return;
    // Fixed trailing window, deliberately independent of the KPI range toggle —
    // fetch a hair wider than the grid so the Sunday-anchored window is fully
    // covered, then buildHeatmap trims and gap-fills. Same /stats reader path.
    const now = Date.now();
    const from = now - (HEATMAP_WEEKS + 1) * 7 * DAY_MS;
    let cancelled = false;
    setError(null);
    api
      .stats(from, now, workspaceId)
      .then((s) => !cancelled && setLoaded({ series: s.series, now }))
      .catch((e) => {
        if (cancelled) return;
        setLoaded(null);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const hm = loaded ? buildHeatmap(loaded.series, loaded.now) : null;
  const cols = HEATMAP_WEEKS;
  const width = LEFT + cols * STEP;
  const height = TOP + 7 * STEP;

  return (
    <section className={`${card} mb-4 p-5`}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-title font-semibold">Attempt activity</h2>
        <span className="text-small text-muted">Last {HEATMAP_WEEKS} weeks · fixed window, independent of the range above</span>
      </div>

      {error && <p className="text-muted">Couldn’t load activity: {error}</p>}
      {!hm && !error && <p className="text-muted">Loading…</p>}

      {hm && (
        <>
          <div className="overflow-x-auto">
            <svg
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={`Attempt activity: ${hm.total.toLocaleString()} attempts over the last ${HEATMAP_WEEKS} weeks, ${rangeLabel(hm.from, hm.to)}.`}
            >
              {monthTicks(hm).map(({ x, label }) => (
                <text key={`${x}-${label}`} x={x} y={10} className="fill-muted" fontSize="9">
                  {label}
                </text>
              ))}
              {WEEKDAY_LABELS.map((label, row) =>
                label ? (
                  <text key={row} x={0} y={TOP + row * STEP + CELL - 1} className="fill-muted" fontSize="9">
                    {label}
                  </text>
                ) : null,
              )}
              {hm.weeks.map((col, w) =>
                col.map((cell, row) =>
                  cell ? (
                    <rect
                      key={cell.day}
                      x={LEFT + w * STEP}
                      y={TOP + row * STEP}
                      width={CELL}
                      height={CELL}
                      rx={RADIUS}
                      fill={`var(--hm-heat-${cell.level})`}
                    >
                      <title>{`${fullDate(cell.day)} · ${cell.attempts.toLocaleString()} attempt${cell.attempts === 1 ? '' : 's'}`}</title>
                    </rect>
                  ) : null,
                ),
              )}
            </svg>
          </div>

          <div className="mt-2 flex items-center gap-1.5 text-small text-muted">
            <span>Less</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <span
                key={level}
                className="inline-block size-3 rounded-[2px]"
                style={{ backgroundColor: `var(--hm-heat-${level})` }}
                aria-hidden="true"
              />
            ))}
            <span>More</span>
          </div>
        </>
      )}
    </section>
  );
}
