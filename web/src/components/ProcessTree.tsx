import type { ProcessNode, ProcessStatus } from '../types';
import { chip } from '../ui';
import { flattenTree, nodeTokens, type FlatNode, type NodeActivityMap } from '../process-tree-model';

/** Compact figures ("18.2k") — the same treatment the rest of Activity uses. */
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** One indent step. The connectors are drawn with hairline borders, never mono
 * box-drawing glyphs — structure is a divider, not code (DESIGN: Mono Is Code). */
const COL = 'w-4 shrink-0';

/** The connector cell for the node's own branch (its last indent column): a
 * half-height stem down from above, a horizontal stub to the content, and — when
 * the node has a later sibling — the stem continuing below (├ vs └). */
function Elbow({ isLast }: { isLast: boolean }) {
  return (
    <span className={`relative ${COL} self-stretch`} aria-hidden="true">
      <span className="absolute left-2 top-0 h-1/2 border-l border-hairline" />
      {!isLast && <span className="absolute left-2 top-1/2 h-1/2 border-l border-hairline" />}
      <span className="absolute left-2 top-1/2 w-2 border-t border-hairline" />
    </span>
  );
}

/** The indent gutter: an ancestor-spine column draws a full-height line while
 * that branch continues below; the final column is the node's own elbow. */
function Connectors({ guides, isLast, depth }: { guides: boolean[]; isLast: boolean; depth: number }) {
  if (depth === 0) return null;
  return (
    <span className="flex self-stretch" aria-hidden="true">
      {guides.slice(0, depth - 1).map((continues, i) => (
        <span key={i} className={`relative ${COL} self-stretch`}>
          {continues && <span className="absolute left-2 inset-y-0 border-l border-hairline" />}
        </span>
      ))}
      <Elbow isLast={isLast} />
    </span>
  );
}

/** The node's live status: an amber pulse while active, a still faint dot once
 * idle. (Hidden nodes are pruned upstream and never reach a row.) */
function StatusDot({ status }: { status: ProcessStatus }) {
  const active = status === 'active';
  return (
    <span
      aria-label={status}
      className={`size-[6px] shrink-0 rounded-full ${active ? 'bg-running-dot motion-safe:animate-pulse' : 'bg-faint'}`}
    />
  );
}

/** Per-node context fill as a plain token figure — the tree is a compact
 * readout, so no gauge here; the row's own gauge carries the whole-process fill. */
function nodeContext(node: ProcessNode): string {
  return node.contextTokens === null ? '—' : `${compact.format(node.contextTokens)} ctx`;
}

function TreeRow({
  flat,
  selected,
  onSelect,
}: {
  flat: FlatNode;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { node, status, guides, isLast, depth } = flat;
  const idle = status !== 'active';
  return (
    <button
      onClick={() => onSelect(node.id)}
      aria-pressed={selected}
      className={`flex min-h-11 w-full items-stretch gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 ${
        selected ? 'bg-accent-tint' : 'hover:bg-raised'
      }`}
    >
      <Connectors guides={guides} isLast={isLast} depth={depth} />
      <span className="flex min-w-0 flex-1 items-center gap-2 self-center">
        <StatusDot status={status} />
        <span className={`truncate font-medium ${idle ? 'text-muted' : 'text-ink'}`} title={node.name}>
          {depth === 0 ? 'root' : node.name}
        </span>
        <span className={`${chip} shrink-0 bg-raised text-muted`} title={node.model}>
          {node.model}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3 self-center text-small tabular-nums text-muted">
        <span title="This node's own tokens">{compact.format(nodeTokens(node))}</span>
        <span className="text-muted">{nodeContext(node)}</span>
      </span>
    </button>
  );
}

/**
 * A Run's Process Tree (issue #53): the root session and its recursive
 * Subagents, one selectable row each, with hairline depth connectors and a live
 * per-node status that fades as the node goes idle. Selecting a node frames the
 * output pane on it (see `frameEvents`). The idle lifecycle lives in the pure
 * model (`flattenTree` over a `NodeActivityMap`) — this component only paints
 * the rows the model keeps, so a node that ages to `hidden` simply drops out.
 */
export function ProcessTree({
  tree,
  activity,
  now,
  selectedId,
  onSelect,
}: {
  tree: ProcessNode;
  activity: NodeActivityMap;
  now: number;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const rows = flattenTree(tree, activity, now);
  return (
    <div className="space-y-0.5">
      {rows.map((flat) => (
        <TreeRow key={flat.node.id} flat={flat} selected={flat.node.id === selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}
