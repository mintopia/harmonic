import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskState } from '../types';
import { graphEdges, mapBadges, nodeTitle, visibleTasks } from '../graph-model';
import { layoutGraph, type LaidNode, type Layout } from '../graph-layout';
import { Switch } from './Switch';
import { EmptyState } from './EmptyState';
import { displayTitle, labelType, touchTarget } from '../ui';

/**
 * The read-only Dependency Graph view (issue #85, ADR 0015). It renders the
 * active Workspace's Tasks as a DAG over their Dependency edges — native and
 * mirrored alike — using elkjs for layout and hand-rolled SVG for the render.
 * The visuals are the ones settled in the prototype (#84): left-right layout,
 * card nodes with a state stripe + label + native/mirrored glyph, Map
 * membership as a per-node badge + quiet label (no container box), edges tinted
 * by their source state, and pan/zoom/fit navigation. It is read-only — a node
 * click deep-links to the Task detail, where editing already lives.
 */

// ── State-signal palette (the Signal Rule — only true states get colour) ─────
interface Signal {
  color: string; // stripe / arrowhead / edge
  text: string; // readable state-label colour
}
const SIGNAL: Record<TaskState, Signal> = {
  draft: { color: 'var(--hm-faint)', text: 'var(--hm-muted)' },
  blocked: { color: 'var(--hm-blocked)', text: 'var(--hm-blocked)' },
  ready: { color: 'var(--hm-ready-dot)', text: 'var(--hm-ready)' },
  running: { color: 'var(--hm-running-dot)', text: 'var(--hm-running)' },
  'awaiting-review': { color: 'var(--hm-accent)', text: 'var(--hm-accent)' },
  completed: { color: 'var(--hm-accept-dot)', text: 'var(--hm-accept)' },
  failed: { color: 'var(--hm-fail-dot)', text: 'var(--hm-fail)' },
  cancelled: { color: 'var(--hm-faint)', text: 'var(--hm-muted)' },
};

const STATE_LABEL: Record<TaskState, string> = {
  draft: 'Draft',
  blocked: 'Blocked',
  ready: 'Ready',
  running: 'Running',
  'awaiting-review': 'Review',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const NODE_W = 196;
const NODE_H = 60;

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Transform {
  k: number;
  tx: number;
  ty: number;
}

/** Fit the content box into the viewport with padding, capped so a tiny graph
 * doesn't balloon. */
function fitTransform(w: number, h: number, vw: number, vh: number): Transform {
  if (w <= 0 || h <= 0 || vw <= 0 || vh <= 0) return { k: 1, tx: 0, ty: 0 };
  const pad = 48;
  const k = Math.min((vw - pad * 2) / w, (vh - pad * 2) / h, 1.5);
  return { k, tx: (vw - w * k) / 2, ty: (vh - h * k) / 2 };
}

/** Centre of a node's leading (out) / trailing (in) edge for the left-right flow. */
function port(n: LaidNode, side: 'out' | 'in') {
  return { x: side === 'out' ? n.x + n.w : n.x, y: n.y + n.h / 2 };
}

/** A bezier from source to target, bending along the horizontal flow axis. */
function edgePath(a: LaidNode, b: LaidNode): string {
  const p = port(a, 'out');
  const q = port(b, 'in');
  const mx = (p.x + q.x) / 2;
  return `M${p.x},${p.y} C${mx},${p.y} ${mx},${q.y} ${q.x},${q.y}`;
}

export function GraphView({
  tasks,
  loading,
  onOpen,
}: {
  tasks: Task[];
  /** First board load still in flight — distinguishes "loading" from "no tasks". */
  loading: boolean;
  onOpen: (task: Task) => void;
}) {
  const [showTerminal, setShowTerminal] = useState(false);

  // Which Tasks and edges the graph draws. `visible` recomputes on any board
  // change (the firehose replaces Task objects); `edges` follows it.
  const visible = useMemo(() => visibleTasks(tasks, showTerminal), [tasks, showTerminal]);
  const edges = useMemo(() => graphEdges(visible), [visible]);
  const badges = useMemo(() => mapBadges(visible), [visible]);
  // Live Task lookup for the render: positions come from the (structural)
  // layout, but colours / titles / glyphs read the current Task, so a firehose
  // update repaints a node without waiting on a relayout.
  const byId = useMemo(() => new Map(visible.map((t) => [t.id, t])), [visible]);

  // Relayout only when the graph's *structure* changes — the set of nodes,
  // their Map, or the edges — not on every unrelated field tick (cost, etc.).
  const structureKey = useMemo(
    () =>
      JSON.stringify({
        n: visible.map((t) => [t.id, t.mapRef]),
        e: edges.map((e) => [e.from, e.to]),
      }),
    [visible, edges],
  );

  const [layout, setLayout] = useState<Layout | null>(null);
  const [layoutError, setLayoutError] = useState(false);
  useEffect(() => {
    let live = true;
    setLayoutError(false);
    if (visible.length === 0) {
      setLayout({ nodes: [], groups: [], edges: [], width: 0, height: 0 });
      return;
    }
    layoutGraph(visible, edges, { direction: 'RIGHT', nodeW: NODE_W, nodeH: NODE_H, groupLabelPad: 34 }).then(
      (l) => live && setLayout(l),
      () => live && setLayoutError(true),
    );
    return () => {
      live = false;
    };
    // Structure key stands in for (visible, edges): same nodes+edges ⇒ same layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  // ── Pan + zoom viewport ────────────────────────────────────────────────────
  const hostRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [t, setT] = useState<Transform>({ k: 1, tx: 0, ty: 0 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  // A render-visible mirror of `drag`: the cursor must flip to "grabbing" the
  // instant a pan starts, but `drag` is a ref (no re-render), so the style would
  // otherwise only catch up on the first pointer-move. Kept in state for that.
  const [dragging, setDragging] = useState(false);
  // Distinguishes a pan-drag from a click-to-open: a gesture that moved past a
  // few px opens nothing.
  const moved = useRef(false);
  const pressed = useRef<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setVp({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = () => setT(fitTransform(layout?.width ?? 0, layout?.height ?? 0, vp.w, vp.h));
  // Fit whenever a fresh layout lands or the viewport first sizes.
  useEffect(() => {
    if (layout && layout.width > 0 && vp.w > 0) setT(fitTransform(layout.width, layout.height, vp.w, vp.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, vp.w, vp.h]);

  const zoomAt = (cx: number, cy: number, factor: number) =>
    setT((p) => {
      const k = Math.max(0.15, Math.min(3, p.k * factor));
      return { k, tx: cx - ((cx - p.tx) / p.k) * k, ty: cy - ((cy - p.ty) / p.k) * k };
    });

  // Trackpad / scrollwheel zoom. Attached natively with { passive: false } so
  // preventDefault() actually stops the page from scrolling under the gesture —
  // React's synthetic onWheel is passive and can't. zoomAt only closes over the
  // stable setT, so binding once is safe.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nodeIdAt = (target: EventTarget): number | null => {
    const el = (target as Element).closest?.('[data-task-id]');
    const raw = el?.getAttribute('data-task-id');
    return raw ? Number(raw) : null;
  };

  const openNode = (id: number | null) => {
    if (id == null) return;
    const task = byId.get(id);
    if (task) onOpen(task);
  };

  const emptyMessage =
    tasks.length === 0
      ? { title: 'No tasks yet', body: 'Create a task on the Board — it shows up here once it has dependencies to graph.' }
      : { title: 'Nothing active', body: 'Every task on this workspace is completed, failed, or cancelled. Turn on “Show terminal” to reveal them.' };

  const showEmpty = !loading && !layoutError && visible.length === 0;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar: the anchor count, and the terminal-reveal toggle. */}
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <span className="flex items-baseline gap-1.5">
          <span className={`${displayTitle} tabular-nums ${visible.length > 0 || loading ? '' : 'text-faint'}`}>
            {loading ? '…' : visible.length}
          </span>
          <span className={`${labelType} text-muted`}>tasks</span>
        </span>
        <div className="flex-1" />
        <Switch checked={showTerminal} onChange={setShowTerminal} label="Show terminal tasks">
          <span className="font-medium text-muted">Show terminal</span>
        </Switch>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-canvas ring-1 ring-hairline">
        <div
          ref={hostRef}
          className="absolute inset-0 select-none"
          style={{ touchAction: 'none', cursor: dragging ? 'grabbing' : 'grab' }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, tx: t.tx, ty: t.ty };
            setDragging(true);
            moved.current = false;
            pressed.current = nodeIdAt(e.target);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4) moved.current = true;
            setT((p) => ({ ...p, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }));
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            drag.current = null;
            setDragging(false);
            // A tap that didn't pan on a node deep-links to its Task detail.
            if (!moved.current) openNode(pressed.current);
            pressed.current = null;
          }}
          onPointerCancel={() => {
            // A cancelled gesture (e.g. the OS steals the pointer) never fires
            // pointerup — reset here so the grabbing cursor can't stick.
            drag.current = null;
            setDragging(false);
            pressed.current = null;
          }}
          onDoubleClick={fit}
        >
          {!layout && !layoutError && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-muted">Laying out…</div>
          )}
          {layoutError && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-muted">
              Couldn’t lay out the graph.
            </div>
          )}
          {showEmpty && (
            <div className="absolute inset-0 flex items-center justify-center">
              <EmptyState title={emptyMessage.title}>{emptyMessage.body}</EmptyState>
            </div>
          )}

          <svg width={vp.w} height={vp.h} style={{ display: 'block' }}>
            <defs>
              {Object.entries(SIGNAL).map(([s, sig]) => (
                <marker
                  key={s}
                  id={`hm-graph-arrow-${s}`}
                  markerWidth="7"
                  markerHeight="7"
                  refX="5.5"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L6,3 L0,6 Z" fill={sig.color} />
                </marker>
              ))}
            </defs>
            <g transform={`translate(${t.tx},${t.ty}) scale(${t.k})`}>
              {/* Map membership: a quiet floating label only — never a box
                  (ADR 0015). The per-node badge carries membership when elk's
                  layering scatters a Map's members. */}
              {layout?.groups.map((g) => (
                <text
                  key={g.ref}
                  x={g.x + 14}
                  y={g.y + 21}
                  className="fill-faint"
                  fontSize={12}
                  fontWeight={700}
                  letterSpacing="0.05em"
                >
                  {badges.get(g.ref)}· {truncate(g.title.toUpperCase(), 24)}
                </text>
              ))}

              {/* Edges: tinted by source state, gently curved, arrowed. */}
              {layout?.edges.map((e) => {
                const a = layout.nodes.find((n) => n.id === e.from);
                const b = layout.nodes.find((n) => n.id === e.to);
                if (!a || !b) return null;
                const src = byId.get(a.id) ?? a.task;
                const sig = SIGNAL[src.state];
                return (
                  <path
                    key={`${e.from}-${e.to}`}
                    d={edgePath(a, b)}
                    fill="none"
                    stroke={sig.color}
                    strokeWidth={1.5}
                    opacity={0.55}
                    markerEnd={`url(#hm-graph-arrow-${src.state})`}
                  />
                );
              })}

              {/* Nodes: Variant A card + the Map badge (prototype winner). */}
              {layout?.nodes.map((n) => {
                const task = byId.get(n.id) ?? n.task;
                return (
                  <CardNode
                    key={n.id}
                    n={n}
                    task={task}
                    badge={task.mapRef != null ? badges.get(task.mapRef) : undefined}
                    hovered={hovered === n.id}
                    onHover={setHovered}
                    onActivate={() => onOpen(task)}
                  />
                );
              })}
            </g>
          </svg>
        </div>

        {/* Zoom controls (top-right). Rendered as a sibling of the pan/zoom
            host — not a child — so a button press never triggers the host's
            pointer capture, which would otherwise swallow the click. Each
            control carries a ≥44px touch target (issue #56) via the shared
            helper, even though the glyphs read compact. */}
        <div className="absolute right-4 top-4 flex items-center gap-1 rounded-full bg-surface px-1 shadow-card ring-1 ring-edge">
          <button
            className={`${touchTarget} rounded-full text-muted hover:bg-raised hover:text-ink`}
            onClick={() => zoomAt(vp.w / 2, vp.h / 2, 1 / 1.2)}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="w-12 text-center text-xs tabular-nums text-muted">{Math.round(t.k * 100)}%</span>
          <button
            className={`${touchTarget} rounded-full text-muted hover:bg-raised hover:text-ink`}
            onClick={() => zoomAt(vp.w / 2, vp.h / 2, 1.2)}
            aria-label="Zoom in"
          >
            +
          </button>
          <div className="mx-0.5 h-4 w-px bg-edge" />
          <button
            className="inline-flex min-h-11 items-center rounded-full px-3 text-xs font-semibold text-muted hover:bg-raised hover:text-ink"
            onClick={fit}
          >
            Fit
          </button>
        </div>
      </div>
    </div>
  );
}

function CardNode({
  n,
  task,
  badge,
  hovered,
  onHover,
  onActivate,
}: {
  n: LaidNode;
  task: Task;
  badge?: number;
  hovered: boolean;
  onHover: (id: number | null) => void;
  onActivate: () => void;
}) {
  const sig = SIGNAL[task.state];
  const mirrored = task.origin === 'mirrored';
  return (
    <g
      data-task-id={task.id}
      role="button"
      tabIndex={0}
      aria-label={`${nodeTitle(task.prompt)} — ${STATE_LABEL[task.state]}, task ${task.id}. Open detail.`}
      className="cursor-pointer focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
      onMouseEnter={() => onHover(n.id)}
      onMouseLeave={() => onHover(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      <rect
        x={n.x}
        y={n.y}
        width={n.w}
        height={n.h}
        rx={10}
        fill="var(--hm-surface)"
        stroke={hovered ? 'var(--hm-accent)' : 'var(--hm-hairline)'}
        strokeWidth={hovered ? 1.5 : 1}
        filter="drop-shadow(0 1px 2px rgb(20 22 45 / 0.06))"
      />
      <rect x={n.x} y={n.y} width={4} height={n.h} rx={2} fill={sig.color} />
      <text x={n.x + 14} y={n.y + 22} className="fill-ink" fontSize={12.5} fontWeight={600}>
        {truncate(nodeTitle(task.prompt), 26)}
      </text>
      <text x={n.x + 14} y={n.y + 44} fontSize={10.5} fontWeight={600} fill={sig.text} letterSpacing="0.03em">
        {STATE_LABEL[task.state].toUpperCase()}
      </text>
      {/* native = filled dot, mirrored = ring (tracker-owned). */}
      <circle
        cx={n.x + n.w - 24}
        cy={n.y + 40}
        r={4}
        fill={mirrored ? 'none' : 'var(--hm-muted)'}
        stroke="var(--hm-muted)"
        strokeWidth={1.5}
      />
      <text x={n.x + n.w - 14} y={n.y + 44} className="fill-faint" fontSize={10} textAnchor="end">
        #{task.id}
      </text>
      {/* Map badge: the membership signal that survives elk's dependency layering. */}
      {badge != null && (
        <text x={n.x + n.w - 10} y={n.y + 16} textAnchor="end" className="fill-faint" fontSize={9.5} fontWeight={700}>
          {badge}
        </text>
      )}
    </g>
  );
}
