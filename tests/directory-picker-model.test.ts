import { describe, expect, it } from 'vitest';
import {
  emptyPicker,
  reducePicker,
  visibleRows,
  type PickerState,
} from '../web/src/directory-picker-model.js';
import type { FsListing } from '../web/src/types.js';

const listing = (path: string, parent: string | null, childNames: string[]): FsListing => ({
  path,
  parent,
  entries: childNames.map((name) => ({ name, path: `${path === '/' ? '' : path}/${name}` })),
});

const withRoot = (l: FsListing): PickerState => reducePicker(emptyPicker(), { type: 'loaded', listing: l });

describe('reducePicker — loading a listing', () => {
  it('records the root path and creates a node per child, collapsed and unloaded', () => {
    const state = withRoot(listing('/home/dev', '/home', ['alpha', 'beta']));

    expect(state.rootPath).toBe('/home/dev');
    const root = state.nodes['/home/dev']!;
    expect(root.expanded).toBe(true);
    expect(root.loading).toBe(false);
    expect(root.children).toEqual(['/home/dev/alpha', '/home/dev/beta']);

    const alpha = state.nodes['/home/dev/alpha']!;
    expect(alpha.name).toBe('alpha');
    expect(alpha.expanded).toBe(false);
    expect(alpha.children).toBeNull();
  });

  it('merges a child listing without disturbing sibling nodes', () => {
    let state = withRoot(listing('/home/dev', '/home', ['alpha', 'beta']));
    state = reducePicker(state, { type: 'loaded', listing: listing('/home/dev/alpha', '/home/dev', ['nested']) });

    const alpha = state.nodes['/home/dev/alpha']!;
    expect(alpha.expanded).toBe(true);
    expect(alpha.loading).toBe(false);
    expect(alpha.children).toEqual(['/home/dev/alpha/nested']);
    expect(state.nodes['/home/dev/beta']!.children).toBeNull();
    expect(state.nodes['/home/dev/alpha/nested']!.name).toBe('nested');
  });

  it('clears a prior error when a listing finally loads', () => {
    let state = withRoot(listing('/home/dev', '/home', ['alpha']));
    state = reducePicker(state, { type: 'error', path: '/home/dev/alpha', message: 'permission denied' });
    expect(state.nodes['/home/dev/alpha']!.error).toBe('permission denied');
    state = reducePicker(state, { type: 'loaded', listing: listing('/home/dev/alpha', '/home/dev', []) });
    expect(state.nodes['/home/dev/alpha']!.error).toBeNull();
  });
});

describe('reducePicker — expand / collapse / loading / error', () => {
  it('loading marks the node expanded and busy', () => {
    let state = withRoot(listing('/home/dev', '/home', ['alpha']));
    state = reducePicker(state, { type: 'loading', path: '/home/dev/alpha' });
    const alpha = state.nodes['/home/dev/alpha']!;
    expect(alpha.loading).toBe(true);
    expect(alpha.expanded).toBe(true);
  });

  it('collapse hides children but keeps them loaded', () => {
    let state = withRoot(listing('/home/dev', '/home', ['alpha']));
    state = reducePicker(state, { type: 'loaded', listing: listing('/home/dev/alpha', '/home/dev', ['nested']) });
    state = reducePicker(state, { type: 'collapse', path: '/home/dev/alpha' });
    expect(state.nodes['/home/dev/alpha']!.expanded).toBe(false);
    expect(state.nodes['/home/dev/alpha']!.children).toEqual(['/home/dev/alpha/nested']);
  });

  it('expand re-shows already-loaded children', () => {
    let state = withRoot(listing('/home/dev', '/home', ['alpha']));
    state = reducePicker(state, { type: 'loaded', listing: listing('/home/dev/alpha', '/home/dev', ['nested']) });
    state = reducePicker(state, { type: 'collapse', path: '/home/dev/alpha' });
    state = reducePicker(state, { type: 'expand', path: '/home/dev/alpha' });
    expect(state.nodes['/home/dev/alpha']!.expanded).toBe(true);
  });

  it('error stops the spinner, collapses back, and records the message', () => {
    let state = withRoot(listing('/home/dev', '/home', ['alpha']));
    state = reducePicker(state, { type: 'loading', path: '/home/dev/alpha' });
    state = reducePicker(state, { type: 'error', path: '/home/dev/alpha', message: 'nope' });
    const alpha = state.nodes['/home/dev/alpha']!;
    expect(alpha.loading).toBe(false);
    expect(alpha.expanded).toBe(false);
    expect(alpha.children).toBeNull();
    expect(alpha.error).toBe('nope');
  });
});

describe('reducePicker — root failure', () => {
  it('records a root-load failure and leaves the tree unrooted', () => {
    const state = reducePicker(emptyPicker(), { type: 'root-error', message: 'permission denied' });
    expect(state.rootError).toBe('permission denied');
    expect(state.rootPath).toBeNull();
    expect(visibleRows(state)).toEqual([]);
  });

  it('clears a prior root error once home finally loads', () => {
    let state = reducePicker(emptyPicker(), { type: 'root-error', message: 'transient' });
    state = reducePicker(state, { type: 'loaded', listing: listing('/home/dev', '/home', ['alpha']) });
    expect(state.rootError).toBeNull();
    expect(state.rootPath).toBe('/home/dev');
  });
});

describe('visibleRows', () => {
  it('is empty before the root loads', () => {
    expect(visibleRows(emptyPicker())).toEqual([]);
  });

  it('lists the root then its children by depth', () => {
    const state = withRoot(listing('/home/dev', '/home', ['alpha', 'beta']));
    expect(visibleRows(state).map((r) => [r.node.path, r.depth])).toEqual([
      ['/home/dev', 0],
      ['/home/dev/alpha', 1],
      ['/home/dev/beta', 1],
    ]);
  });

  it('includes children only while their parent is expanded', () => {
    let state = withRoot(listing('/home/dev', '/home', ['alpha', 'beta']));
    state = reducePicker(state, { type: 'loaded', listing: listing('/home/dev/alpha', '/home/dev', ['nested']) });
    expect(visibleRows(state).map((r) => r.node.path)).toEqual([
      '/home/dev',
      '/home/dev/alpha',
      '/home/dev/alpha/nested',
      '/home/dev/beta',
    ]);
    state = reducePicker(state, { type: 'collapse', path: '/home/dev/alpha' });
    expect(visibleRows(state).map((r) => r.node.path)).toEqual([
      '/home/dev',
      '/home/dev/alpha',
      '/home/dev/beta',
    ]);
  });

  it('does not descend into a node whose children are still loading', () => {
    let state = withRoot(listing('/home/dev', '/home', ['alpha']));
    state = reducePicker(state, { type: 'loading', path: '/home/dev/alpha' });
    expect(visibleRows(state).map((r) => r.node.path)).toEqual(['/home/dev', '/home/dev/alpha']);
  });
});
