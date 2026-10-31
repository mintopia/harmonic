import type { DiagramEdge, DiagramNode, WorkflowDiagramModel } from '../../src/domain/workflow-diagram.js';

export interface PlacedNode { node: DiagramNode; x: number; y: number; width: number; height: number; inParallel?: boolean }
export interface PlacedLabel { x: number; y: number; anchor: 'start' | 'middle' | 'end'; text: string }
export interface PlacedEdge { edge: DiagramEdge; points: { x: number; y: number }[]; label?: PlacedLabel; subLabel?: PlacedLabel }
export interface DiagramLayout { nodes: PlacedNode[]; edges: PlacedEdge[]; width: number; height: number }

/** Horizontal stretch applied to the whole layout so node text fits; the geometry below is in the unstretched units of the #920 mockup. */
const SX = 1.18;
const CX = 190;
const STEP_W = 160;
const STEP_H = 40;
const GAP = 30;
const GROUP_X = 10;
const GROUP_MIN_W = 400;
const GROUP_TOP = 34;
const GROUP_BOTTOM = 18;
const CHILD_W = 165;
const CHILD_H = 70;
const CHILD_GAP = 10;
const PAR_HEAD = 26;
const ESC_W = 118;
const ESC_H = 40;

interface Box { x: number; y: number; w: number; h: number }

const midY = (b: Box): number => b.y + b.h / 2;

/** Deterministic layout: one column of steps, Attempts and Parallel groups as boxes around their members, Escalation to the right beside the first step that escalates. */
export function layoutWorkflowDiagram(model: WorkflowDiagramModel): Promise<DiagramLayout> {
  return Promise.resolve(computeLayout(model));
}

export function computeLayout(model: WorkflowDiagramModel): DiagramLayout {
  const boxes = new Map<string, Box>();
  const parallelChild = new Set<string>();
  const kids = new Map<string, DiagramNode[]>();
  for (const n of model.nodes) if (n.parent !== undefined) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const parallelIds = new Set(model.nodes.filter((n) => n.kind === 'parallel').map((n) => n.id));
  for (const n of model.nodes) if (n.parent !== undefined && parallelIds.has(n.parent)) parallelChild.add(n.id);

  const stepHeight = (n: DiagramNode): number => (n.condition !== undefined ? STEP_H + 14 : STEP_H);
  const parallelWidth = (n: DiagramNode): number => (kids.get(n.id)?.length ?? 1) * (CHILD_W + CHILD_GAP) - CHILD_GAP + 20;

  const placeParallel = (n: DiagramNode, x: number, y: number): number => {
    const members = kids.get(n.id) ?? [];
    boxes.set(n.id, { x, y, w: parallelWidth(n), h: PAR_HEAD + CHILD_H + 10 });
    members.forEach((m, i) => boxes.set(m.id, { x: x + 10 + i * (CHILD_W + CHILD_GAP), y: y + PAR_HEAD, w: CHILD_W, h: CHILD_H }));
    return PAR_HEAD + CHILD_H + 10;
  };
  const placeMember = (n: DiagramNode, y: number, gx: number): number => {
    if (n.kind === 'parallel') return placeParallel(n, gx + 10, y);
    boxes.set(n.id, { x: CX - STEP_W / 2, y, w: STEP_W, h: stepHeight(n) });
    return stepHeight(n);
  };

  type Item = { group: DiagramNode; members: DiagramNode[] } | { node: DiagramNode };
  const items: Item[] = [];
  const attempts = model.nodes.find((n) => n.kind === 'attempts');
  let groupDone = false;
  for (const n of model.nodes) {
    if (n.kind === 'escalation' || n.kind === 'cleanup' || n.kind === 'attempts' || parallelChild.has(n.id)) continue;
    if (attempts && n.parent === attempts.id) {
      if (!groupDone) items.push({ group: attempts, members: kids.get(attempts.id) ?? [] });
      groupDone = true;
    } else items.push({ node: n });
  }

  let y = 8;
  let right = CX + STEP_W / 2;
  let groupRight = 0;
  for (const item of items) {
    if ('node' in item) {
      y += placeMember(item.node, y, GROUP_X - 10) + GAP;
    } else {
      const wide = Math.max(0, ...item.members.filter((m) => m.kind === 'parallel').map(parallelWidth));
      const gw = Math.max(GROUP_MIN_W, wide + 20);
      let inner = y + GROUP_TOP;
      item.members.forEach((m, i) => { inner += placeMember(m, inner, GROUP_X) + (i < item.members.length - 1 ? GAP : 0); });
      const h = inner + GROUP_BOTTOM - y;
      boxes.set(item.group.id, { x: GROUP_X, y, w: gw, h });
      groupRight = GROUP_X + gw;
      right = Math.max(right, groupRight);
      y += h + GAP;
    }
  }
  let bottom = y - GAP;

  const cleanup = model.nodes.find((n) => n.kind === 'cleanup');
  if (cleanup) {
    const h = 32 + 12 * Math.max(1, (cleanup.detail ?? '').split('\n').length) + 14;
    boxes.set(cleanup.id, { x: 90, y: bottom + GAP + 8, w: 200, h });
    bottom += GAP + 8 + h;
  }

  const escSources = model.edges.filter((e) => e.to === 'escalation' && e.from !== attempts?.id);
  const anchor = escSources.length ? boxes.get(escSources[0]!.from) : undefined;
  const escX = Math.max(groupRight + 14, 424);
  const escY = anchor ? anchor.y : attempts && boxes.get(attempts.id) ? boxes.get(attempts.id)!.y + boxes.get(attempts.id)!.h + GAP : 8;
  boxes.set('escalation', { x: escX, y: escY, w: ESC_W, h: ESC_H });
  bottom = Math.max(bottom, escY + ESC_H);
  const escCx = escX + ESC_W / 2;
  const backX = (groupRight || right + 22) - 18;

  const px = (v: number): number => v * SX;
  const edges: PlacedEdge[] = model.edges.map((edge) => {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) return { edge, points: [] };
    const label = (text: string, x: number, yy: number, anchorAt: PlacedLabel['anchor']): PlacedLabel => ({ text, x: px(x), y: yy, anchor: anchorAt });
    if (edge.kind === 'back') {
      const startY = midY(a);
      const endY = midY(b);
      const points = [{ x: a.x + a.w, y: startY }, { x: backX, y: startY }, { x: backX, y: endY }, { x: b.x + b.w, y: endY }];
      const ly = b.y + b.h + 26;
      return {
        edge,
        points: points.map((p) => ({ x: px(p.x), y: p.y })),
        ...(edge.label ? { label: label(edge.label, backX - 6, ly, 'end') } : {}),
        subLabel: label('next Attempt', backX - 6, ly + 12, 'end'),
      };
    }
    if (edge.kind === 'escalation') {
      const fromGroup = edge.from === attempts?.id;
      const startY = fromGroup ? a.y + a.h * 0.6 : midY(a);
      if (!fromGroup && Math.abs(startY - midY(b)) < 1) {
        return { edge, points: [{ x: px(a.x + a.w), y: startY }, { x: px(b.x), y: startY }], ...(edge.label ? { label: label(edge.label, (a.x + a.w + b.x) / 2, startY - 6, 'middle') } : {}) };
      }
      const endY = startY < b.y ? b.y : b.y + b.h;
      const points = [{ x: a.x + a.w, y: startY }, { x: escCx, y: startY }, { x: escCx, y: endY }];
      const lx = fromGroup ? a.x + a.w + 9 / SX : (a.x + a.w + escCx) / 2;
      return { edge, points: points.map((p) => ({ x: px(p.x), y: p.y })), ...(edge.label ? { label: label(edge.label, lx, startY - 6, fromGroup ? 'start' : 'middle') } : {}) };
    }
    const y1 = a.y + a.h;
    const y2 = b.y;
    return { edge, points: [{ x: px(CX), y: y1 }, { x: px(CX), y: y2 }], ...(edge.label ? { label: label(edge.label, CX + 10 / SX, (y1 + y2) / 2 + 4, 'start') } : {}) };
  });

  const nodes: PlacedNode[] = model.nodes.flatMap((node) => {
    const b = boxes.get(node.id);
    return b ? [{ node, x: px(b.x), y: b.y, width: px(b.w), height: b.h, ...(parallelChild.has(node.id) ? { inParallel: true } : {}) }] : [];
  });
  return { nodes, edges, width: px(escX + ESC_W) + 10, height: bottom + 16 };
}
