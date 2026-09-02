import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Task } from './types';
import { flattenElkLayout, type GraphEdge, type Layout, type LayoutOpts } from './graph-model';

const elk = new ELK();

export async function layoutGraph(tasks: Task[], edges: GraphEdge[], opts: LayoutOpts): Promise<Layout> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const labelPad = opts.groupLabelPad ?? 34;

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

  const children: ElkNode['children'] = [
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

  const graph: ElkNode = {
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

  const res = await elk.layout(graph);
  const groupTitles = new Map([...maps.entries()].map(([ref, g]) => [ref, g.title]));
  return flattenElkLayout(res, groupTitles, byId, edges);
}
