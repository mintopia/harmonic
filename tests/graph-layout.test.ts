import { describe, expect, it } from 'vitest';
import { flattenElkLayout, type ElkLaidGraph, type GraphEdge } from '../web/src/graph-model.js';
import type { Task, TaskState } from '../web/src/types.js';

/** A Task fixture — the flatten only reads id (via the elk node id) and carries
 * the whole Task through; the rest are the neutral defaults the model test uses. */
const task = (id: number, state: TaskState = 'ready', extra: Partial<Task> = {}): Task => ({
  id,
  prompt: `task ${id}`,
  summary: `task ${id}`,
  workspaceId: 1,
  harness: 'claude',
  model: 'claude-fable-5',
  workingDir: '/tmp',
  isolationMode: 'direct',
  priority: 'normal',
  baseBranch: null,
  conflictResolveTurns: 2,
  overrides: { harness: null, model: null, isolationMode: null, priority: null, conflictResolveTurns: null },
  state,
  feedback: null,
  createdAt: id,
  updatedAt: id,
  dependsOn: [],
  dependents: [],
  blockedOnFailed: false,
  cost: null,
  origin: 'native',
  trackerRef: null,
  workflow: null,
  wayfinderType: null,
  escalationReason: null,
  openBlockerCount: 0,
  agentWorkable: true,
  humanOnly: false,
  isEpic: false,
  mapRef: null,
  url: null,
  mapTitle: null,
  branch: null,
  stat: null,
  runStartedAt: null,
  toolCount: null,
  attemptId: null,
  currentStep: null,
  contextTokens: null,
  contextWindow: null,
  verifiedRef: null,
  skipReason: null,
  ...extra,
});

describe('flattenElkLayout', () => {
  const byId = new Map([1, 2, 3].map((id) => [id, task(id)]));

  it('passes loose nodes through at root level, carrying edges and dimensions', () => {
    const res: ElkLaidGraph = {
      width: 500,
      height: 200,
      children: [
        { id: 't1', x: 0, y: 10, width: 196, height: 60 },
        { id: 't2', x: 260, y: 10, width: 196, height: 60 },
      ],
    };
    const edges: GraphEdge[] = [{ from: 1, to: 2 }];
    const layout = flattenElkLayout(res, new Map(), byId, edges);

    expect(layout.nodes).toEqual([
      { id: 1, task: byId.get(1), x: 0, y: 10, w: 196, h: 60 },
      { id: 2, task: byId.get(2), x: 260, y: 10, w: 196, h: 60 },
    ]);
    expect(layout.groups).toEqual([]);
    expect(layout.edges).toEqual(edges);
    expect(layout.width).toBe(500);
    expect(layout.height).toBe(200);
  });

  it('adds a group origin to member coords (parent-relative → absolute)', () => {
    const res: ElkLaidGraph = {
      width: 600,
      height: 300,
      children: [
        {
          id: 'm41',
          x: 100,
          y: 50,
          width: 240,
          height: 160,
          // elk returns member coords relative to the group's own box.
          children: [
            { id: 't1', x: 14, y: 34, width: 196, height: 60 },
            { id: 't2', x: 14, y: 110, width: 196, height: 60 },
          ],
        },
        { id: 't3', x: 400, y: 60, width: 196, height: 60 },
      ],
    };
    const layout = flattenElkLayout(res, new Map([[41, 'Graph view']]), byId, []);

    expect(layout.groups).toEqual([{ ref: 41, title: 'Graph view', x: 100, y: 50, w: 240, h: 160 }]);
    // Members are absolute now: group origin (100,50) + relative (14,34)/(14,110).
    expect(layout.nodes).toContainEqual({ id: 1, task: byId.get(1), x: 114, y: 84, w: 196, h: 60 });
    expect(layout.nodes).toContainEqual({ id: 2, task: byId.get(2), x: 114, y: 160, w: 196, h: 60 });
    // The loose node stays at root, unshifted.
    expect(layout.nodes).toContainEqual({ id: 3, task: byId.get(3), x: 400, y: 60, w: 196, h: 60 });
  });

  it('falls back to `Map <ref>` when no title is supplied for a group', () => {
    const res: ElkLaidGraph = {
      children: [{ id: 'm7', x: 0, y: 0, width: 100, height: 100, children: [{ id: 't1', x: 0, y: 0, width: 10, height: 10 }] }],
    };
    const layout = flattenElkLayout(res, new Map(), byId, []);
    expect(layout.groups[0]!.title).toBe('Map 7');
  });

  it('defaults missing coordinates and an empty result to zeroes', () => {
    expect(flattenElkLayout({}, new Map(), byId, [])).toEqual({
      nodes: [],
      groups: [],
      edges: [],
      width: 0,
      height: 0,
    });
    // A node elk placed with no explicit x/y/size merges at the origin with 0 size.
    const layout = flattenElkLayout({ children: [{ id: 't1' }] }, new Map(), byId, []);
    expect(layout.nodes[0]).toEqual({ id: 1, task: byId.get(1), x: 0, y: 0, w: 0, h: 0 });
  });
});
