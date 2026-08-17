// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { Task, TaskState } from './types.js';
import { TERMINAL_STATES } from './board-model.js';

/**
 * The read-only Dependency Graph view (issue #85, ADR 0015). The layout
 * (elkjs) and rendering (hand-rolled SVG) live in graph-layout.ts /
 * GraphView.tsx; the pure derivations the view needs — which Tasks show, which
 * edges connect them, how a node reads — live here so they're unit-testable
 * without a browser or elk.
 */

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
    if (isTerminalState(t.state)) continue; // only an active dependent can be waiting on a blocker
    for (const dep of t.dependsOn) stillBlocking.add(dep);
  }
  return tasks.filter(
    (t) => !isTerminalState(t.state) || (t.state !== 'completed' && stillBlocking.has(t.id)),
  );
}

/**
 * The DAG's directed edges over the Dependency relation, restricted to the
 * given (visible) Task set. `dependsOn` is already unified across native and
 * mirrored origins (ADR 0015), so both kinds flow through the same derivation.
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
 * quiet label rather than a drawn container (ADR 0015 / prototype #84): elk
 * layers by dependency first, scattering a Map's members, so a box would tear —
 * the shared badge number is what actually carries membership.
 */
export function mapBadges(tasks: Task[]): Map<number, number> {
  const refs = [...new Set(tasks.map((t) => t.mapRef).filter((r): r is number => r != null))].sort(
    (a, b) => a - b,
  );
  return new Map(refs.map((ref, i) => [ref, i + 1]));
}
