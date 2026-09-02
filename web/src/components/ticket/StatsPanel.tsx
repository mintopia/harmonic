import type { ReactNode } from 'react';
import { formatCost, usd } from '../../cost';
import { modelTotal, type TaskModelStats, type TaskStats } from '../../task-detail-model';
import type { AttemptSummary, AttemptUsageEvent } from '../../types';
import type { StatsAttempt } from '../../task-detail-model';
import { card } from '../../ui';
import { BarChart, type Bar } from '../BarChart';
import { Donut, type DonutSegment } from '../Donut';
import { EmptyState } from '../EmptyState';

const sectionCaps = 'text-label font-bold uppercase tracking-[0.1em] text-faint';
const TOKEN_SEGMENTS = [
  { key: 'input' as const, label: 'input', fill: 'bg-token-input' },
  { key: 'output' as const, label: 'output', fill: 'bg-token-output' },
  { key: 'cachedIn' as const, label: 'cached in', fill: 'bg-token-cache-read' },
  { key: 'cachedOut' as const, label: 'cached out', fill: 'bg-token-cache-write' },
];
const COST_DONUT_COLORS = ['var(--hm-accent)', 'var(--hm-ink)', 'var(--hm-muted)', 'var(--hm-faint)', 'var(--hm-edge-strong)'];
const compactTokens = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function ModelTokenBar({ model, maxTotal }: { model: TaskModelStats; maxTotal: number }) {
  const total = modelTotal(model);
  const widthPct = maxTotal > 0 ? (total / maxTotal) * 100 : 0;
  const seg = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3"><span className="truncate font-data text-data font-semibold text-ink" title={model.model}>{model.model}</span><span className="shrink-0 tabular-nums text-data text-muted">{compactTokens.format(total)}</span></div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-raised" style={{ width: `${Math.max(4, widthPct)}%` }} aria-hidden="true">{TOKEN_SEGMENTS.map((s) => <span key={s.key} className={`h-full ${s.fill}`} style={{ width: `${seg(model[s.key])}%` }} />)}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-label tabular-nums text-faint">{TOKEN_SEGMENTS.map((s) => <span key={s.key}>{s.label} {compactTokens.format(model[s.key])}</span>)}</div>
    </div>
  );
}

function TokenLegend() {
  return <div className="flex flex-wrap gap-x-3 gap-y-1 text-label text-faint">{TOKEN_SEGMENTS.map((s) => <span key={s.key} className="inline-flex items-center gap-1.5"><span className={`size-2 rounded-[2px] ${s.fill}`} aria-hidden="true" />{s.label}</span>)}</div>;
}

function TokenBreakdownCard({ byModel }: { byModel: TaskModelStats[] }) {
  const maxTotal = Math.max(...byModel.map(modelTotal), 1);
  return <section className={`${card} p-5`}><div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2"><h3 className={sectionCaps}>Token breakdown by model</h3><TokenLegend /></div><div className="flex flex-col gap-4">{byModel.map((m) => <ModelTokenBar key={m.model} model={m} maxTotal={maxTotal} />)}</div></section>;
}

function AgentDonutCard({ stats }: { stats: TaskStats }) {
  const { agentTokens, subagentTokens } = stats.agentVsSubagent;
  const total = agentTokens + subagentTokens;
  const pct = (v: number) => (total > 0 ? `${Math.round((v / total) * 100)}%` : '0%');
  const subLabel = `${stats.subagents} subagent${stats.subagents === 1 ? '' : 's'}`;
  const segments: DonutSegment[] = [{ key: 'agent', label: 'Primary agent', value: agentTokens, valueLabel: pct(agentTokens), color: 'var(--hm-accent)' }, { key: 'subagent', label: subLabel, value: subagentTokens, valueLabel: pct(subagentTokens), color: 'var(--hm-muted)' }];
  return <section className={`${card} p-5`}><div className="mb-4 flex items-baseline gap-1.5"><h3 className={sectionCaps}>Agent vs subagent</h3><span className="text-label text-faint">· share of tokens</span></div>{total > 0 ? <Donut segments={segments} total={total} hideCenter percent={false} ariaLabel="Agent versus subagent token share" /> : <p className="text-muted">No per-agent breakdown for this Task.</p>}</section>;
}

function CostDonutCard({ stats }: { stats: TaskStats }) {
  const segments: DonutSegment[] = stats.costByModel.map((m, i) => ({ key: m.model, label: m.model, value: m.cost, valueLabel: usd(m.cost), color: COST_DONUT_COLORS[i % COST_DONUT_COLORS.length]! }));
  return <section className={`${card} p-5`}><h3 className={`${sectionCaps} mb-4`}>Cost by model</h3>{segments.length > 0 ? <Donut segments={segments} total={stats.cost} totalDisplay={usd(stats.cost)} totalLabel="TOTAL" percent={false} ariaLabel="Cost by model" /> : <p className="text-muted">No priced usage yet.</p>}</section>;
}

function StatsSummaryCard({ stats }: { stats: TaskStats }) {
  const items: Array<[string, ReactNode]> = [['Cost', usd(stats.cost)], ['Agents', <><span>{stats.agents}</span> <span className="ml-0.5 text-[11px] font-normal text-muted">primary</span></>], ['Subagents', `${stats.subagents}`], ['Tool calls', stats.toolCalls.toLocaleString()]];
  return <section className={`${card} flex flex-wrap gap-x-10 gap-y-4 p-5`}>{items.map(([k, v]) => <div key={k} className="min-w-0"><div className="mb-[5px] text-[10px] font-bold uppercase tracking-[0.07em] text-faint">{k}</div><div className="text-[17px] font-bold leading-none text-ink tabular-nums">{v}</div></div>)}</section>;
}

export interface StatsPanelProps { stats: TaskStats }

export function StatsPanel({ stats }: StatsPanelProps) {
  if (stats.byModel.length === 0) return <EmptyState title="Stats" className="py-12">The Task's AI-usage breakdown will appear here once an Attempt has run.</EmptyState>;
  return <div className="flex flex-col gap-4 py-5"><h2 className="text-title font-semibold text-ink">Stats</h2><StatsSummaryCard stats={stats} /><TokenBreakdownCard byModel={stats.byModel} /><div className="grid gap-4 md:grid-cols-2"><AgentDonutCard stats={stats} /><CostDonutCard stats={stats} /></div></div>;
}

function ToolTokenCard({ tools }: { tools: TaskStats['toolTokens'] }) {
  const bars: Bar[] = tools.map((t) => ({ key: t.key, label: t.label, value: t.outputTokens, valueLabel: t.cost === undefined ? compactTokens.format(t.outputTokens) : `${compactTokens.format(t.outputTokens)} · ${usd(t.cost)}` }));
  return <section className={`${card} p-5`}><h3 className={`${sectionCaps} mb-4`}>Output tokens by tool</h3><BarChart bars={bars} ariaLabel="Output tokens and cost by tool" /></section>;
}

export function AttemptStats({ stats }: { stats: TaskStats }) {
  if (stats.byModel.length === 0) return null;
  return <div className="flex flex-col gap-4 py-5"><div className="grid gap-4 md:grid-cols-2"><TokenBreakdownCard byModel={stats.byModel} /><AgentDonutCard stats={stats} /></div>{stats.toolTokens.length > 0 && <ToolTokenCard tools={stats.toolTokens} />}</div>;
}

export interface AttemptSummaryCardProps {
  run: AttemptSummary;
  snapshot: AttemptUsageEvent | undefined;
  model: string;
  toolCalls: number;
}

function fmtDur(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function AttemptSummaryCard({ run, snapshot, model, toolCalls }: AttemptSummaryCardProps) {
  const runCost = run.state === 'running' ? snapshot?.cost ?? run.cost : run.cost;
  // eslint-disable-next-line react/purity -- one-shot elapsed snapshot for a running attempt; this card does not tick
  const durMs = run.finishedAt ? Math.max(0, run.finishedAt - run.startedAt) : run.state === 'running' ? Math.max(0, Date.now() - run.startedAt) : 0;
  const contextTokens = run.state === 'running' ? snapshot?.contextTokens ?? run.contextTokens ?? null : run.contextTokens ?? null;
  const contextWindow = run.contextWindow ?? null;
  const items: Array<[string, ReactNode]> = [
    ['Model', <span key="model" className="font-data">{model}</span>],
    ['Cost', formatCost(runCost) ?? '—'],
    ['Duration', durMs > 0 ? fmtDur(durMs) : '—'],
    ['Tool calls', toolCalls > 0 ? toolCalls.toLocaleString() : '—'],
    ['Context', contextTokens === null ? '—' : <span key="context">{contextTokens.toLocaleString()}{contextWindow !== null && <span className="ml-1 font-medium text-muted"> / {contextWindow.toLocaleString()} · {Math.round((contextTokens / contextWindow) * 100)}%</span>}</span>],
    ['Session', run.sessionId ? <span key="session" className="font-data text-[12.5px]">{run.sessionId}</span> : 'cold start'],
  ];
  return <section className={`${card} mt-4 flex flex-wrap gap-x-9 gap-y-3 p-4`}>{items.map(([key, value]) => <div key={key} className="min-w-0"><div className="mb-[5px] text-[10px] font-bold uppercase tracking-[0.07em] text-faint">{key}</div><div className="text-[14px] font-bold leading-none text-ink tabular-nums">{value}</div></div>)}</section>;
}

export function statsAttemptsOf(runs: AttemptSummary[], live: Map<number, AttemptUsageEvent>): StatsAttempt[] {
  return runs.map((run) => {
    const snapshot = run.state === 'running' ? live.get(run.id) : undefined;
    return { usage: snapshot?.usage ?? run.usage, cost: snapshot?.cost ?? run.cost, toolCalls: run.toolCalls };
  });
}
