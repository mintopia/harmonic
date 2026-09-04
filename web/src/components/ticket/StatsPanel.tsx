import type { ReactNode } from 'react';
import { formatCost, usd } from '../../cost';
import { modelTotal, type TaskModelStats, type TaskStats } from '../../task-detail-model';
import type { AttemptSummary, AttemptUsageEvent } from '../../types';
import type { StatsAttempt } from '../../task-detail-model';
import { card } from '../../ui';
import { BarChart, type Bar } from '../BarChart';
import { Donut, type DonutSegment } from '../Donut';
import { EmptyState } from '../EmptyState';
import { TokenTypeBar, TokenTypeLegend } from '../TokenTypeBar';
import type { ModelUsage } from '../../stats-model';

const sectionCaps = 'text-label font-bold uppercase tracking-[0.1em] text-faint';
const COST_DONUT_COLORS = ['var(--hm-accent)', 'var(--hm-ink)', 'var(--hm-muted)', 'var(--hm-faint)', 'var(--hm-edge-strong)'];
const compactTokens = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

const modelUsage = (m: TaskModelStats): ModelUsage => ({
  inputTokens: m.input,
  outputTokens: m.output,
  cacheReadTokens: m.cachedIn,
  cacheWriteTokens: m.cachedOut,
});

function TokenBreakdownCard({ byModel }: { byModel: TaskModelStats[] }) {
  const maxTotal = Math.max(...byModel.map(modelTotal), 1);
  return <section className={`${card} p-5`}><div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2"><h3 className={sectionCaps}>Token breakdown by model</h3><TokenTypeLegend /></div><div className="flex flex-col gap-4">{byModel.map((m) => <TokenTypeBar key={m.model} label={m.model} usage={modelUsage(m)} maxTotal={maxTotal} trailing={m.cost == null ? undefined : usd(m.cost)} />)}</div></section>;
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
