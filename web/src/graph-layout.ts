// elkjs layered layout for the Dependency Graph view (issue #85, ADR 0015).
// We use elk ONLY for node/group *positions* (layer assignment + crossing
// minimisation — the hard part). Edges are drawn by the view from the returned
// node boxes, so edge styling stays ours and we avoid elk's cross-hierarchy
// edge-coordinate frames.
//
// Map grouping is expressed the elk-native way: same `mapRef` → a group node
// whose children are the members. elk positions the members together; the view
// then draws the group as nothing but a quiet floating label + per-node badge,
// never a container box (ADR 0015 / prototype #84).
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Task } from './types';
import type { GraphEdge } from './graph-model';

export type Direction = 'DOWN' | 'RIGHT';

export interface LaidNode {
  id: number;
  task: Task;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LaidGroup {
  ref: number;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
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

const elk = new ELK();

export async function layoutGraph(tasks: Task[], edges: GraphEdge[], opts: LayoutOpts): Promise<Layout> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const labelPad = opts.groupLabelPad ?? 34;

  // Bucket tasks by Map; unmapped ones sit at root level.
  const maps = new Map<number, { title: string; members: Task[] }>();
  const loose: Task[] = [];
  for (const t of tasks) {
    if (t.mapRef != null) {
      const g = maps.get(t.mapRef) ?? { title: t.mapTitle ?? `Map ${t.mapRef}`, members: [] };
      g.members.push(t);
      maps.set(t.mapRef, g);
    } else {
      loose.push(t);
    }
  }

  const taskNode = (t: Task) => ({ id: `t${t.id}`, width: opts.nodeW, height: opts.nodeH });

  const children: unknown[] = [
    ...[...maps.entries()].map(([ref, g]) => ({
      id: `m${ref}`,
      layoutOptions: {
        'elk.padding': `[top=${labelPad},left=14,bottom=14,right=14]`,
        'elk.spacing.nodeNode': '18',
      },
      children: g.members.map(taskNode),
    })),
    ...loose.map(taskNode),
  ];

  const elkEdges = edges.map((e) => ({
    id: `e${e.from}_${e.to}`,
    sources: [`t${e.from}`],
    targets: [`t${e.to}`],
  }));

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': opts.direction,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '58',
      'elk.spacing.nodeNode': '26',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children,
    edges: elkEdges,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await elk.layout(graph as any);

  // Flatten to absolute coordinates (child coords are parent-relative).
  const nodes: LaidNode[] = [];
  const groups: LaidGroup[] = [];
  for (const child of res.children ?? []) {
    if (child.id.startsWith('m')) {
      const ref = Number(child.id.slice(1));
      const ox = child.x ?? 0;
      const oy = child.y ?? 0;
      groups.push({ ref, title: maps.get(ref)!.title, x: ox, y: oy, w: child.width ?? 0, h: child.height ?? 0 });
      for (const gc of child.children ?? []) {
        nodes.push(node(gc, byId, ox, oy));
      }
    } else {
      nodes.push(node(child, byId, 0, 0));
    }
  }

  return {
    nodes,
    groups,
    edges,
    width: res.width ?? 0,
    height: res.height ?? 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function node(elkNode: any, byId: Map<number, Task>, ox: number, oy: number): LaidNode {
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
