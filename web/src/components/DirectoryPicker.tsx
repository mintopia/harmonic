import { useEffect, useReducer } from 'react';
import { api } from '../api';
import {
  emptyPicker,
  reducePicker,
  visibleRows,
  type DirNode,
} from '../directory-picker-model';
import { Icon } from './Icon';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Operator-only: `/api/fs` needs a full-scope session, so a scoped/read key
 * gets a load error surfaced inline rather than a picker.
 */
export function DirectoryPicker({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (path: string) => void;
}) {
  const [state, dispatch] = useReducer(reducePicker, undefined, emptyPicker);

  useEffect(() => {
    let live = true;
    api
      .browseFs()
      .then((listing) => live && dispatch({ type: 'loaded', listing }))
      .catch((e) => live && dispatch({ type: 'root-error', message: errText(e) }));
    return () => {
      live = false;
    };
  }, []);

  const toggle = (node: DirNode): void => {
    if (node.expanded) {
      dispatch({ type: 'collapse', path: node.path });
      return;
    }
    if (node.children !== null) {
      dispatch({ type: 'expand', path: node.path });
      return;
    }
    dispatch({ type: 'loading', path: node.path });
    api
      .browseFs(node.path)
      .then((listing) => dispatch({ type: 'loaded', listing }))
      .catch((e) => dispatch({ type: 'error', path: node.path, message: errText(e) }));
  };

  const rootNode = state.rootPath ? state.nodes[state.rootPath] : undefined;

  if (state.rootError) {
    return (
      <p className="rounded-md border border-edge bg-field px-2.5 py-2 text-small text-muted">
        Couldn&rsquo;t browse the filesystem: {state.rootError}. Type a path below instead.
      </p>
    );
  }

  if (!rootNode) {
    return (
      <p className="rounded-md border border-edge bg-field px-2.5 py-2 text-small text-muted">
        Loading directories…
      </p>
    );
  }

  return (
    <div
      role="tree"
      aria-label="Directory picker"
      className="max-h-56 overflow-auto rounded-md border border-edge bg-field py-1"
    >
      {visibleRows(state).map(({ node, depth }) => {
        const isSelected = node.path === selected;
        const label = depth === 0 ? node.path : node.name;
        return (
          <div
            key={node.path}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={node.expanded}
            aria-selected={isSelected}
            className={`flex items-center gap-1 pr-2 ${
              isSelected ? 'bg-accent-tint text-accent' : 'text-ink hover:bg-raised'
            }`}
            style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
          >
            <button
              type="button"
              className="flex min-h-7 min-w-6 items-center justify-center text-muted hover:text-ink"
              aria-label={node.expanded ? `Collapse ${label}` : `Expand ${label}`}
              onClick={() => toggle(node)}
            >
              {node.loading ? (
                <span className="text-faint">·</span>
              ) : (
                <Icon
                  name="chevron-down"
                  className={`transition-transform duration-150 ${node.expanded ? '' : '-rotate-90'}`}
                />
              )}
            </button>
            <button
              type="button"
              className="min-h-7 flex-1 truncate text-left font-data text-small"
              title={node.path}
              onClick={() => onSelect(node.path)}
            >
              {label}
            </button>
            {node.error && <span className="text-small text-fail" title={node.error}>failed</span>}
          </div>
        );
      })}
    </div>
  );
}
