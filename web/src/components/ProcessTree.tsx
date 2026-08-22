import { useRef, type KeyboardEvent } from 'react';
import type { ProcessNode, ProcessStatus } from '../types';
import { chip } from '../ui';
import { flattenTree, nodeTokens, statusLabel, type FlatNode, type NodeActivityMap } from '../process-tree-model';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

const COL = 'w-4 shrink-0';

function Elbow({ isLast }: { isLast: boolean }) {
  return (
    <span className={`relative ${COL} self-stretch`} aria-hidden="true">
      <span className="absolute left-2 top-0 h-1/2 border-l border-hairline" />
      {!isLast && <span className="absolute left-2 top-1/2 h-1/2 border-l border-hairline" />}
      <span className="absolute left-2 top-1/2 w-2 border-t border-hairline" />
    </span>
  );
}

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

function StatusDot({ status }: { status: ProcessStatus }) {
  const active = status === 'active';
  return (
    <span
      aria-hidden="true"
      className={`size-[7px] shrink-0 rounded-full ${active ? 'bg-running-dot motion-safe:animate-pulse' : 'bg-faint'}`}
    />
  );
}

function nodeContext(node: ProcessNode): string {
  return node.contextTokens === null ? '—' : `${compact.format(node.contextTokens)} ctx`;
}

function TreeRow({
  flat,
  selected,
  tabbable,
  onSelect,
}: {
  flat: FlatNode;
  selected: boolean;
  tabbable: boolean;
  onSelect: (id: string) => void;
}) {
  const { node, status, guides, isLast, depth, posInSet, setSize } = flat;
  const idle = status !== 'active';
  return (
    <button
      onClick={() => onSelect(node.id)}
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      className={`flex min-h-11 w-full items-stretch gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 ${
        selected ? 'bg-accent-tint' : 'hover:bg-raised'
      }`}
    >
      <Connectors guides={guides} isLast={isLast} depth={depth} />
      <span className="flex min-w-0 flex-1 items-center gap-2 self-center">
        <StatusDot status={status} />
        <span className="sr-only">{statusLabel(status)}</span>
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
  const treeRef = useRef<HTMLDivElement>(null);
  // Roving tabindex: exactly one row sits in the Tab order (the selected one,
  // or the first), so Tab moves into and out of the whole tree as a single
  // stop; Up/Down/Home/End move focus between rows — the WAI-ARIA tree
  // keyboard model, without which role="tree" would mislead assistive tech.
  const activeIndex = Math.max(0, rows.findIndex((r) => r.node.id === selectedId));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = treeRef.current
      ? Array.from(treeRef.current.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'))
      : [];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = current < 0 ? 0 : Math.min(current + 1, items.length - 1);
        break;
      case 'ArrowUp':
        next = current < 0 ? 0 : Math.max(current - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    items[next]?.focus();
  };
  return (
    <div ref={treeRef} role="tree" aria-label="Process tree" className="space-y-0.5" onKeyDown={onKeyDown}>
      {rows.map((flat, i) => (
        <TreeRow
          key={flat.node.id}
          flat={flat}
          selected={flat.node.id === selectedId}
          tabbable={i === activeIndex}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
