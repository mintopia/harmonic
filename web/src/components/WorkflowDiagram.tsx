import { useMemo } from 'react';
import type { DiagramEdgeKind, WorkflowDiagramModel } from '../../../src/domain/workflow-diagram.js';
import { computeLayout, type PlacedEdge, type PlacedNode } from '../workflow-diagram-layout.js';

const EDGE_STYLE: Record<DiagramEdgeKind, { stroke: string; dash?: string; text: string }> = {
  outcome: { stroke: 'var(--hm-muted)', text: 'var(--hm-done)' },
  back: { stroke: 'var(--hm-fail-dot)', dash: '4 3', text: 'var(--hm-fail)' },
  escalation: { stroke: 'var(--hm-await)', text: 'var(--hm-await)' },
  done: { stroke: 'var(--hm-faint)', dash: '2 3', text: 'var(--hm-faint)' },
};

function conditionLabel(condition: string): string {
  const bare = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  return bare.length > 22 ? `${bare.slice(0, 21)}…` : bare;
}

function NodeBox({ p }: { p: PlacedNode }) {
  const { node, x, y, width, height } = p;
  const group = node.kind === 'attempts' || node.kind === 'parallel';
  const cx = x + width / 2;
  const fill = node.kind === 'escalation' ? 'var(--hm-await-tint)' : node.kind === 'cleanup' ? 'var(--hm-sunken)' : node.uses === 'merge' ? 'var(--hm-merged-tint)' : group ? 'none' : 'var(--hm-surface)';
  const stroke =
    node.kind === 'attempts' ? 'var(--hm-accent)'
    : node.kind === 'escalation' ? 'var(--hm-await)'
    : node.kind === 'parallel' ? 'var(--hm-edge-strong)'
    : node.kind === 'cleanup' ? 'var(--hm-faint)'
    : node.uses === 'merge' ? 'var(--hm-merged)'
    : node.uses === 'critic' ? 'var(--hm-ready)'
    : node.uses === 'agent' ? 'var(--hm-accent)'
    : 'var(--hm-edge-strong)';
  const dash = node.kind === 'attempts' ? '5 4' : group || node.kind === 'cleanup' ? '2 3' : undefined;
  const mono = 'var(--hm-mono, monospace)';
  return (
    <g data-node={node.id} data-kind={node.kind}>
      <rect x={x} y={y} width={width} height={height} rx={4} fill={fill} stroke={stroke} strokeDasharray={dash} strokeWidth={1.2} />
      {group ? (
        <text x={x + 10} y={y + 18} fontSize={11} fontWeight={600} letterSpacing={0.5} fill={node.kind === 'attempts' ? 'var(--hm-accent)' : 'var(--hm-muted)'}>
          {node.kind === 'attempts' ? `ATTEMPTS${node.detail ? ` · ${fit(node.detail, 14)}` : ''}` : 'PARALLEL'}
        </text>
      ) : node.kind === 'cleanup' ? (
        <>
          <text x={x + 10} y={y + 17} fontSize={11} fontWeight={600} letterSpacing={0.5} fill="var(--hm-muted)">CLEANUP</text>
          {(node.detail ?? '').split('\n').map((line, i) => (
            <text key={line + i} x={x + 10} y={y + 32 + i * 12} fontSize={11} fontFamily={mono} fill="var(--hm-muted)">{line}</text>
          ))}
          <text x={x + 10} y={y + 32 + Math.max(1, (node.detail ?? '').split('\n').length) * 12} fontSize={11} fill="var(--hm-faint)">runs on done and on Close</text>
        </>
      ) : p.inParallel ? (
        <>
          <text x={x + 12} y={y + 17} fontSize={13} fontWeight={600} fill="var(--hm-ink)">{node.label}</text>
          {(node.detail ?? '').split('\n').map((line, i) => (
            <text key={line + i} x={x + 12} y={y + 32 + i * 13} fontSize={10} fontFamily={mono} fill="var(--hm-muted)">{fit(line, 28)}</text>
          ))}
          {node.condition && <text x={x + 12} y={y + height - 12} fontSize={11} fontWeight={700} fill="var(--hm-ink)">{`◇ if: ${conditionLabel(node.condition)}`}</text>}
        </>
      ) : (
        <>
          <text x={cx} y={y + (node.detail ? 17 : height / 2 + 4)} textAnchor="middle" fontSize={13} fontWeight={600} fill={node.kind === 'escalation' ? 'var(--hm-await)' : 'var(--hm-ink)'}>{node.label}</text>
          {node.detail && <text x={cx} y={y + 31} textAnchor="middle" fontSize={11} fontFamily={node.kind === 'escalation' ? undefined : mono} fill={node.kind === 'escalation' ? 'var(--hm-await)' : 'var(--hm-muted)'}>{fit(node.detail, 26)}</text>}
          {node.condition && <text x={cx} y={y + 44} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--hm-ink)">{`◇ if: ${conditionLabel(node.condition)}`}</text>}
        </>
      )}
    </g>
  );
}

const fit = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const HALO = { paintOrder: 'stroke', stroke: 'var(--hm-surface)', strokeWidth: 4, strokeLinejoin: 'round' } as const;

function EdgePath({ p }: { p: PlacedEdge }) {
  if (p.points.length < 2) return null;
  const style = EDGE_STYLE[p.edge.kind];
  const d = p.points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x},${pt.y}`).join(' ');
  return (
    <g data-edge={`${p.edge.from}>${p.edge.to}`} data-kind={p.edge.kind}>
      <path d={d} fill="none" stroke={style.stroke} strokeDasharray={style.dash} strokeWidth={1.3} markerEnd={`url(#wfd-arrow-${p.edge.kind})`} />
      {p.label && <text x={p.label.x} y={p.label.y} textAnchor={p.label.anchor} fontSize={11} fontWeight={700} fill={style.text} style={HALO}>{p.label.text}</text>}
      {p.subLabel && <text x={p.subLabel.x} y={p.subLabel.y} textAnchor={p.subLabel.anchor} fontSize={11} fill="var(--hm-muted)" style={HALO}>{p.subLabel.text}</text>}
    </g>
  );
}

const LEGEND: { kind: DiagramEdgeKind; label: string }[] = [
  { kind: 'outcome', label: 'outcome edge' },
  { kind: 'back', label: 'back edge to next Attempt' },
  { kind: 'escalation', label: 'to Escalation' },
  { kind: 'done', label: 'to cleanup when done' },
];

function Legend() {
  return (
    <ul aria-label="Diagram legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', margin: '12px 0 0', padding: 0, listStyle: 'none', fontSize: 10.5, color: 'var(--hm-muted)' }}>
      {LEGEND.map(({ kind, label }) => (
        <li key={kind} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width={18} height={6} aria-hidden="true"><line x1={0} y1={3} x2={18} y2={3} stroke={EDGE_STYLE[kind].stroke} strokeDasharray={EDGE_STYLE[kind].dash} strokeWidth={1.3} /></svg>
          {label}
        </li>
      ))}
    </ul>
  );
}

/** Read-only live diagram of a Workflow's control flow; dimmed while the editor holds errors and the last valid parse is shown. */
export function WorkflowDiagram({ model, stale, errorCount }: { model: WorkflowDiagramModel | null; stale: boolean; errorCount: number }) {
  const ready = useMemo(() => (model ? computeLayout(model) : null), [model]);
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
        ) : ready && (
          <svg role="img" aria-label="Workflow step diagram graphic" width={ready.width} height={ready.height} style={{ display: 'block', flex: 'none' }} viewBox={`0 0 ${ready.width} ${ready.height}`}>
            <defs>
              {(Object.keys(EDGE_STYLE) as DiagramEdgeKind[]).map((k) => (
                <marker key={k} id={`wfd-arrow-${k}`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill={EDGE_STYLE[k].stroke} />
                </marker>
              ))}
            </defs>
            {[...ready.nodes].sort((a, b) => Number(b.node.kind === 'attempts' || b.node.kind === 'parallel') - Number(a.node.kind === 'attempts' || a.node.kind === 'parallel')).map((p) => <NodeBox key={p.node.id} p={p} />)}
            {ready.edges.map((p, i) => <EdgePath key={i} p={p} />)}
          </svg>
        )}
      </div>
      {model && <div style={{ opacity: stale ? 0.45 : 1 }}><Legend /></div>}
    </section>
  );
}
