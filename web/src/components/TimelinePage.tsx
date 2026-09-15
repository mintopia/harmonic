import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Attempt, TimelineAttempt } from '../types';
import { taskLabel } from '../id-format.js';
import { formatCost } from '../cost';
import { displayTitle } from '../ui';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { PageHeader } from './PageHeader';

const H = 3600_000;
const DAY = 24 * H;
const MINUTE = 60_000;
/** Fixed zoom stops, widest → tightest. All integer ms, so the visible window's
 * edges stay whole and never send a fractional timestamp to the API (the
 * timeline route validates from/to as integers). */
const ZOOM_LEVELS = [30 * DAY, 7 * DAY, DAY, 12 * H, 6 * H, 4 * H, 2 * H, H, 30 * MINUTE];
const MAX_WINDOW = ZOOM_LEVELS[0]!;
const MIN_WINDOW = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!;
const DEFAULT_WINDOW = DAY;

/** Tick spacings the ruler snaps to: the coarsest that still yields <= ~8 ticks
 * across the visible window, so labels stay aligned and uncrowded at any zoom. */
const TICK_STEPS = [
  60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000,
  H, 2 * H, 3 * H, 6 * H, 12 * H,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY,
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Snap an epoch-ms edge to the nearest whole second. Continuous drag/zoom maths
 * yields fractional ms, and the timeline route rejects non-integer from/to. */
const toSecond = (ms: number) => Math.round(ms / 1000) * 1000;

/** The zoom stop nearest `windowMs`, stepped by `dir` (+1 tighter, -1 wider). */
const stepZoom = (windowMs: number, dir: 1 | -1) => {
  let idx = 0;
  for (let i = 1; i < ZOOM_LEVELS.length; i++) {
    if (Math.abs(ZOOM_LEVELS[i]! - windowMs) < Math.abs(ZOOM_LEVELS[idx]! - windowMs)) idx = i;
  }
  return ZOOM_LEVELS[clamp(idx + dir, 0, ZOOM_LEVELS.length - 1)]!;
};

/** Attempt state → Paper state vocabulary. A passed Attempt wears merged-emerald,
 * an escalated one the indigo "needs you" voice, a cancelled one slate. */
const STATE_STYLE: Record<string, { bar: string; dot: string; text: string; label: string }> = {
  running: { bar: 'border-running bg-running-tint', dot: 'bg-running', text: 'text-running', label: 'Running' },
  passed: { bar: 'border-merged bg-merged-tint', dot: 'bg-merged', text: 'text-merged', label: 'Passed' },
  failed: { bar: 'border-fail bg-fail-tint', dot: 'bg-fail', text: 'text-fail', label: 'Failed' },
  escalated: { bar: 'border-await bg-await-tint', dot: 'bg-await', text: 'text-await', label: 'Escalated' },
  cancelled: { bar: 'border-blocked bg-blocked-tint', dot: 'bg-blocked', text: 'text-blocked', label: 'Cancelled' },
};
const styleFor = (state: string) => STATE_STYLE[state] ?? STATE_STYLE.cancelled!;

const STEP_LANES: { type: string; label: string }[] = [
  { type: 'rebase', label: 'Rebase' },
  { type: 'implementation', label: 'Implement' },
  { type: 'verification', label: 'Verify' },
  { type: 'review', label: 'Review' },
];
const STEP_STYLE: Record<string, { bar: string; dot: string; text: string; label: string }> = {
  running: { bar: 'border-running bg-running-tint', dot: 'bg-running', text: 'text-running', label: 'Running' },
  passed: { bar: 'border-merged bg-merged-tint', dot: 'bg-merged', text: 'text-merged', label: 'Passed' },
  failed: { bar: 'border-fail bg-fail-tint', dot: 'bg-fail', text: 'text-fail', label: 'Failed' },
  skipped: { bar: 'border-blocked bg-blocked-tint', dot: 'bg-blocked', text: 'text-blocked', label: 'Skipped' },
  cancelled: { bar: 'border-blocked bg-blocked-tint', dot: 'bg-blocked', text: 'text-blocked', label: 'Cancelled' },
  pending: { bar: 'border-edge bg-raised', dot: 'bg-edge', text: 'text-muted', label: 'Pending' },
};
const stepStyleFor = (state: string) => STEP_STYLE[state] ?? STEP_STYLE.pending!;

function WorkspaceBadge({ workspace }: { workspace: TimelineAttempt['workspace'] }) {
  return (
    <span
      role="img"
      aria-label={`${workspace.name} workspace`}
      title={workspace.name}
      className="flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-[#1b1e24]"
      style={{ backgroundColor: workspace.color }}
    >
      {workspace.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

interface Placed extends TimelineAttempt {
  row: number;
}
interface Lane {
  harness: string;
  rows: number;
  spans: Placed[];
}

/** Greedy interval-partition the harness's Attempts into non-overlapping sub-rows. */
function packLane(harness: string, spans: TimelineAttempt[], now: number): Lane {
  const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt);
  const rowEnds: number[] = [];
  const placed: Placed[] = sorted.map((span) => {
    const end = span.endedAt ?? now;
    let row = rowEnds.findIndex((e) => e <= span.startedAt);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(end);
    } else {
      rowEnds[row] = end;
    }
    return { ...span, row };
  });
  return { harness, rows: Math.max(1, rowEnds.length), spans: placed };
}

const LABEL_W = 128;
const ROW_H = 30;
const MIN_TICK_LABEL_PX = 104;

const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtClockSec = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Ruler-tick label, granularity chosen by the visible span. */
function fmtTick(ms: number, span: number): string {
  const d = new Date(ms);
  if (span <= 2 * DAY) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (span <= 60 * DAY) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
}

/** Aligned tick marks: the coarsest ladder step that keeps ticks under `maxTicks`. */
function niceTicks(from: number, to: number, maxTicks: number): { ms: number; pct: number; label: string }[] {
  const span = Math.max(1, to - from);
  const target = span / Math.max(1, maxTicks);
  const step = TICK_STEPS.find((s) => s >= target) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  const out: { ms: number; pct: number; label: string }[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    out.push({ ms: t, pct: ((t - from) / span) * 100, label: fmtTick(t, span) });
  }
  return out;
}

/** Compact window-size readout for the zoom control: 5m, 45m, 24h, 36h, 7d, 30d. */
function fmtSpan(ms: number): string {
  const min = ms / 60_000;
  if (min < 90) return `${Math.round(min)}m`;
  const hr = ms / H;
  if (hr < 48) return `${Math.round(hr)}h`;
  return `${Math.round(ms / DAY)}d`;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

type Hover = { span: TimelineAttempt; rect: DOMRect } | null;
type Inspect = { span: TimelineAttempt } | null;

export function TimelinePage({
  workspaceId,
  onOpenTask,
}: {
  workspaceId: number | null;
  onOpenTask: (taskId: number) => void;
}) {
  // Continuous zoom: the visible span, clamped to [MIN_WINDOW, MAX_WINDOW].
  const [windowMs, setWindowMs] = useState<number>(DEFAULT_WINDOW);
  // Right edge of the visible window (epoch ms), or null while pinned live to now.
  const [anchor, setAnchor] = useState<number | null>(null);
  const [attempts, setAttempts] = useState<TimelineAttempt[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Readout time follows the pointer over the track; null = read the right edge.
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<Hover>(null);
  const [inspect, setInspect] = useState<Inspect>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(0);

  const to = anchor ?? now;
  const from = to - windowMs;
  const span = Math.max(1, to - from);
  // The track (and its wheel-zoom host) only mounts once a window has loaded.
  const trackMounted = attempts !== null;

  // Latest geometry for the native wheel + pointer handlers, which read this ref
  // rather than closing over stale state.
  const geo = useRef({ from, to, windowMs });
  useEffect(() => {
    geo.current = { from, to, windowMs };
  });

  /** Move/resize the window, capping the right edge at "now" and snapping to live
   * when it reaches the edge. */
  const applyWindow = (nextWindow: number, nextTo: number) => {
    const nowMs = Date.now();
    const w = clamp(nextWindow, MIN_WINDOW, MAX_WINDOW);
    const cappedTo = Math.min(nowMs, nextTo);
    setWindowMs(w);
    // Snap the anchor to a whole second so from/to reach the API as integers.
    setAnchor(cappedTo >= nowMs - 1000 ? null : toSecond(cappedTo));
  };

  const zoomBy = (dir: 1 | -1) => {
    const g = geo.current;
    // Anchor on the readout (pointer, else the right edge) so zooming holds the
    // focus in view instead of drifting toward the window centre — a live view
    // keeps its now-edge and recent runs stay on screen.
    const focus = hoverTime ?? g.to;
    const frac = clamp((focus - g.from) / Math.max(1, g.to - g.from), 0, 1);
    const w = stepZoom(g.windowMs, dir);
    applyWindow(w, focus + (1 - frac) * w);
  };
  const panBy = (frac: number) => {
    const g = geo.current;
    applyWindow(g.windowMs, g.to + frac * g.windowMs);
  };

  // Fetch the visible window, debounced so a drag or zoom collapses to one
  // request, and polled every 30s while live. Attempts persist across pans —
  // only a fresh workspace clears them back to the loading state.
  const loadRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      const end = anchor ?? Date.now();
      const start = end - windowMs;
      const request = ++loadRef.current;
      api
        .timeline(workspaceId ?? undefined, start, end)
        .then((res) => {
          if (cancelled || request !== loadRef.current) return;
          setAttempts(res.attempts);
          if (anchor === null) setNow(end);
        })
        .catch(() => !cancelled && request === loadRef.current && setAttempts([]));
    };
    const debounce = setTimeout(run, 180);
    const poll = anchor === null ? setInterval(run, 30_000) : null;
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      if (poll) clearInterval(poll);
    };
  }, [workspaceId, anchor, windowMs]);

  useEffect(() => {
    setAttempts(null);
  }, [workspaceId]);

  // Live clock: advance "now" between polls so running bars grow and the live
  // edge tracks real time, without refetching. Paused while panned to the past.
  useEffect(() => {
    if (anchor !== null) return;
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(tick);
  }, [anchor]);

  const lanes = useMemo<Lane[]>(() => {
    if (!attempts) return [];
    const byHarness = new Map<string, TimelineAttempt[]>();
    for (const s of attempts) {
      const list = byHarness.get(s.harness) ?? [];
      list.push(s);
      byHarness.set(s.harness, list);
    }
    return [...byHarness.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([harness, spans]) => packLane(harness, spans, now));
  }, [attempts, now]);

  // Measure the track region (the time axis, excluding the label gutter) so ticks
  // thin out instead of colliding at narrow widths.
  useEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    const measure = () => setTrackW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [attempts]);

  // Scroll-to-zoom, anchored on the pointer (native listener so we can
  // preventDefault the page scroll).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      const ax = axisRef.current?.getBoundingClientRect();
      const g = geo.current;
      const frac = ax ? clamp((e.clientX - ax.left) / Math.max(1, ax.width), 0, 1) : 0.5;
      const pt = g.from + frac * (g.to - g.from);
      // Scroll down zooms out (wider), up zooms in (tighter).
      const w = stepZoom(g.windowMs, e.deltaY > 0 ? -1 : 1);
      applyWindow(w, pt + (1 - frac) * w);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [trackMounted]);

  const ticks = useMemo(() => {
    const fit = clamp(Math.floor((trackW || 720) / MIN_TICK_LABEL_PX), 2, 8);
    return niceTicks(from, to, fit);
  }, [from, to, trackW]);

  const pctOf = (ms: number) => ((clamp(ms, from, to) - from) / span) * 100;
  const readTime = hoverTime ?? to;
  const readPct = pctOf(readTime);
  const runningNow = attempts?.filter((a) => a.endedAt === null).length ?? 0;

  // Drag-to-pan + hover-to-read, both off the same pointer stream. A drag past a
  // small threshold suppresses the bar click that would otherwise inspect.
  const dragRef = useRef<{ startX: number; startTo: number; id: number } | null>(null);
  // Set once a drag crosses the movement threshold. Pointer capture is deferred
  // until then so a plain click still lands on the bar (capturing on pointerdown
  // would retarget the click to the container and never inspect).
  const movedRef = useRef(false);

  const timeAtX = (clientX: number): number | null => {
    const ax = axisRef.current?.getBoundingClientRect();
    if (!ax) return null;
    const g = geo.current;
    const frac = clamp((clientX - ax.left) / Math.max(1, ax.width), 0, 1);
    return g.from + frac * (g.to - g.from);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startTo: geo.current.to, id: e.pointerId };
    movedRef.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag) {
      const ax = axisRef.current?.getBoundingClientRect();
      if (ax) {
        const dx = e.clientX - drag.startX;
        if (!movedRef.current && Math.abs(dx) > 3) {
          movedRef.current = true;
          setDragging(true);
          e.currentTarget.setPointerCapture(drag.id);
        }
        if (movedRef.current) {
          const dt = -(dx / Math.max(1, ax.width)) * geo.current.windowMs;
          applyWindow(geo.current.windowMs, drag.startTo + dt);
        }
      }
    }
    const t = timeAtX(e.clientX);
    if (t !== null) setHoverTime(t);
  };
  const endDrag = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (drag && e.currentTarget.hasPointerCapture?.(drag.id)) e.currentTarget.releasePointerCapture(drag.id);
  };
  const onPointerLeave = () => {
    if (!dragRef.current) setHoverTime(null);
  };

  if (inspect) {
    return (
      <AttemptInspector
        span={inspect.span}
        now={now}
        onClose={() => setInspect(null)}
        onOpenTask={onOpenTask}
      />
    );
  }

  const btn =
    'flex min-h-8 min-w-8 items-center justify-center rounded-[6px] px-2 text-small font-medium text-muted transition-colors hover:bg-raised hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted';

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Timeline" description={workspaceId === null ? 'Every workspace, merged on one clock' : 'Every attempt the fleet has run, on one clock'} />

      {/* zoom + pan controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label="Zoom"
          className="flex items-center gap-0.5 rounded-md border border-hairline bg-surface p-0.5"
        >
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(-1)} disabled={windowMs >= MAX_WINDOW} className={btn}>
            <span aria-hidden="true">−</span>
          </button>
          <span className="min-w-[52px] text-center font-data text-data tabular-nums text-ink">{fmtSpan(windowMs)}</span>
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1)} disabled={windowMs <= MIN_WINDOW} className={btn}>
            <span aria-hidden="true">+</span>
          </button>
        </div>

        <div
          role="group"
          aria-label="Pan"
          className="flex items-center gap-0.5 rounded-md border border-hairline bg-surface p-0.5"
        >
          <button type="button" aria-label="Pan back" onClick={() => panBy(-0.5)} disabled={windowMs >= MAX_WINDOW} className={btn}>
            <span aria-hidden="true">←</span>
          </button>
          <span className="min-w-[132px] px-1 text-center font-data text-data tabular-nums text-muted">
            {fmtTick(from, span)} – {anchor === null ? 'now' : fmtTick(to, span)}
          </span>
          <button type="button" aria-label="Pan forward" onClick={() => panBy(0.5)} disabled={anchor === null} className={btn}>
            <span aria-hidden="true">→</span>
          </button>
        </div>

        <button
          type="button"
          onClick={() => setAnchor(null)}
          disabled={anchor === null}
          className="ml-auto min-h-8 rounded-md border border-hairline bg-surface px-3 text-small font-medium text-ink transition-colors hover:border-edge hover:bg-raised disabled:cursor-default disabled:opacity-45 disabled:hover:bg-surface"
        >
          Jump to now
        </button>
      </div>

      {/* Readout: fleet state at the pointer (or the live edge) */}
      <div className="flex flex-wrap items-stretch gap-3">
        <div className="flex min-w-[152px] flex-col justify-center rounded-lg border border-hairline bg-surface px-4 py-3">
          <span className="font-data text-display tabular-nums leading-none text-ink">{fmtClock(readTime)}</span>
          <span className="mt-1 text-small text-muted">
            {hoverTime === null && anchor === null
              ? 'now · live'
              : new Date(readTime).toLocaleDateString([], { weekday: 'short', day: 'numeric' })}
          </span>
        </div>
        <div className="grid flex-1 content-center gap-x-6 gap-y-1.5 rounded-lg border border-hairline bg-surface px-4 py-3 sm:grid-cols-2">
          {lanes.length === 0 ? (
            <span className="text-small text-muted">No harness activity at this moment.</span>
          ) : (
            lanes.map((lane) => {
              const active = lane.spans.find((s) => readTime >= s.startedAt && readTime <= (s.endedAt ?? now));
              const st = active ? styleFor(active.state) : null;
              return (
                <div key={lane.harness} className="flex min-w-0 items-center gap-2.5 text-small">
                  <span className="w-16 shrink-0 font-data text-data text-faint">{lane.harness}</span>
                  <span className={`size-2 shrink-0 rounded-full ${st ? st.dot : 'bg-edge'}`} aria-hidden="true" />
                  <span className="min-w-0 truncate font-medium text-ink" title={active ? active.title : 'idle'}>
                    {active ? (
                      <>
                        <span className={st!.text}>{st!.label.toLowerCase()}</span>{' '}
                        <span className="text-muted">
                          {active.trackerRef ? `#${active.trackerRef}` : taskLabel(active.taskId)}
                        </span>{' '}
                        {active.title}
                      </>
                    ) : (
                      <span className="text-faint">idle</span>
                    )}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Lanes: scroll to zoom, drag to pan, hover to read */}
      {attempts === null ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-hairline bg-surface text-muted">
          Loading timeline…
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-hairline bg-surface shadow-card">
          <div
            ref={containerRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={onPointerLeave}
            className={`touch-none select-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          >
            {/* ruler */}
            <div className="grid border-b border-hairline bg-shell" style={{ gridTemplateColumns: `${LABEL_W}px 1fr` }}>
              <div className="border-r border-hairline px-3 py-1.5 text-label uppercase tracking-wide text-faint">
                {runningNow > 0 ? `${runningNow} running` : 'fleet'}
              </div>
              <div ref={axisRef} className="relative h-7">
                {ticks.map((t, i) => (
                  <span
                    key={i}
                    className="absolute top-1.5 whitespace-nowrap font-data text-data tabular-nums text-faint"
                    style={{
                      left: `${t.pct}%`,
                      transform: t.pct <= 1 ? 'none' : t.pct >= 99 ? 'translateX(-100%)' : 'translateX(-50%)',
                    }}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
            </div>

            {/* lanes */}
            <div className="relative">
              {lanes.length === 0 && (
                <div className="grid" style={{ gridTemplateColumns: `${LABEL_W}px 1fr` }}>
                  <div className="border-r border-hairline bg-shell/40" />
                  <div className="flex h-40 flex-col items-center justify-center gap-1 bg-sunken/40 px-4 text-center">
                    <span className="text-small font-medium text-ink">No attempts in this window</span>
                    <span className="text-small text-muted">
                      Nothing ran in the visible {fmtSpan(windowMs)} window. Zoom out or pan back to widen the view.
                    </span>
                  </div>
                </div>
              )}
              {lanes.map((lane) => (
                <div
                  key={lane.harness}
                  className="grid border-t border-hairline first:border-t-0"
                  style={{ gridTemplateColumns: `${LABEL_W}px 1fr` }}
                >
                  <div className="flex flex-col justify-center gap-0.5 border-r border-hairline bg-shell/40 px-3 py-2">
                    <span className="font-data text-data font-medium text-ink">{lane.harness}</span>
                    <span className="text-label text-faint">
                      {lane.spans.length} {lane.spans.length === 1 ? 'attempt' : 'attempts'}
                    </span>
                  </div>
                  <div className="relative bg-sunken/40" style={{ height: lane.rows * ROW_H + 8 }}>
                    {lane.spans.map((s) => {
                      const st = styleFor(s.state);
                      const left = pctOf(s.startedAt);
                      const width = Math.max(1.2, pctOf(s.endedAt ?? now) - left);
                      return (
                        <button
                          key={s.attemptId}
                          type="button"
                          onClick={() => {
                            if (movedRef.current) {
                              movedRef.current = false;
                              return;
                            }
                            setInspect({ span: s });
                          }}
                          onMouseEnter={(e) => setHover({ span: s, rect: e.currentTarget.getBoundingClientRect() })}
                          onMouseLeave={() => setHover((h) => (h?.span.attemptId === s.attemptId ? null : h))}
                          onFocus={(e) => setHover({ span: s, rect: e.currentTarget.getBoundingClientRect() })}
                          onBlur={() => setHover((h) => (h?.span.attemptId === s.attemptId ? null : h))}
                          aria-label={`${s.workspace.name}: ${s.trackerRef ? `#${s.trackerRef}` : taskLabel(s.taskId)} ${s.title}, ${st.label}, attempt ${s.number}. Inspect steps.`}
                          className={`absolute flex items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border-l-[3px] px-2 text-small font-medium text-ink transition-[filter,transform] hover:z-10 hover:-translate-y-px hover:brightness-110 ${st.bar}`}
                          style={{ left: `${left}%`, width: `${width}%`, top: s.row * ROW_H + 5, height: ROW_H - 8 }}
                        >
                          {s.state === 'running' && (
                            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-running motion-reduce:animate-none" aria-hidden="true" />
                          )}
                          <WorkspaceBadge workspace={s.workspace} />
                          <span className="truncate">{s.title}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* gridlines + playhead, over the track region only */}
              <div className="pointer-events-none absolute inset-y-0 right-0" style={{ left: LABEL_W }}>
                {ticks.map((t, i) => (
                  <span key={i} className="absolute inset-y-0 w-px bg-hairline/60" style={{ left: `${t.pct}%` }} />
                ))}
                <div className="absolute inset-y-0 w-0.5 bg-accent shadow-[0_0_10px_var(--color-accent)]" style={{ left: `${readPct}%` }}>
                  <span className="absolute -left-[5px] -top-px size-3 rounded-full bg-accent ring-4 ring-canvas" />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {hover && <HoverCard hover={hover} now={now} />}
    </div>
  );
}

/** Read-only popover pinned under the hovered bar: outcome, model, duration, cost. */
function HoverCard({ hover, now }: { hover: NonNullable<Hover>; now: number }) {
  const { span, rect } = hover;
  const st = styleFor(span.state);
  const end = span.endedAt ?? now;
  const cost = formatCost(span.cost);
  const CARD_W = 248;
  const below = rect.bottom + 8;
  const above = rect.top - 8;
  const openUp = below + 150 > window.innerHeight;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - CARD_W - 8);
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 rounded-lg border border-edge bg-shell p-3 shadow-float"
      style={{ width: CARD_W, left, top: openUp ? undefined : below, bottom: openUp ? window.innerHeight - above : undefined }}
    >
      <div className="flex items-center gap-2">
        <WorkspaceBadge workspace={span.workspace} />
        <span className="font-data text-data text-faint">
          {span.trackerRef ? `#${span.trackerRef}` : taskLabel(span.taskId)}
        </span>
        <span className={`ml-auto inline-flex items-center gap-1.5 text-label font-semibold ${st.text}`}>
          <span className={`size-1.5 rounded-full ${st.dot}`} aria-hidden="true" />
          {st.label}
        </span>
      </div>
      <div className="mt-1 text-small font-semibold leading-snug text-ink">{span.title}</div>
      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
        <dt className="text-muted">Harness</dt>
        <dd className="text-right font-data text-data text-ink">{span.harness}</dd>
        <dt className="text-muted">Model</dt>
        <dd className="truncate text-right font-data text-data text-ink" title={span.model}>{span.model}</dd>
        <dt className="text-muted">Duration</dt>
        <dd className="text-right tabular-nums text-ink">
          {span.endedAt ? fmtDuration(end - span.startedAt) : `${fmtDuration(end - span.startedAt)} · live`}
        </dd>
        <dt className="text-muted">Cost</dt>
        <dd className="text-right tabular-nums text-ink">{cost ?? '—'}</dd>
        <dt className="text-muted">Attempt</dt>
        <dd className="text-right tabular-nums text-ink">#{span.number}</dd>
      </dl>
      <div className="mt-2.5 border-t border-hairline pt-2 text-label text-faint">Click to step through the run</div>
    </div>
  );
}

/** Drill-in: one attempt's Steps as scrubbable lanes over the attempt's own window. */
function AttemptInspector({
  span,
  now,
  onClose,
  onOpenTask,
}: {
  span: TimelineAttempt;
  now: number;
  onClose: () => void;
  onOpenTask: (taskId: number) => void;
}) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [cursor, setCursor] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setState('loading');
    api
      .taskAttemptTimeline(span.taskId)
      .then((res) => {
        if (!live) return;
        const found = res.attempts.find((a) => a.id === span.attemptId) ?? null;
        setAttempt(found);
        setState('ready');
      })
      .catch(() => live && setState('error'));
    return () => {
      live = false;
    };
  }, [span.taskId, span.attemptId]);

  const from = span.startedAt;
  const to = span.endedAt ?? now;
  const span2 = Math.max(1, to - from);
  const cursorMs = cursor === null ? to : Math.min(to, Math.max(from, cursor));
  const pctOf = (ms: number) => ((Math.min(to, Math.max(from, ms)) - from) / span2) * 100;
  const st = styleFor(span.state);

  const stepsWithTime = (attempt?.steps ?? []).filter((s) => s.startedAt !== null);
  const activeStep = stepsWithTime.find((s) => cursorMs >= s.startedAt! && cursorMs <= (s.endedAt ?? now));

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onClose}
            className="mb-2 inline-flex items-center gap-1.5 text-small font-medium text-muted transition-colors hover:text-ink"
          >
            <Icon name="arrow-left" /> Timeline
          </button>
          <h1 className={`${displayTitle} flex items-center gap-2.5`}>
            <span className="font-data text-title text-faint">
              {span.trackerRef ? `#${span.trackerRef}` : taskLabel(span.taskId)}
            </span>
            <span className="truncate">{span.title}</span>
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted">
            <span className="inline-flex items-center gap-1.5"><WorkspaceBadge workspace={span.workspace} />{span.workspace.name}</span>
            <span aria-hidden="true">·</span>
            <span className={`inline-flex items-center gap-1.5 font-medium ${st.text}`}>
              <span className={`size-1.5 rounded-full ${st.dot}`} aria-hidden="true" />
              {st.label}
            </span>
            <span aria-hidden="true">·</span>
            <span>attempt #{span.number}</span>
            <span aria-hidden="true">·</span>
            <span className="font-data text-data">{span.harness} / {span.model}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{fmtDuration(to - from)}</span>
            {formatCost(span.cost) && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{formatCost(span.cost)}</span>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onOpenTask(span.taskId)}
          className="min-h-9 rounded-md border border-hairline bg-surface px-3 text-small font-medium text-ink transition-colors hover:border-edge hover:bg-raised"
        >
          Open task →
        </button>
      </header>

      {/* cursor readout */}
      <div className="flex flex-wrap items-stretch gap-3">
        <div className="flex min-w-[168px] flex-col justify-center rounded-lg border border-hairline bg-surface px-4 py-3">
          <span className="font-data text-display tabular-nums leading-none text-ink">{fmtClockSec(cursorMs)}</span>
          <span className="mt-1 text-small text-muted">{cursor === null ? 'run end' : 'at cursor'}</span>
        </div>
        <div className="flex flex-1 items-center rounded-lg border border-hairline bg-surface px-4 py-3">
          {activeStep ? (
            <span className="flex items-center gap-2.5 text-small">
              <span className={`size-2 rounded-full ${stepStyleFor(activeStep.state).dot}`} aria-hidden="true" />
              <span className="font-medium text-ink">
                {STEP_LANES.find((l) => l.type === activeStep.type)?.label ?? activeStep.type}
              </span>
              <span className={stepStyleFor(activeStep.state).text}>{stepStyleFor(activeStep.state).label.toLowerCase()}</span>
              {activeStep.command && <span className="truncate font-data text-data text-muted">{activeStep.command}</span>}
            </span>
          ) : (
            <span className="text-small text-faint">Between steps</span>
          )}
        </div>
      </div>

      {state === 'loading' ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-hairline bg-surface text-muted">
          Loading run…
        </div>
      ) : state === 'error' ? (
        <EmptyState title="Couldn't load the run" className="my-10">
          The attempt's step timeline couldn't be fetched. Open the task to see it in full.
        </EmptyState>
      ) : stepsWithTime.length === 0 ? (
        <EmptyState title="No steps recorded" className="my-10">
          This attempt hasn't logged any timed steps yet.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-hairline bg-surface shadow-card">
          <div className="relative">
            {STEP_LANES.filter((lane) => stepsWithTime.some((s) => s.type === lane.type)).map((lane) => (
              <div
                key={lane.type}
                className="grid border-t border-hairline first:border-t-0"
                style={{ gridTemplateColumns: `${LABEL_W}px 1fr` }}
              >
                <div className="flex items-center border-r border-hairline bg-shell/40 px-3 py-2">
                  <span className="font-data text-data font-medium text-ink">{lane.label}</span>
                </div>
                <div className="relative bg-sunken/40" style={{ height: ROW_H + 8 }}>
                  {stepsWithTime
                    .filter((s) => s.type === lane.type)
                    .map((step) => {
                      const style = stepStyleFor(step.state);
                      const left = pctOf(step.startedAt!);
                      const width = Math.max(1.2, pctOf(step.endedAt ?? now) - left);
                      return (
                        <div
                          key={step.id}
                          title={`${lane.label} · ${style.label} · ${fmtClockSec(step.startedAt!)}–${step.endedAt ? fmtClockSec(step.endedAt) : 'now'}${step.command ? ` · ${step.command}` : ''}`}
                          className={`absolute flex items-center overflow-hidden whitespace-nowrap rounded-md border-l-[3px] px-2 text-small font-medium text-ink ${style.bar}`}
                          style={{ left: `${left}%`, width: `${width}%`, top: 5, height: ROW_H - 8 }}
                        >
                          {step.state === 'running' && (
                            <span className="mr-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-running motion-reduce:animate-none" aria-hidden="true" />
                          )}
                          <span className="truncate">{step.verdict ?? style.label}</span>
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
            <div className="pointer-events-none absolute inset-y-0 right-0" style={{ left: LABEL_W }}>
              <div className="absolute inset-y-0 w-0.5 bg-accent shadow-[0_0_10px_var(--color-accent)]" style={{ left: `${pctOf(cursorMs)}%` }}>
                <span className="absolute -left-[5px] -top-px size-3 rounded-full bg-accent ring-4 ring-canvas" />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-4">
        <span className="hidden text-small text-faint sm:inline">{fmtClockSec(from)}</span>
        <input
          type="range"
          aria-label="Scrub run time"
          min={from}
          max={to}
          value={cursorMs}
          step={Math.max(1000, Math.round(span2 / 1000))}
          onChange={(e) => {
            const v = Number(e.target.value);
            setCursor(v >= to - 1000 ? null : v);
          }}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-raised accent-accent"
          style={{ background: `linear-gradient(90deg, var(--color-accent) ${pctOf(cursorMs)}%, var(--color-raised) ${pctOf(cursorMs)}%)` }}
        />
        <span className="hidden text-small text-faint sm:inline">{span.endedAt ? fmtClockSec(to) : 'now'}</span>
      </div>
    </div>
  );
}
