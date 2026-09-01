// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { Task, TaskState } from './types.js';
import { TERMINAL_STATES } from './task-state-model.js';

/** A directed Dependency edge: `from` is a prerequisite of `to`. */
export interface GraphEdge {
  from: number;
  to: number;
}

/** Terminal = the board's terminal states (completed / failed / cancelled):
 * one definition of "done" across the app (board-model.ts). The Graph hides
 * these by default and reveals them on a toggle. */
export function isTerminalState(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly TaskState[]).includes(state);
}

/**
 * The Tasks the graph draws: active-state Tasks always, terminal
 * (completed / failed / cancelled) Tasks only once the operator reveals them.
 * Order is preserved so the caller's sort (and elk's model-order tiebreak)
 * stays stable.
 *
 * Exception — a terminal Task that *still blocks* an active Task is kept even
 * when terminal Tasks are hidden. The domain unblocks a Task only when every
 * dependency is `completed` (tasks.ts `hasUnmet`), so a `failed` / `cancelled`
 * blocker keeps its dependent `blocked`. Hiding it would drop the blocking edge
 * (graphEdges needs both endpoints present) and make a genuinely-blocked Task
 * read as unblocked — the board and graph would disagree. A `completed` blocker
 * is satisfied, so it stays hidden.
 */
export function visibleTasks(tasks: Task[], showTerminal: boolean): Task[] {
  if (showTerminal) return tasks;
  const stillBlocking = new Set<number>();
  for (const t of tasks) {
    if (isTerminalState(t.state)) continue;
    for (const dep of t.dependsOn) stillBlocking.add(dep);
  }
  return tasks.filter(
    (t) => !isTerminalState(t.state) || (t.state !== 'done' && stillBlocking.has(t.id)),
  );
}

/**
 * The DAG's directed edges over the Dependency relation, restricted to the
 * given (visible) Task set. `dependsOn` is already unified across native and
 * mirrored origins, so both kinds flow through the same derivation.
 *
 * - An edge is kept only when *both* endpoints are visible, so an edge never
 *   dangles into a hidden terminal Task.
 * - Self-references and duplicates are dropped — the render draws each edge once.
 */
export function graphEdges(tasks: Task[]): GraphEdge[] {
  const present = new Set(tasks.map((t) => t.id));
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id || !present.has(dep)) continue;
      const key = `${dep}->${t.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: dep, to: t.id });
    }
  }
  return edges;
}

/** A node's label: the first non-empty line of the prompt — a card is too small
 * for the full prompt the board and table clamp, so the graph takes the lead
 * line. Empty prompts fall back to a stable placeholder. */
export function nodeTitle(prompt: string): string {
  for (const line of prompt.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return 'Untitled task';
}

/**
 * Stable 1-based badge numbers for the Maps present in the set, keyed by
 * `mapRef` in ascending order. Map membership reads as a per-node badge plus a
 * quiet label rather than a drawn container: elk
 * layers by dependency first, scattering a Map's members, so a box would tear —
 * the shared badge number is what actually carries membership.
 */
export function mapBadges(tasks: Task[]): Map<number, number> {
  const refs = [...new Set(tasks.map((t) => t.mapRef).filter((r): r is number => r != null))].sort(
    (a, b) => a - b,
  );
  return new Map(refs.map((ref, i) => [ref, i + 1]));
}

/** A node's display state on the graph: its stored {@link TaskState}, plus the
 * derived `blocked` — a `ready` Task with open blockers reads as blocked, not
 * ready, so the graph and the Board agree on what can actually run next. */
export type GraphNodeState = TaskState | 'blocked';

/** The graph's display state for a Task: `blocked` when a `ready` Task still has
 * open blockers (it cannot run yet), otherwise its stored state. */
export function graphNodeState(task: Task): GraphNodeState {
  return task.state === 'ready' && task.openBlockerCount > 0 ? 'blocked' : task.state;
}

/** The state signal for a node, on the Deck state/signal layer. */
export interface Signal {
  /** State-dot / edge-stroke / arrowhead colour (a state hue, or neutral). */
  color: string;
  /** Readable state-label colour on the card surface. */
  text: string;
}

/**
 * State → signal colour, straight from the Deck state-signal family
 * (`web/src/index.css`, DESIGN.md § 2). The Signal Rule: only true states carry
 * a hue — `draft` and `cancelled` stay neutral (Faint dot / Muted text), nothing
 * is happening or it's over. Tokens re-theme for free, so this reads in both
 * themes. `escalated` is the one state that speaks in Paper's indigo
 * needs-you voice.
 */
export const SIGNAL: Record<GraphNodeState, Signal> = {
  draft: { color: 'var(--hm-faint)', text: 'var(--hm-muted)' },
  ready: { color: 'var(--hm-ready-dot)', text: 'var(--hm-ready)' },
  working: { color: 'var(--hm-running-dot)', text: 'var(--hm-running)' },
  escalated: { color: 'var(--hm-await-dot)', text: 'var(--hm-await)' },
  done: { color: 'var(--hm-merged-dot)', text: 'var(--hm-merged)' },
  cancelled: { color: 'var(--hm-faint)', text: 'var(--hm-muted)' },
  blocked: { color: 'var(--hm-muted)', text: 'var(--hm-muted)' },
};

/** Short, human state word for the node's state label (uppercased at render). */
export const STATE_LABEL: Record<GraphNodeState, string> = {
  draft: 'Draft',
  ready: 'Ready',
  working: 'Working',
  escalated: 'Escalated',
  done: 'Merged',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
};

/** Ellipsis-truncate to `n` chars (the card is too small for a full title). */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** A laid-out box; the geometry helpers only need its position and size. */
export interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The pan/zoom transform of the SVG viewport: scale `k`, translate `tx`/`ty`. */
export interface Transform {
  k: number;
  tx: number;
  ty: number;
}

/**
 * Fit the content box into the viewport with padding, centred, capped at 1.5×
 * so a tiny graph doesn't balloon. Degenerate inputs (a zero dimension, before
 * layout or sizing) fall back to the identity transform.
 */
export function fitTransform(w: number, h: number, vw: number, vh: number): Transform {
  if (w <= 0 || h <= 0 || vw <= 0 || vh <= 0) return { k: 1, tx: 0, ty: 0 };
  const pad = 48;
  const k = Math.min((vw - pad * 2) / w, (vh - pad * 2) / h, 1.5);
  return { k, tx: (vw - w * k) / 2, ty: (vh - h * k) / 2 };
}

/** Centre of a node's leading (out) / trailing (in) edge for the L→R flow. */
export function port(n: NodeBox, side: 'out' | 'in'): { x: number; y: number } {
  return { x: side === 'out' ? n.x + n.w : n.x, y: n.y + n.h / 2 };
}

/** A bezier from source to target, bending along the horizontal flow axis. */
export function edgePath(a: NodeBox, b: NodeBox): string {
  const p = port(a, 'out');
  const q = port(b, 'in');
  const mx = (p.x + q.x) / 2;
  return `M${p.x},${p.y} C${mx},${p.y} ${mx},${q.y} ${q.x},${q.y}`;
}

export type Direction = 'DOWN' | 'RIGHT';

/** A laid-out Task node in absolute canvas coordinates. */
export interface LaidNode extends NodeBox {
  id: number;
  task: Task;
}
/** A laid-out Map group box (never drawn as a container — only its
 * origin/size inform the floating label). */
export interface LaidGroup extends NodeBox {
  ref: number;
  title: string;
}
export interface Layout {
  nodes: LaidNode[];
  groups: LaidGroup[];
  edges: GraphEdge[];
  width: number;
  height: number;
}
export interface LayoutOpts {
  direction: Direction;
  nodeW: number;
  nodeH: number;
  /** Extra top padding inside a group, so the floating map label has room. */
  groupLabelPad?: number;
}

/** The subset of an elk-laid node the flatten reads — kept structural so this
 * module needn't depend on elkjs. A group node's id is `m<ref>`, a task's `t<id>`. */
export interface ElkLaidNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkLaidNode[];
}
export interface ElkLaidGraph {
  children?: ElkLaidNode[];
  width?: number;
  height?: number;
}

function laidNode(elkNode: ElkLaidNode, byId: Map<number, Task>, ox: number, oy: number): LaidNode {
  const id = Number(elkNode.id.slice(1));
  return {
    id,
    task: byId.get(id)!,
    x: (elkNode.x ?? 0) + ox,
    y: (elkNode.y ?? 0) + oy,
    w: elkNode.width ?? 0,
    h: elkNode.height ?? 0,
  };
}

/**
 * Flatten elk's hierarchical result to absolute coordinates. A Map's members
 * come back parent-relative, so each gets its group's origin added and the group
 * becomes a `LaidGroup`; loose nodes pass through at root level. `groupTitles`
 * carries the resolved Map title (falling back to `Map <ref>`). Pure — this is
 * just the coordinate maths, exercised without elk.
 */
export function flattenElkLayout(
  res: ElkLaidGraph,
  groupTitles: Map<number, string>,
  byId: Map<number, Task>,
  edges: GraphEdge[],
): Layout {
  const nodes: LaidNode[] = [];
  const groups: LaidGroup[] = [];
  for (const child of res.children ?? []) {
    if (child.id.startsWith('m')) {
      const ref = Number(child.id.slice(1));
      const ox = child.x ?? 0;
      const oy = child.y ?? 0;
      groups.push({ ref, title: groupTitles.get(ref) ?? `Map ${ref}`, x: ox, y: oy, w: child.width ?? 0, h: child.height ?? 0 });
      for (const gc of child.children ?? []) nodes.push(laidNode(gc, byId, ox, oy));
    } else {
      nodes.push(laidNode(child, byId, 0, 0));
    }
  }
  return { nodes, groups, edges, width: res.width ?? 0, height: res.height ?? 0 };
}
