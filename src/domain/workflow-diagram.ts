import type { WorkflowDefinition, WorkflowStepDefinition } from './workflow.js';

export type DiagramNodeKind = 'step' | 'attempts' | 'parallel' | 'cleanup' | 'escalation';
export interface DiagramNode { id: string; kind: DiagramNodeKind; label: string; detail?: string; condition?: string; parent?: string; uses?: string }
export type DiagramEdgeKind = 'outcome' | 'back' | 'escalation' | 'done';
export interface DiagramEdge { from: string; to: string; kind: DiagramEdgeKind; label?: string }
export interface WorkflowDiagramModel { nodes: DiagramNode[]; edges: DiagramEdge[] }

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

function stepDetail(step: WorkflowStepDefinition): string | undefined {
  const uses = step.uses ?? (step.run === undefined ? undefined : 'run');
  if (uses === undefined) return undefined;
  const w = step.with ?? {};
  const tail =
    uses === 'run' ? text(step.run)
    : uses === 'command' ? text(w.command)
    : uses === 'critic' ? [text(w.harness), text(w.model)].filter((p) => p !== undefined).join(' ')
    : uses === 'agent' && text(w.prompt) !== undefined ? `prompt ${text(w.prompt)}`
    : undefined;
  return tail ? `${uses} · ${tail}` : uses;
}

function stepNode(step: WorkflowStepDefinition, parent?: string): DiagramNode {
  const node: DiagramNode = { id: step.id, kind: step.parallel ? 'parallel' : 'step', label: step.id };
  const detail = stepDetail(step);
  if (detail !== undefined) node.detail = detail;
  if (step.if !== undefined) node.condition = step.if;
  if (parent !== undefined) node.parent = parent;
  const uses = step.uses ?? (step.run === undefined ? undefined : 'run');
  if (uses !== undefined) node.uses = uses;
  return node;
}

/** Derives the read-only control-flow diagram from a parsed Workflow: sequential pass edges, the bounded Attempts loop, and escalation exits. */
export function buildWorkflowDiagram(def: WorkflowDefinition): WorkflowDiagramModel {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const { start, end } = def.attempts;
  const hasBlock = end > start;
  if (hasBlock) nodes.push({ id: 'attempts', kind: 'attempts', label: 'Attempts', detail: `max: ${def.attempts.max}` });
  def.steps.forEach((step, i) => {
    const inBlock = hasBlock && i >= start && i < end;
    nodes.push(stepNode(step, inBlock ? 'attempts' : undefined));
    for (const child of step.parallel ?? []) nodes.push(stepNode(child, step.id));
  });
  nodes.push({ id: 'escalation', kind: 'escalation', label: 'Escalation', detail: 'Retry · Accept · Close' });

  def.steps.forEach((step, i) => {
    const next = def.steps[i + 1];
    if (next) edges.push({ from: step.id, to: next.id, kind: 'outcome', label: 'pass' });
  });
  if (hasBlock) {
    edges.push({ from: def.steps[end - 1]!.id, to: def.steps[start]!.id, kind: 'back', label: 'fail · inconclusive' });
    edges.push({ from: 'attempts', to: 'escalation', kind: 'escalation', label: 'max reached' });
  }
  def.steps.forEach((step, i) => {
    if (hasBlock && i >= start && i < end) return;
    edges.push({ from: step.id, to: 'escalation', kind: 'escalation', label: step.uses === 'merge' ? 'conflict' : 'fail' });
  });
  const last = def.steps[def.steps.length - 1];
  if (def.cleanup && last) {
    const detail = def.cleanup.map((s) => (s.uses ? `uses: ${s.uses}` : `run: ${s.run ?? s.id}`)).join('\n');
    nodes.push({ id: 'cleanup', kind: 'cleanup', label: 'Cleanup', detail });
    edges.push({ from: last.id, to: 'cleanup', kind: 'done', label: 'done' });
  }
  return { nodes, edges };
}
