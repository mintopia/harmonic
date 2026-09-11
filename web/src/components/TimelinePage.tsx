import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Attempt, TimelineAttempt } from '../types';
import { taskLabel } from '../id-format.js';
import { formatCost } from '../cost';
import { displayTitle } from '../ui';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { PageHeader } from './PageHeader';

type RangeKey = '24h' | '7d';
const RANGES: { key: RangeKey; label: string; ms: number }[] = [
  { key: '24h', label: '24h', ms: 24 * 3600_000 },
  { key: '7d', label: '7d', ms: 7 * 24 * 3600_000 },
];

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

const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtClockSec = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function fmtTick(ms: number, range: RangeKey): string {
  const d = new Date(ms);
  return range === '24h'
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
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
  const [range, setRange] = useState<RangeKey>('24h');
  const [attempts, setAttempts] = useState<TimelineAttempt[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Cursor as epoch ms, or null while pinned live to "now" (the right edge).
  const [cursor, setCursor] = useState<number | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [inspect, setInspect] = useState<Inspect>(null);

  const windowMs = RANGES.find((r) => r.key === range)!.ms;
  const to = now;
  const from = now - windowMs;
  const cursorMs = cursor === null ? to : Math.min(to, Math.max(from, cursor));

  const loadRef = useRef(0);
  useEffect(() => {
    if (workspaceId === null) return;
    const request = ++loadRef.current;
    const load = () => {
      const end = Date.now();
      api
        .timeline(workspaceId, end - windowMs, end)
        .then((res) => {
          if (request !== loadRef.current) return;
          setAttempts(res.attempts);
          setNow(end);
        })
        .catch(() => request === loadRef.current && setAttempts([]));
    };
    setAttempts(null);
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [workspaceId, windowMs]);

  // Live clock: advance "now" between polls so running bars grow and the pinned
  // cursor tracks the right edge, without refetching.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(tick);
  }, []);

  const lanes = useMemo<Lane[]>(() => {
    if (!attempts) return [];
    const byHarness = new Map<string, TimelineAttempt[]>();
    for (const span of attempts) {
      const list = byHarness.get(span.harness) ?? [];
      list.push(span);
      byHarness.set(span.harness, list);
    }
    return [...byHarness.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([harness, spans]) => packLane(harness, spans, now));
  }, [attempts, now]);

  const ticks = useMemo(() => {
    const count = range === '24h' ? 8 : 7;
    return Array.from({ length: count + 1 }, (_, i) => {
      const t = from + (i * (to - from)) / count;
      return { pct: (i / count) * 100, label: fmtTick(t, range) };
    });
  }, [from, to, range]);

  const pctOf = (ms: number) => ((Math.min(to, Math.max(from, ms)) - from) / (to - from)) * 100;
  const cursorPct = pctOf(cursorMs);
  const runningNow = attempts?.filter((a) => a.endedAt === null).length ?? 0;

  if (workspaceId === null) {
    return (
      <EmptyState title="No workspace open" className="mt-24">
        The Timeline scrubs one workspace's attempt history. Open a workspace to see the fleet's day.
      </EmptyState>
    );
  }

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

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Timeline"
        description="Every attempt the fleet has run, on one clock"
        actions={
          <div
            role="group"
            aria-label="Time range"
            className="flex gap-0.5 rounded-md border border-hairline bg-surface p-0.5"
          >
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                aria-pressed={range === r.key}
                onClick={() => {
                  setRange(r.key);
                  setCursor(null);
                }}
                className={`min-h-8 rounded-[6px] px-3 text-small font-medium transition-colors ${
                  range === r.key ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      {/* Readout: fleet state at the cursor */}
      <div className="flex flex-wrap items-stretch gap-3">
        <div className="flex min-w-[152px] flex-col justify-center rounded-lg border border-hairline bg-surface px-4 py-3">
          <span className="font-data text-display tabular-nums leading-none text-ink">{fmtClock(cursorMs)}</span>
          <span className="mt-1 text-small text-muted">
            {cursor === null ? 'now · live' : new Date(cursorMs).toLocaleDateString([], { weekday: 'short', day: 'numeric' })}
          </span>
        </div>
        <div className="grid flex-1 content-center gap-x-6 gap-y-1.5 rounded-lg border border-hairline bg-surface px-4 py-3 sm:grid-cols-2">
          {lanes.length === 0 ? (
            <span className="text-small text-muted">No harness activity at this moment.</span>
          ) : (
            lanes.map((lane) => {
              const active = lane.spans.find((s) => cursorMs >= s.startedAt && cursorMs <= (s.endedAt ?? now));
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

      {/* Lanes + scrubbable playhead */}
      {attempts === null ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-hairline bg-surface text-muted">
          Loading timeline…
        </div>
      ) : attempts.length === 0 ? (
        <EmptyState title="No attempts in this window" className="my-10">
          Nothing ran in the last {range === '24h' ? '24 hours' : '7 days'}. Attempts appear here as the fleet works —
          widen the range or run a task.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-hairline bg-surface shadow-card">
          <div className="overflow-x-auto">
          <div className="min-w-[720px]">
          {/* hour ruler */}
          <div className="grid border-b border-hairline bg-shell" style={{ gridTemplateColumns: `${LABEL_W}px 1fr` }}>
            <div className="border-r border-hairline px-3 py-1.5 text-label uppercase tracking-wide text-faint">
              {runningNow > 0 ? `${runningNow} running` : 'fleet'}
            </div>
            <div className="relative h-7">
              {ticks.map((t, i) => (
                <span
                  key={i}
                  className="absolute top-1.5 whitespace-nowrap font-data text-data tabular-nums text-faint"
                  style={{
                    left: `${t.pct}%`,
                    transform: i === 0 ? 'none' : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                  }}
                >
                  {t.label}
                </span>
              ))}
            </div>
          </div>

          {/* lanes */}
          <div className="relative">
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
                  {lane.spans.map((span) => {
                    const st = styleFor(span.state);
                    const left = pctOf(span.startedAt);
                    const width = Math.max(1.2, pctOf(span.endedAt ?? now) - left);
                    return (
                      <button
                        key={span.attemptId}
                        type="button"
                        onClick={() => setInspect({ span })}
                        onMouseEnter={(e) => setHover({ span, rect: e.currentTarget.getBoundingClientRect() })}
                        onMouseLeave={() => setHover((h) => (h?.span.attemptId === span.attemptId ? null : h))}
                        onFocus={(e) => setHover({ span, rect: e.currentTarget.getBoundingClientRect() })}
                        onBlur={() => setHover((h) => (h?.span.attemptId === span.attemptId ? null : h))}
                        aria-label={`${span.trackerRef ? `#${span.trackerRef}` : taskLabel(span.taskId)} ${span.title}, ${st.label}, attempt ${span.number}. Inspect steps.`}
                        className={`absolute flex items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border-l-[3px] px-2 text-small font-medium text-ink transition-[filter,transform] hover:z-10 hover:-translate-y-px hover:brightness-110 ${st.bar}`}
                        style={{ left: `${left}%`, width: `${width}%`, top: span.row * ROW_H + 5, height: ROW_H - 8 }}
                      >
                        {span.state === 'running' && (
                          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-running motion-reduce:animate-none" aria-hidden="true" />
                        )}
                        <span className="truncate">{span.title}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* gridlines + playhead, over the track region only */}
            <div className="pointer-events-none absolute inset-y-0 right-0" style={{ left: LABEL_W }}>
              {ticks.slice(1, -1).map((t, i) => (
                <span key={i} className="absolute inset-y-0 w-px bg-hairline/60" style={{ left: `${t.pct}%` }} />
              ))}
              <div className="absolute inset-y-0 w-0.5 bg-accent shadow-[0_0_10px_var(--color-accent)]" style={{ left: `${cursorPct}%` }}>
                <span className="absolute -left-[5px] -top-px size-3 rounded-full bg-accent ring-4 ring-canvas" />
              </div>
            </div>
          </div>
          </div>
          </div>
        </div>
      )}

      {/* scrubber */}
      <div className="flex items-center gap-4">
        <span className="hidden text-small text-faint sm:inline">{fmtClock(from)}</span>
        <input
          id="timeline-scrubber"
          type="range"
          aria-label="Scrub time"
          min={from}
          max={to}
          value={cursorMs}
          step={Math.max(1000, Math.round((to - from) / 1000))}
          onChange={(e) => {
            const v = Number(e.target.value);
            setCursor(v >= to - 1000 ? null : v);
          }}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-raised accent-accent"
          style={{
            background: `linear-gradient(90deg, var(--color-accent) ${cursorPct}%, var(--color-raised) ${cursorPct}%)`,
          }}
        />
        <button
          type="button"
          onClick={() => setCursor(null)}
          disabled={cursor === null}
          className="min-h-8 rounded-md border border-hairline bg-surface px-3 text-small font-medium text-ink transition-colors hover:border-edge hover:bg-raised disabled:cursor-default disabled:opacity-45 disabled:hover:bg-surface"
        >
          Jump to now
        </button>
      </div>

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
