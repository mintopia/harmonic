import { useEffect, useState } from 'react';
import type { DiagramEdgeKind, DiagramNode, WorkflowDiagramModel } from '../../../src/domain/workflow-diagram.js';
import { layoutWorkflowDiagram, type DiagramLayout, type PlacedEdge, type PlacedNode } from '../workflow-diagram-layout.js';

const EDGE_STYLE: Record<DiagramEdgeKind, { stroke: string; dash?: string; text: string }> = {
  outcome: { stroke: 'var(--hm-muted)', text: 'var(--hm-done)' },
  back: { stroke: 'var(--hm-fail-dot)', dash: '4 3', text: 'var(--hm-fail)' },
  escalation: { stroke: 'var(--hm-await)', text: 'var(--hm-await)' },
  done: { stroke: 'var(--hm-faint)', dash: '2 3', text: 'var(--hm-faint)' },
};

function NodeBox({ p }: { p: PlacedNode }) {
  const { node, x, y, width, height } = p;
  const group = node.kind === 'attempts' || node.kind === 'parallel';
  const cx = x + width / 2;
  const fill = node.kind === 'escalation' ? 'var(--hm-await-tint)' : node.kind === 'cleanup' ? 'var(--hm-sunken)' : group ? 'none' : 'var(--hm-surface)';
  const stroke = node.kind === 'attempts' ? 'var(--hm-accent)' : node.kind === 'escalation' ? 'var(--hm-await)' : node.kind === 'parallel' ? 'var(--hm-edge)' : 'var(--hm-edge-strong)';
  const dash = group || node.kind === 'cleanup' ? '5 3' : undefined;
  return (
    <g data-node={node.id} data-kind={node.kind}>
      <rect x={x} y={y} width={width} height={height} rx={4} fill={fill} stroke={stroke} strokeDasharray={dash} strokeWidth={1.2} />
      {group ? (
        <text x={x + 10} y={y + 18} fontSize={10} fontWeight={700} letterSpacing={0.6} fill={node.kind === 'attempts' ? 'var(--hm-accent)' : 'var(--hm-muted)'}>
          {node.kind === 'attempts' ? `ATTEMPTS${node.detail ? ` · ${node.detail}` : ''}` : `PARALLEL · ${node.label}`}
        </text>
      ) : node.kind === 'cleanup' ? (
        <>
          <text x={x + 10} y={y + 18} fontSize={10} fontWeight={700} letterSpacing={0.6} fill="var(--hm-muted)">CLEANUP</text>
          {(node.detail ?? '').split('\n').map((line, i) => (
            <text key={line + i} x={x + 10} y={y + 32 + i * 12} fontSize={10} fontFamily="var(--hm-mono, monospace)" fill="var(--hm-muted)">{line}</text>
          ))}
        </>
      ) : (
        <>
          <text x={cx} y={y + (node.detail ? 19 : height / 2 + 4)} textAnchor="middle" fontSize={12} fontWeight={700} fill="var(--hm-ink)">{node.label}</text>
          {node.detail && <text x={cx} y={y + 33} textAnchor="middle" fontSize={9.5} fontFamily="var(--hm-mono, monospace)" fill="var(--hm-muted)">{node.detail}</text>}
          {node.condition && <text x={cx} y={y + 47} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="var(--hm-ink)">{`◇ if: ${node.condition}`}</text>}
        </>
      )}
    </g>
  );
}

function EdgePath({ p }: { p: PlacedEdge }) {
  if (p.points.length < 2) return null;
  const style = EDGE_STYLE[p.edge.kind];
  const d = p.points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x},${pt.y}`).join(' ');
  return (
    <g data-edge={`${p.edge.from}>${p.edge.to}`} data-kind={p.edge.kind}>
      <path d={d} fill="none" stroke={style.stroke} strokeDasharray={style.dash} strokeWidth={1.3} markerEnd={`url(#wfd-arrow-${p.edge.kind})`} />
      {p.edge.label && <text x={p.labelAt.x + 6} y={p.labelAt.y} fontSize={10.5} fontWeight={700} fill={style.text}>{p.edge.label}</text>}
    </g>
  );
}

function Fallback({ nodes }: { nodes: DiagramNode[] }) {
  return (
    <ul style={{ margin: 0, padding: '0 0 0 18px', fontSize: 12, color: 'var(--hm-muted)' }}>
      {nodes.map((n) => (
        <li key={n.id}>{n.label}{n.detail ? ` · ${n.detail.replace(/\n/g, ', ')}` : ''}</li>
      ))}
    </ul>
  );
}

/** Read-only live diagram of a Workflow's control flow; dimmed while the editor holds errors and the last valid parse is shown. */
export function WorkflowDiagram({ model, stale, errorCount }: { model: WorkflowDiagramModel | null; stale: boolean; errorCount: number }) {
  const [layout, setLayout] = useState<{ model: WorkflowDiagramModel; value: DiagramLayout } | null>(null);
  useEffect(() => {
    if (!model) return;
    let live = true;
    layoutWorkflowDiagram(model).then(
      (value) => { if (live) setLayout({ model, value }); },
      () => {},
    );
    return () => { live = false; };
  }, [model]);
  const ready = layout !== null && layout.model === model ? layout.value : null;
  return (
    <section aria-label="Workflow step diagram" style={{ background: 'var(--hm-surface)', border: '1px solid var(--hm-hairline)', borderRadius: 6, padding: 16 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--hm-ink)' }}>Live diagram</h3>
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 8px', borderRadius: 999, background: stale ? 'var(--hm-raised)' : 'var(--hm-accent-tint)', color: stale ? 'var(--hm-muted)' : 'var(--hm-accent)' }}>
          {stale ? 'Stale' : 'Matches the editor'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--hm-muted)' }}>read-only</span>
      </header>
      {stale && (
        <p role="status" style={{ margin: '0 0 12px', padding: '8px 10px', background: 'var(--hm-sunken)', fontSize: 12, color: 'var(--hm-ink)' }}>
          <strong>Showing last valid parse.</strong> Fix the {errorCount} {errorCount === 1 ? 'error' : 'errors'} to refresh the diagram.
        </p>
      )}
      <div data-stale={stale} style={{ opacity: stale ? 0.45 : 1, overflow: 'auto' }}>
        {!model ? (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--hm-muted)' }}>Nothing to draw yet.</p>
        ) : ready ? (
          <svg role="img" aria-label="Workflow step diagram graphic" width={ready.width} height={ready.height} viewBox={`0 0 ${ready.width} ${ready.height}`}>
            <defs>
              {(Object.keys(EDGE_STYLE) as DiagramEdgeKind[]).map((k) => (
                <marker key={k} id={`wfd-arrow-${k}`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill={EDGE_STYLE[k].stroke} />
                </marker>
              ))}
            </defs>
            {[...ready.nodes].sort((a, b) => Number(b.node.kind === 'attempts') - Number(a.node.kind === 'attempts')).map((p) => <NodeBox key={p.node.id} p={p} />)}
            {ready.edges.map((p, i) => <EdgePath key={i} p={p} />)}
          </svg>
        ) : (
          <Fallback nodes={model.nodes} />
        )}
      </div>
    </section>
  );
}
