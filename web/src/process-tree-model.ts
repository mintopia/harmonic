import type { ModelUsage, ProcessNode, ProcessStatus, ProcessTree } from './types.js';
import type { StreamEvent } from './event-stream-model.js';

/**
 * The pure model behind the Activity Process Tree drill-in (issue #53). It owns
 * two jobs the `ProcessTree` component only paints:
 *
 *  1. The **idle lifecycle** — a node is `active` while it writes, fades to
 *     `inactive` after `INACTIVE_AFTER_MS` of quiet, then `hidden` after
 *     `HIDDEN_AFTER_MS`, reactivating the instant a new write lands. The client
 *     ages nodes between the snapshot poll / `run_usage` deltas off a
 *     `NodeActivityMap` it keeps across ticks; the server's own status is a
 *     floor, so the client can only make a node *more* idle, never less (a
 *     completed Subagent the server calls `inactive` never flashes back to
 *     `active` just because we saw it for the first time).
 *  2. **Flattening** the recursive tree into rows with depth connectors, so the
 *     component stays a dumb renderer.
 *
 * Plus `frameEvents`, which frames the shared `EventStream` on one node's
 * transcript rather than the whole Task.
 */

/** Quiet for this long → the node fades to `inactive`. */
export const INACTIVE_AFTER_MS = 12_000;
/** Quiet for this long → the node ages out to `hidden` (pruned unless it's a
 * spine to a still-visible descendant). */
export const HIDDEN_AFTER_MS = 90_000;

/** active < inactive < hidden — a node only ever moves *down* this ladder. */
const RANK: Record<ProcessStatus, number> = { active: 0, inactive: 1, hidden: 2 };

/** The idler of two statuses — the client never revives what the server retired. */
function moreIdle(a: ProcessStatus, b: ProcessStatus): ProcessStatus {
  return RANK[a]! >= RANK[b]! ? a : b;
}

/** Human text equivalent of a node's live status — the sr-only readout the
 * Process Tree row announces so status isn't carried by colour alone. */
export function statusLabel(status: ProcessStatus): string {
  switch (status) {
    case 'active':
      return 'active';
    case 'inactive':
      return 'idle';
    case 'hidden':
      return 'hidden';
  }
}

/** A node's own total token footprint (input + output + both cache sides) — the
 * same sum `usageTotalTokens` falls back to, but for a single node's `usage`. */
export function nodeTokens(node: ProcessNode): number {
  const u = node.usage;
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

/** What we watch to decide a node "wrote": its token footprint and context fill.
 * Any change stamps a fresh `lastWrite`; an unchanged signature keeps the old
 * timestamp so the node keeps aging. */
function writeSignature(node: ProcessNode): string {
  const u: ModelUsage = node.usage;
  return `${u.inputTokens}·${u.outputTokens}·${u.cacheReadTokens}·${u.cacheWriteTokens}·${node.contextTokens ?? ''}`;
}

/** One node's last-write bookkeeping — the timestamp we age from, plus the
 * signature we compare the next snapshot against. */
interface NodeActivity {
  lastWrite: number;
  sig: string;
}

/** Per-node (`node.id`) last-write state, threaded across snapshots by the view. */
export type NodeActivityMap = Record<string, NodeActivity>;

/** The empty map — the seed before the first snapshot lands. */
export const NO_NODE_ACTIVITY: NodeActivityMap = {};

/**
 * Fold a fresh tree snapshot into the activity map: a node whose write
 * signature changed (or one seen for the first time) stamps `now`; an unchanged
 * node keeps its prior `lastWrite` and keeps aging. Nodes absent from the new
 * tree drop out. Pure — returns a new map, so it slots straight into React
 * state without a mutation escaping.
 */
export function trackNodeActivity(prev: NodeActivityMap, tree: ProcessTree, now: number): NodeActivityMap {
  const next: NodeActivityMap = {};
  const visit = (node: ProcessNode) => {
    const sig = writeSignature(node);
    const before = prev[node.id];
    next[node.id] = before && before.sig === sig ? before : { lastWrite: now, sig };
    node.children.forEach(visit);
  };
  visit(tree);
  return next;
}

/** The node's effective live status: the idler of the server's status and what
 * its idle age implies. Untracked (no map entry yet) leaves the server's word
 * standing. */
export function nodeStatus(node: ProcessNode, activity: NodeActivityMap, now: number): ProcessStatus {
  const tracked = activity[node.id];
  if (!tracked) return node.status;
  const idle = now - tracked.lastWrite;
  const byAge: ProcessStatus = idle >= HIDDEN_AFTER_MS ? 'hidden' : idle >= INACTIVE_AFTER_MS ? 'inactive' : 'active';
  return moreIdle(node.status, byAge);
}

/** One flattened row: the node, its live status, and the connector geometry the
 * component draws (ancestor spines in `guides`, the node's own elbow via
 * `isLast`). */
export interface FlatNode {
  node: ProcessNode;
  status: ProcessStatus;
  depth: number;
  /** Per-ancestor "continues below" flags; `guides[i]` is whether the ancestor
   * at depth `i + 1` has a later visible sibling (draws a vertical spine). */
  guides: boolean[];
  /** Is this node the last visible child of its parent? (elbow └ vs ├). */
  isLast: boolean;
  /** 1-based position among the node's *visible* siblings (aria-posinset). */
  posInSet: number;
  /** Count of the node's *visible* siblings (aria-setsize). */
  setSize: number;
}

/**
 * Flatten the tree to the rows the component renders, in depth-first order.
 * A `hidden` node drops out — unless it still sits above a visible descendant,
 * in which case it stays as a faded spine so the tree never shows a gap. The
 * root is always kept (it's the session itself). Sibling order follows the
 * server's; `isLast`/`guides` are computed over *visible* siblings only, so a
 * hidden leaf between two live ones never leaves a dangling connector.
 */
export function flattenTree(tree: ProcessTree, activity: NodeActivityMap, now: number): FlatNode[] {
  const rows: FlatNode[] = [];
  const statusOf = (n: ProcessNode) => nodeStatus(n, activity, now);
  const visible = (n: ProcessNode): boolean => n.depth === 0 || statusOf(n) !== 'hidden' || n.children.some(visible);

  const walk = (node: ProcessNode, guides: boolean[], isLast: boolean, posInSet: number, setSize: number) => {
    rows.push({ node, status: statusOf(node), depth: node.depth, guides, isLast, posInSet, setSize });
    const kids = node.children.filter(visible);
    // The root draws no connector column of its own, so it contributes no guide;
    // every deeper node hands its children an extra "do I continue?" spine flag.
    const childGuides = node.depth === 0 ? guides : [...guides, !isLast];
    kids.forEach((child, i) => walk(child, childGuides, i === kids.length - 1, i + 1, kids.length));
  };
  walk(tree, [], true, 1, 1);
  return rows;
}

/** Depth-first search for a node by id — the drill-in resolves the selected row
 * back to its node (and falls back to the root when a selection ages out). */
export function findNode(tree: ProcessTree, id: string): ProcessNode | undefined {
  if (tree.id === id) return tree;
  for (const child of tree.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return undefined;
}

/** A stream event's Subagent attribution: the harness tags a Subagent's tool
 * calls with the spawning `Agent`/`Task` tool-use id (Claude Code's
 * `_meta.claudeCode.parentToolUseId`); a root-session event carries none. */
function parentToolUseId(event: StreamEvent): string | undefined {
  const id = event.payload?._meta?.claudeCode?.parentToolUseId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Frame a run's event stream on a single Process Tree node — the drill-in shows
 * the selected agent/session's transcript, not the whole Task. The **root**
 * session owns every top-level event (those with no Subagent tag). A
 * **Subagent** owns the events whose `parentToolUseId` matches its `toolUseId`
 * (the spawning tool call). A node with no `toolUseId`, or one nested deeper
 * than the streamed session (a Subagent-of-a-Subagent, whose transcript lives
 * in its own log, not this stream), frames empty — the pane then says so rather
 * than misattributing the parent's output.
 */
export function frameEvents<E extends StreamEvent>(events: E[], node: ProcessNode): E[] {
  if (node.depth === 0) return events.filter((e) => parentToolUseId(e) === undefined);
  const key = node.toolUseId;
  if (!key) return [];
  return events.filter((e) => parentToolUseId(e) === key);
}
