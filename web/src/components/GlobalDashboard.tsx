import { useState } from 'react';
import { api } from '../api';
import { formatCost } from '../cost';
import { cacheHitRate, type Stats, type WorkspaceStats } from '../stats-model';
import type { ActivityProcess, Task } from '../types';
import type { HostLoad } from '../ws';
import { useAsyncResource } from '../useAsyncResource';
import { card, labelType, tableHead, touchOverlay } from '../ui';
import { LoadError } from './LoadError';
import { PageHeader } from './PageHeader';

const TOKEN_TYPES = [
  { key: 'inputTokens', label: 'Input' },
  { key: 'outputTokens', label: 'Output' },
  { key: 'cacheReadTokens', label: 'Cache read' },
  { key: 'cacheWriteTokens', label: 'Cache write' },
] as const;

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const number = (value: number) => value.toLocaleString();
type View = 'table' | 'activity' | 'stats';
type SortKey = 'name' | 'cost' | 'needs' | 'flight' | 'io' | 'cache' | 'week';
type Row = WorkspaceStats & { needs: number; flight: number; weekCost: WorkspaceStats['cost'] };

async function allTasks(): Promise<Task[]> {
  const tasks: Task[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await api.tasks({ limit: 100, offset });
    tasks.push(...page.tasks);
    if (tasks.length >= page.total || page.tasks.length === 0) return tasks;
  }
}

function Rollup({ title, detail, value, onClick, tone = 'text-ink' }: { title: string; detail: string; value: string; onClick: () => void; tone?: string }) {
  return (
    <button type="button" onClick={onClick} className={`${card} min-h-32 p-5 text-left transition-colors duration-150 hover:bg-raised`}>
      <div className={`${labelType} text-muted`}>{title}</div>
      <div className={`mt-2 text-display font-display-weight tabular-nums ${tone}`}>{value}</div>
      <p className="mt-2 text-small text-muted">{detail}</p>
    </button>
  );
}

function TokenBars({ workspaces, onOpenWorkspace }: { workspaces: WorkspaceStats[]; onOpenWorkspace: (workspaceId: number) => void }) {
  return (
    <section className={`${card} p-5`} aria-labelledby="tokens-today-title">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="tokens-today-title" className="text-title font-semibold text-ink">Tokens today</h2>
          <p className="mt-1 text-small text-muted">Each token type is split by Workspace.</p>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-label text-muted">
          {workspaces.map((workspace) => <button key={workspace.workspaceId} type="button" className="relative inline-flex items-center gap-1.5 hover:text-ink" onClick={() => onOpenWorkspace(workspace.workspaceId)}><span className="flex size-4 items-center justify-center rounded-full text-[9px] font-bold text-[#1b1e24]" style={{ backgroundColor: workspace.color }} aria-hidden="true">{workspace.name.trim().charAt(0).toUpperCase()}</span>{workspace.name}<span aria-hidden="true" className={touchOverlay} /></button>)}
        </div>
      </div>
      <div className="grid gap-4" role="region" aria-label="Tokens by workspace">
        {TOKEN_TYPES.map(({ key, label }) => {
          const total = workspaces.reduce((sum, workspace) => sum + workspace[key], 0);
          return <div key={key}><div className="mb-1.5 flex items-baseline justify-between gap-3"><span className="text-small font-medium text-ink">{label}</span><span className="text-label tabular-nums text-muted">{compact.format(total)}</span></div><div className="flex h-3 overflow-hidden rounded-full bg-raised">{workspaces.map((workspace) => <span key={workspace.workspaceId} role="img" aria-label={`${workspace.name}: ${number(workspace[key])} ${label.toLowerCase()} tokens`} title={`${workspace.name}: ${number(workspace[key])} ${label.toLowerCase()} tokens`} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${total === 0 ? 0 : workspace[key] / total * 100}%`, backgroundColor: workspace.color }} />)}</div></div>;
        })}
      </div>
    </section>
  );
}

export function GlobalDashboard({ pendingPermissions, hostLoad, onNavigate, onOpenWorkspace }: { pendingPermissions: number; hostLoad: HostLoad | null; onNavigate: (view: View) => void; onOpenWorkspace: (workspaceId: number) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'cost', desc: true });

  const dashboard = useAsyncResource(async () => {
    const now = Date.now();
    const [today, week, tasks, activity] = await Promise.all([
      api.stats(now - 24 * 3600_000, now), api.stats(now - 7 * 24 * 3600_000, now), allTasks(), api.activity(),
    ]);
    return { today, week, tasks, processes: activity.processes };
  }, [], { pollMs: 15_000 });
  const today: Stats | null = dashboard.data?.today ?? null;
  const week: Stats | null = dashboard.data?.week ?? null;
  const tasks: Task[] = dashboard.data?.tasks ?? [];
  const processes: ActivityProcess[] = dashboard.data?.processes ?? [];

  const rows: Row[] = (today?.byWorkspace ?? []).map((workspace) => ({
    ...workspace,
    needs: tasks.filter((task) => task.workspaceId === workspace.workspaceId && task.state === 'escalated').length,
    flight: processes.filter((process) => process.workspaceId === workspace.workspaceId).length,
    weekCost: week?.byWorkspace.find((candidate) => candidate.workspaceId === workspace.workspaceId)?.cost ?? null,
  }));
  const escalated = tasks.filter((task) => task.state === 'escalated').length;
  const totals = rows.reduce((total, row) => ({ needs: total.needs + row.needs, flight: total.flight + row.flight, input: total.input + row.inputTokens, output: total.output + row.outputTokens, read: total.read + row.cacheReadTokens, write: total.write + row.cacheWriteTokens }), { needs: 0, flight: 0, input: 0, output: 0, read: 0, write: 0 });
  const ordered = [...rows].sort((a, b) => {
    const value = (row: Row): string | number => sort.key === 'name' ? row.name : sort.key === 'cost' ? row.cost?.totalUsd ?? -1 : sort.key === 'needs' ? row.needs : sort.key === 'flight' ? row.flight : sort.key === 'io' ? row.inputTokens + row.outputTokens : sort.key === 'cache' ? cacheHitRate(row) ?? -1 : row.weekCost?.totalUsd ?? -1;
    const left = value(a); const right = value(b);
    const compared = typeof left === 'string' && typeof right === 'string' ? left.localeCompare(right) : Number(left) - Number(right);
    return sort.desc ? -compared : compared;
  });
  const toggleSort = (key: SortKey) => setSort((current) => ({ key, desc: current.key === key ? !current.desc : key !== 'name' }));
  const cache = today ? cacheHitRate(today.totals) : null;
  const io = today?.totals ? today.totals.inputTokens + today.totals.outputTokens : 0;
  const maxCost = Math.max(1, ...rows.map((row) => row.cost?.totalUsd ?? 0));

  return <div>
    <PageHeader title="Dashboard" description="The whole instance, ordered by what needs your attention." />
    {dashboard.error && <div className="mb-5"><LoadError message={dashboard.error} onRetry={dashboard.reload} /></div>}
    <div className="mb-5 grid gap-3 lg:grid-cols-3">
      <Rollup title="Needs you" value={String(escalated + pendingPermissions)} detail={`${escalated} escalated · ${pendingPermissions} permission${pendingPermissions === 1 ? '' : 's'}`} tone="text-await" onClick={() => onNavigate('table')} />
      <Rollup title="In flight" value={String(processes.length)} detail={`${processes.filter((process) => process.type === 'attempt').length} attempts · ${processes.filter((process) => process.type === 'chat').length} conversations${hostLoad ? ` · load ${hostLoad.load1.toFixed(1)}/${hostLoad.cores}` : ''}`} tone="text-running" onClick={() => onNavigate('activity')} />
      <Rollup title="Cost today" value={formatCost(today?.cost) ?? '—'} detail={`${compact.format(io)} I/O · ${cache === null ? '—' : `${Math.round(cache * 100)}% cache savings`} · ${formatCost(week?.cost) ?? '—'} 7-day`} onClick={() => onNavigate('stats')} />
    </div>
    <div className="mb-5"><TokenBars workspaces={today?.byWorkspace ?? []} onOpenWorkspace={onOpenWorkspace} /></div>
    <section className={`${card} overflow-x-auto`} aria-labelledby="workspaces-title">
      <div className="flex items-center justify-between gap-3 px-5 py-4"><div><h2 id="workspaces-title" className="text-title font-semibold text-ink">Workspaces</h2><p className="mt-1 text-small text-muted">Cost today leads. Select a column to sort.</p></div></div>
      <table className="w-full min-w-[56rem] border-collapse text-small"><thead className={`${tableHead} border-y border-hairline`}><tr>{([['name', 'Workspace'], ['cost', 'Cost today'], ['needs', 'Needs'], ['flight', 'Flight'], ['io', 'Tokens I/O'], ['cache', 'Cache hit'], ['week', '7-day']] as const).map(([key, label]) => <th key={key} className="px-4 py-3 text-left"><button type="button" className="relative uppercase hover:text-ink" onClick={() => toggleSort(key)}>{label}{sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}<span aria-hidden="true" className={touchOverlay} /></button></th>)}</tr></thead><tbody>{ordered.map((row) => { const hit = cacheHitRate(row); return <tr key={row.workspaceId} className="cursor-pointer border-b border-hairline last:border-0 hover:bg-raised/50" onClick={() => onOpenWorkspace(row.workspaceId)}><td className="px-4 py-3 font-medium text-ink"><button type="button" className="flex items-center text-left" onClick={() => onOpenWorkspace(row.workspaceId)}><span className="mr-2 inline-flex size-5 items-center justify-center rounded-full text-[10px] font-bold text-[#1b1e24]" style={{ backgroundColor: row.color }}>{row.name.trim().charAt(0).toUpperCase()}</span>{row.name}</button></td><td className="min-w-36 px-4 py-3 tabular-nums text-ink"><div className="flex items-center gap-2"><span>{formatCost(row.cost) ?? '—'}</span><span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><span className="block h-full rounded-full bg-accent" style={{ width: `${((row.cost?.totalUsd ?? 0) / maxCost) * 100}%` }} /></span></div></td><td className="px-4 py-3 tabular-nums">{row.needs}</td><td className="px-4 py-3 tabular-nums">{row.flight}</td><td className="px-4 py-3 tabular-nums">{compact.format(row.inputTokens + row.outputTokens)}</td><td className="px-4 py-3 tabular-nums">{hit === null ? '—' : `${Math.round(hit * 100)}%`}</td><td className="px-4 py-3 tabular-nums">{formatCost(row.weekCost) ?? '—'}</td></tr>; })}</tbody><tfoot className="border-t border-hairline bg-raised font-semibold text-ink"><tr><td className="px-4 py-3">Total</td><td className="px-4 py-3 tabular-nums">{formatCost(today?.cost) ?? '—'}</td><td className="px-4 py-3 tabular-nums">{totals.needs}</td><td className="px-4 py-3 tabular-nums">{totals.flight}</td><td className="px-4 py-3 tabular-nums">{compact.format(totals.input + totals.output)}</td><td className="px-4 py-3 tabular-nums">{cache === null ? '—' : `${Math.round(cache * 100)}%`}</td><td className="px-4 py-3 tabular-nums">{formatCost(week?.cost) ?? '—'}</td></tr></tfoot></table>
    </section>
  </div>;
}
