// elkjs layered layout for the Dependency Graph view (issue #85, ADR 0015).
// This module is the browser-only elk adapter: it builds the elk graph, calls
// elk for node/group *positions* (layer assignment + crossing minimisation — the
// hard part), and hands the raw result to the pure `flattenElkLayout`
// (graph-model.ts) for the parent-relative→absolute coordinate maths. Keeping
// elk isolated here is what lets the flatten be unit-tested without pulling elkjs
// into the node test project.
//
// Map grouping is expressed the elk-native way: same `mapRef` → a group node
// whose children are the members. elk positions the members together; the view
// then draws the group as nothing but a quiet floating label + per-node badge,
// never a container box (ADR 0015 / prototype #84).
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Task } from './types';
import { flattenElkLayout, type GraphEdge, type Layout, type LayoutOpts } from './graph-model';

// Re-exported so existing view imports (`from './graph-layout'`) keep resolving.
export type { Direction, LaidGroup, LaidNode, Layout, LayoutOpts } from './graph-model';

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
  const groupTitles = new Map([...maps.entries()].map(([ref, g]) => [ref, g.title]));
  return flattenElkLayout(res, groupTitles, byId, edges);
}
