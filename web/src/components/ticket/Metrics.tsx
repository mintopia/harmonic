import type { ReactNode } from 'react';
import { formatCost } from '../../cost';
import type { AttemptSummary, AttemptUsageEvent, Task } from '../../types';
import { changedFilesFromNumstat } from '../../attempt-rail-model';
import { sumCosts } from '../../activity-model';
import { Icon } from '../Icon';
import { Fact } from '../Fact';
import { harnessLabel } from '../../task-detail-model';
import { wallClockRemaining } from '../../wall-clock-model';

export function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function Metrics({
  task,
  runs,
  live,
  now,
}: {
  task: Task;
  runs: AttemptSummary[];
  live: Map<number, AttemptUsageEvent>;
  now: number;
}) {
  const costFor = (r: AttemptSummary) => (r.state === 'running' ? live.get(r.id)?.cost ?? r.cost : r.cost);
  const cost = sumCosts(runs.map(costFor)) ?? task.cost;
  const elapsed = runs.reduce(
    (s, r) =>
      s +
      (r.finishedAt
        ? Math.max(0, r.finishedAt - r.startedAt)
        : r.state === 'running'
          ? Math.max(0, now - r.startedAt)
          : 0),
    0,
  );
  const files = changedFilesFromNumstat(task.stat);
  const add = files.reduce((s, f) => s + f.additions, 0);
  const del = files.reduce((s, f) => s + f.deletions, 0);
  const diff =
    add === 0 && del === 0 ? (
      <span className="text-faint">—</span>
    ) : (
      <>
        {add > 0 && <span className="text-merged">+{add}</span>}
        {del > 0 && <span className="ml-1.5 text-fail">−{del}</span>}
      </>
    );
  const items: Array<[string, ReactNode, boolean?]> = [
    ['Cost', formatCost(cost) ?? '—'],
    ['Elapsed', runs.length ? fmtDur(elapsed) : '—'],
    ['Attempts', `${runs.length}`],
    ['Diff', diff],
  ];
  if (task.wallClockDeadline != null) {
    const remaining = wallClockRemaining(task.wallClockDeadline, now);
    items.push(['Time left', remaining.label, remaining.overdue]);
  }
  return (
    <div className="mb-[18px] flex flex-wrap gap-y-3 tabular-nums">
      {items.map(([k, v, danger]) => (
        <div key={k} className="mr-5 min-w-0 border-r border-hairline pr-5 last:mr-0 last:border-r-0 last:pr-0">
          <div className="mb-[5px] text-[10px] font-bold uppercase tracking-[0.07em] text-faint">{k}</div>
          <div className={`text-[16px] font-bold leading-none ${danger ? 'text-fail' : 'text-ink'}`}>{v}</div>
        </div>
      ))}
    </div>
  );
}

export function DependsOn({ task, allTasks }: { task: Task; allTasks: Task[] }) {
  if (task.dependsOn.length === 0) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-data">
      {task.dependsOn.map((id) => {
        const done = allTasks.find((t) => t.id === id)?.state === 'done';
        return (
          <span key={id} className={`inline-flex items-center gap-0.5 ${done ? 'text-merged' : 'text-muted'}`}>
            {done && <Icon name="check" className="size-3" />}#{id}
          </span>
        );
      })}
    </span>
  );
}

export function Properties({ task, allTasks, workspaceName }: { task: Task; allTasks: Task[]; workspaceName: string | null }) {
  const createdAt = new Date(task.createdAt);
  const created = `${createdAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${createdAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5">
      <Fact label="Priority">{task.priority}</Fact>
      <Fact label="Agent">
        {harnessLabel(task.harness)} <span className="font-data text-muted">{task.model}</span>
      </Fact>
      <Fact label="Workspace">{workspaceName ?? '—'}</Fact>
      <Fact label="Depends on">
        <DependsOn task={task} allTasks={allTasks} />
      </Fact>
      <Fact label="Created">{created}</Fact>
    </dl>
  );
}
