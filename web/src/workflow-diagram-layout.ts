import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { DiagramEdge, DiagramNode, WorkflowDiagramModel } from '../../src/domain/workflow-diagram.js';

export interface PlacedNode { node: DiagramNode; x: number; y: number; width: number; height: number }
export interface PlacedEdge { edge: DiagramEdge; points: { x: number; y: number }[]; labelAt: { x: number; y: number } }
export interface DiagramLayout { nodes: PlacedNode[]; edges: PlacedEdge[]; width: number; height: number }

const SIZE: Record<DiagramNode['kind'], { width: number; height: number }> = {
  step: { width: 176, height: 46 },
  parallel: { width: 0, height: 0 },
  attempts: { width: 0, height: 0 },
  cleanup: { width: 210, height: 64 },
  escalation: { width: 140, height: 46 },
};
const CHILD = { width: 170, height: 58 };

const elk = new ELK();

export function diagramElkGraph(model: WorkflowDiagramModel): ElkNode {
  const byParent = new Map<string | undefined, DiagramNode[]>();
  for (const n of model.nodes) byParent.set(n.parent, [...(byParent.get(n.parent) ?? []), n]);
  const build = (n: DiagramNode): ElkNode => {
    const kids = byParent.get(n.id);
    if (kids) {
      return {
        id: n.id,
        layoutOptions: { 'elk.padding': '[top=30,left=16,bottom=16,right=16]', 'elk.spacing.nodeNode': '14', 'elk.direction': n.kind === 'parallel' ? 'RIGHT' : 'DOWN' },
        children: kids.map(build),
      };
    }
    const size = n.parent !== undefined && n.kind === 'step' && model.nodes.find((p) => p.id === n.parent)?.kind === 'parallel' ? CHILD : SIZE[n.kind];
    return { id: n.id, ...size };
  };
  const edges: ElkExtendedEdge[] = model.edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] }));
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '46',
      'elk.spacing.nodeNode': '40',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.json.edgeCoords': 'ROOT',
    },
    children: (byParent.get(undefined) ?? []).map(build),
    edges,
  };
}

export async function layoutWorkflowDiagram(model: WorkflowDiagramModel): Promise<DiagramLayout> {
  const res = await elk.layout(diagramElkGraph(model));
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const nodes: PlacedNode[] = [];
  const walk = (n: ElkNode, ox: number, oy: number): void => {
    const x = ox + (n.x ?? 0);
    const y = oy + (n.y ?? 0);
    const node = nodeById.get(n.id);
    if (node) nodes.push({ node, x, y, width: n.width ?? 0, height: n.height ?? 0 });
    for (const c of n.children ?? []) walk(c, x, y);
  };
  for (const c of res.children ?? []) walk(c, 0, 0);
  const edges: PlacedEdge[] = model.edges.map((edge, i) => {
    const section = (res.edges as ElkExtendedEdge[] | undefined)?.[i]?.sections?.[0];
    const points = section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : [];
    const mid = points[Math.floor((points.length - 1) / 2)] ?? { x: 0, y: 0 };
    const nxt = points[Math.floor(points.length / 2)] ?? mid;
    return { edge, points, labelAt: { x: (mid.x + nxt.x) / 2, y: (mid.y + nxt.y) / 2 } };
  });
  return { nodes, edges, width: res.width ?? 0, height: res.height ?? 0 };
}
