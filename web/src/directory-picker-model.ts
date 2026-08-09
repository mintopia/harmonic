import type { FsListing } from './types.js';

/**
 * Pure state for the lazy directory picker (issue #67) over `GET /api/fs`
 * (issue #62). The tree starts at the server user's home and expands one level
 * per click; each node's children are fetched on first expansion and cached, so
 * re-expanding is instant and collapsing never loses them. The component owns
 * the async fetches and the `<input>` binding (selection is lifted to the
 * working-dir field, not held here); everything in this module is a plain,
 * testable transform. The free-text path field remains the manual-entry
 * fallback for anywhere outside the browsable tree.
 */

/** One directory node in the lazy tree. */
export interface DirNode {
  /** Absolute path — the key in `nodes` and the value fed back as `?path=`. */
  path: string;
  /** Basename shown in the row (the root shows its full path instead). */
  name: string;
  expanded: boolean;
  loading: boolean;
  /** A load failure (permission denied, gone) shown inline; cleared on reload. */
  error: string | null;
  /** Child paths once fetched, or `null` while unloaded. */
  children: string[] | null;
}

export interface PickerState {
  nodes: Record<string, DirNode>;
  /** The home listing's path, set on first load; `null` until then. */
  rootPath: string | null;
  /** A failure to load home at all — the picker degrades to the text field. */
  rootError: string | null;
}

export type PickerAction =
  | { type: 'loaded'; listing: FsListing }
  | { type: 'root-error'; message: string }
  | { type: 'loading'; path: string }
  | { type: 'expand'; path: string }
  | { type: 'collapse'; path: string }
  | { type: 'error'; path: string; message: string };

export function emptyPicker(): PickerState {
  return { nodes: {}, rootPath: null, rootError: null };
}

/** A fresh, collapsed, unloaded node. */
function makeNode(path: string, name: string): DirNode {
  return { path, name, expanded: false, loading: false, error: null, children: null };
}

/** Replace one node, returning a new state (nodes map copied shallowly). */
function patch(state: PickerState, path: string, changes: Partial<DirNode>): PickerState {
  const existing = state.nodes[path] ?? makeNode(path, path);
  return { ...state, nodes: { ...state.nodes, [path]: { ...existing, ...changes } } };
}

export function reducePicker(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case 'loaded': {
      const { path, entries } = action.listing;
      const nodes = { ...state.nodes };
      // Preserve the existing node's name (basename) if we already knew it;
      // the root has no prior node, so fall back to its full path.
      const prior = nodes[path];
      nodes[path] = {
        ...(prior ?? makeNode(path, path)),
        expanded: true,
        loading: false,
        error: null,
        children: entries.map((e) => e.path),
      };
      for (const entry of entries) {
        if (!nodes[entry.path]) nodes[entry.path] = makeNode(entry.path, entry.name);
      }
      return { ...state, nodes, rootPath: state.rootPath ?? path, rootError: null };
    }
    case 'root-error':
      return { ...state, rootError: action.message };
    case 'loading':
      return patch(state, action.path, { loading: true, expanded: true, error: null });
    case 'expand':
      return patch(state, action.path, { expanded: true });
    case 'collapse':
      return patch(state, action.path, { expanded: false });
    // A failed expansion collapses back so the next click retries the fetch
    // rather than merely toggling a phantom-open node shut.
    case 'error':
      return patch(state, action.path, { loading: false, expanded: false, error: action.message });
  }
}

export interface PickerRow {
  node: DirNode;
  depth: number;
}

/**
 * Depth-first flatten of the visible tree for rendering: the root, then each
 * expanded node's children. An expanded-but-still-loading node (children still
 * `null`) contributes no child rows, so a spinner never sits over phantom
 * entries.
 */
export function visibleRows(state: PickerState): PickerRow[] {
  if (!state.rootPath) return [];
  const rows: PickerRow[] = [];
  const walk = (path: string, depth: number): void => {
    const node = state.nodes[path];
    if (!node) return;
    rows.push({ node, depth });
    if (node.expanded && node.children) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  walk(state.rootPath, 0);
  return rows;
}
