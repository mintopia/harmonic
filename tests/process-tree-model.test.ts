import { describe, expect, it } from 'vitest';
import {
  flattenTree,
  frameEvents,
  nodeStatus,
  nodeTokens,
  statusLabel,
  trackNodeActivity,
  HIDDEN_AFTER_MS,
  INACTIVE_AFTER_MS,
  NO_NODE_ACTIVITY,
  type NodeActivityMap,
} from '../web/src/process-tree-model.js';
import type { ProcessNode } from '../web/src/types.js';

const mu = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

const node = (over: Partial<ProcessNode> & { id: string }): ProcessNode => ({
  name: over.id,
  model: 'sonnet-5',
  usage: mu(),
  contextTokens: null,
  lastTool: null,
  status: 'active',
  depth: 0,
  toolUseId: null,
  children: [],
  ...over,
});

describe('nodeTokens', () => {
  it('sums a node\'s own footprint across input, output, and both cache sides', () => {
    expect(nodeTokens(node({ id: 'x', usage: mu(10, 20, 5, 3) }))).toBe(38);
  });
});

describe('trackNodeActivity — the idle-lifecycle bookkeeping', () => {
  const tree = node({ id: 'root', usage: mu(100), children: [node({ id: 'a', depth: 1, usage: mu(5) })] });

  it('stamps every node on first sight', () => {
    const map = trackNodeActivity(NO_NODE_ACTIVITY, tree, 1_000);
    expect(nodeStatus(tree, map, 1_000)).toBe('active');
    expect(nodeStatus(tree.children[0]!, map, 1_000)).toBe('active');
  });

  it('keeps the old timestamp when a node\'s write signature is unchanged, so it keeps aging', () => {
    const first = trackNodeActivity(NO_NODE_ACTIVITY, tree, 1_000);
    const later = trackNodeActivity(first, tree, 5_000);
    expect(nodeStatus(tree, later, 1_000 + INACTIVE_AFTER_MS)).toBe('inactive');
  });

  it('re-stamps a node whose tokens changed — a new write reactivates it', () => {
    const first = trackNodeActivity(NO_NODE_ACTIVITY, tree, 1_000);
    const grew = node({ id: 'root', usage: mu(200), children: [node({ id: 'a', depth: 1, usage: mu(5) })] });
    const second = trackNodeActivity(first, grew, 1_000 + INACTIVE_AFTER_MS + 1);
    expect(nodeStatus(grew, second, 1_000 + INACTIVE_AFTER_MS + 1)).toBe('active');
    expect(nodeStatus(grew.children[0]!, second, 1_000 + INACTIVE_AFTER_MS + 1)).toBe('inactive');
  });

  it('drops nodes that vanish from the tree', () => {
    const first = trackNodeActivity(NO_NODE_ACTIVITY, tree, 1_000);
    const pruned = node({ id: 'root', usage: mu(100) });
    const second = trackNodeActivity(first, pruned, 2_000);
    expect(Object.keys(second)).toEqual(['root']);
  });
});

describe('nodeStatus — active → inactive → hidden by idle age', () => {
  const n = node({ id: 'x' });

  it('walks the ladder as idle age crosses each threshold', () => {
    const map = trackNodeActivity(NO_NODE_ACTIVITY, n, 0);
    expect(nodeStatus(n, map, INACTIVE_AFTER_MS - 1)).toBe('active');
    expect(nodeStatus(n, map, INACTIVE_AFTER_MS)).toBe('inactive');
    expect(nodeStatus(n, map, HIDDEN_AFTER_MS)).toBe('hidden');
  });

  it('never revives a node the server already retired (server status is a floor)', () => {
    const server = node({ id: 'x', status: 'inactive' });
    const map = trackNodeActivity(NO_NODE_ACTIVITY, server, 100);
    expect(nodeStatus(server, map, 100)).toBe('inactive');
  });

  it('falls back to the server status while untracked', () => {
    expect(nodeStatus(node({ id: 'x', status: 'inactive' }), NO_NODE_ACTIVITY, 0)).toBe('inactive');
  });
});

describe('flattenTree — rows, connectors, and hidden pruning', () => {
  const fresh = (tree: ProcessNode): NodeActivityMap => trackNodeActivity(NO_NODE_ACTIVITY, tree, 0);

  it('flattens depth-first with correct guides/isLast for a nested tree', () => {
    const tree = node({
      id: 'root',
      children: [
        node({ id: 'a', depth: 1, children: [node({ id: 'x', depth: 2 })] }),
        node({ id: 'b', depth: 1 }),
      ],
    });
    const rows = flattenTree(tree, fresh(tree), 0);
    expect(rows.map((r) => r.node.id)).toEqual(['root', 'a', 'x', 'b']);

    const byId = Object.fromEntries(rows.map((r) => [r.node.id, r]));
    expect(byId.root!.isLast).toBe(true);
    expect(byId.a!.isLast).toBe(false);
    expect(byId.b!.isLast).toBe(true);
    expect(byId.x!.isLast).toBe(true);
    expect(byId.x!.guides).toEqual([true]);
    expect(byId.a!.guides).toEqual([]);

    expect(byId.root!.posInSet).toBe(1);
    expect(byId.root!.setSize).toBe(1);
    expect(byId.a!.posInSet).toBe(1);
    expect(byId.a!.setSize).toBe(2);
    expect(byId.b!.posInSet).toBe(2);
    expect(byId.b!.setSize).toBe(2);
    expect(byId.x!.posInSet).toBe(1);
    expect(byId.x!.setSize).toBe(1);
  });

  it('prunes a hidden leaf but keeps a hidden node that still spines to a visible child', () => {
    const tree = node({
      id: 'root',
      children: [
        node({ id: 'gone', depth: 1, status: 'hidden' }),
        node({ id: 'spine', depth: 1, status: 'hidden', children: [node({ id: 'live', depth: 2, status: 'active' })] }),
      ],
    });
    const map = trackNodeActivity(NO_NODE_ACTIVITY, tree, 0);
    const rows = flattenTree(tree, map, 0);
    const ids = rows.map((r) => r.node.id);
    expect(ids).toContain('spine');
    expect(ids).toContain('live');
    expect(ids).not.toContain('gone');
  });

  it('recomputes isLast over visible siblings only', () => {
    const tree = node({
      id: 'root',
      children: [node({ id: 'a', depth: 1, status: 'active' }), node({ id: 'b', depth: 1, status: 'hidden' })],
    });
    const rows = flattenTree(tree, trackNodeActivity(NO_NODE_ACTIVITY, tree, 0), 0);
    expect(rows.map((r) => r.node.id)).toEqual(['root', 'a']);
    expect(rows.find((r) => r.node.id === 'a')!.isLast).toBe(true);
  });

  it('always keeps the root, even if it would age to hidden', () => {
    const tree = node({ id: 'root', status: 'hidden' });
    const rows = flattenTree(tree, trackNodeActivity(NO_NODE_ACTIVITY, tree, 0), HIDDEN_AFTER_MS * 10);
    expect(rows.map((r) => r.node.id)).toEqual(['root']);
  });
});

describe('statusLabel — the sr-only text equivalent of a node\'s status', () => {
  it('spells out each status as its announced word', () => {
    expect(statusLabel('active')).toBe('active');
    expect(statusLabel('inactive')).toBe('idle');
    expect(statusLabel('hidden')).toBe('hidden');
  });
});

describe('frameEvents — framing the transcript on one node', () => {
  const ev = (id: number, parentToolUseId?: string) => ({
    id,
    seq: id,
    ts: id,
    type: 'session_update',
    payload: parentToolUseId ? { _meta: { claudeCode: { parentToolUseId } } } : { sessionUpdate: 'agent_message_chunk' },
  });

  const events = [ev(1), ev(2, 'toolu_sub'), ev(3), ev(4, 'toolu_other'), ev(5, 'toolu_sub')];

  it('the root frames on top-level events only (no Subagent tag)', () => {
    const root = node({ id: 'root', depth: 0 });
    expect(frameEvents(events, root).map((e) => e.id)).toEqual([1, 3]);
  });

  it('a Subagent frames on the events tagged with its spawning tool-use id', () => {
    const sub = node({ id: 's', depth: 1, toolUseId: 'toolu_sub' });
    expect(frameEvents(events, sub).map((e) => e.id)).toEqual([2, 5]);
  });

  it('a Subagent with no toolUseId (or one nested past the stream) frames empty', () => {
    expect(frameEvents(events, node({ id: 's', depth: 1, toolUseId: null }))).toEqual([]);
    expect(frameEvents(events, node({ id: 's', depth: 2, toolUseId: 'toolu_deep' }))).toEqual([]);
  });
});
