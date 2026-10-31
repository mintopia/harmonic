import { useState, type ReactNode } from 'react';
import { formatCost } from '../../cost';
import type { Attempt, AttemptSummary, AttemptUsageEvent, Task, WorkflowChosen } from '../../types';
import { changedFilesFromNumstat } from '../../attempt-rail-model';
import { sumCosts } from '../../activity-model';
import { codeChip } from '../../ui';
import { Icon } from '../Icon';
import { Fact } from '../Fact';
import { formatModelLabel } from '../TaskIdentity';
import { harnessLabel, pullRequestLink } from '../../task-detail-model';
import { wallClockRemaining } from '../../wall-clock-model';
import { parseWorkflowRef, snapshotNote } from '../../workflow-ref-model';

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
  const remaining = task.wallClockDeadline != null ? wallClockRemaining(task.wallClockDeadline, now) : null;
  if (remaining) items.push(['Time left', remaining.label, remaining.overdue]);
  const pullRequest = pullRequestLink(runs);
  if (pullRequest !== null) {
    items.push([
      'PR / MR',
      <a key="pull-request" href={pullRequest} target="_blank" rel="noreferrer" aria-label="Open the PR / MR (opens in a new tab)" className="text-[13px] font-semibold text-accent underline-offset-2 hover:underline">
        Open
      </a>,
    ]);
  }
  return (
    <div className="mb-[18px] flex flex-wrap gap-y-3 tabular-nums">
      {remaining && (
        <div aria-live="polite" className="sr-only">
          {remaining.overdue ? 'Time limit reached' : ''}
        </div>
      )}
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

function RoutedByNote({ routing }: { routing: NonNullable<Task['routing']> }) {
  return routing.applied ? (
    <span className="text-small text-muted">
      {' '}
      — routed by <code className={`${codeChip} bg-tool-tint text-tool`}>{routing.label}</code>; the classifier was not consulted
    </span>
  ) : (
    <span className="text-small text-muted">
      {' '}
      — <span className="font-medium text-ink">set on this Ticket</span> · label{' '}
      <code className={`${codeChip} bg-raised text-muted line-through`}>{routing.label}</code> not applied
    </span>
  );
}

const CHOSEN_BY: Record<Exclude<WorkflowChosen, 'label' | 'classifier'>, string> = {
  explicit: 'operator choice on this Ticket',
  workspace: 'Workspace default',
  global: 'global default',
};

function WorkflowRefLabel({ task, latestVersion }: { task: Task & { workflowRef: string }; latestVersion: number | null | undefined }) {
  const { name, version } = parseWorkflowRef(task.workflowRef);
  const chosen = task.workflowChosen;
  const note = snapshotNote(task.workflowRef, latestVersion);
  return (
    <>
      <span className="font-semibold">{name}</span>
      {version !== null && <span className="font-data text-muted"> v{version}</span>}
      {chosen === 'label' ? (
        <span className="text-muted">
          {' '}
          — chosen by Workflow Label
          {task.workflowLabel ? (
            <>
              {' '}
              <code className={`${codeChip} bg-accent-tint text-accent`}>{task.workflowLabel}</code>
            </>
          ) : null}
        </span>
      ) : chosen === 'classifier' ? (
        <span className="text-muted">
          {' '}
          — chosen by classifier
          {task.workflowReason ? <span className="text-small text-muted">: {task.workflowReason}</span> : null}
        </span>
      ) : (
        chosen && <span className="text-muted"> — {CHOSEN_BY[chosen]}</span>
      )}
      {note && <div className="mt-0.5 text-small text-muted">{note}</div>}
    </>
  );
}

function priorVerdict(previous: Attempt | undefined): string {
  if (!previous) return 'first Attempt, no prior verdict';
  const why = previous.feedback ?? previous.escalationReason;
  return `Attempt ${previous.number} ${previous.state}${why ? `: ${why}` : ''}`;
}

function ClassifierNote({ task, classifier, attempts }: { task: Task; classifier: NonNullable<Task['classifier']>; attempts: Attempt[] }) {
  const [open, setOpen] = useState(false);
  const latestIndex = attempts.findLastIndex((a) => a.classifier !== null);
  const latest = latestIndex >= 0 ? attempts[latestIndex] : undefined;
  const previous = latestIndex > 0 ? attempts[latestIndex - 1] : undefined;
  if (classifier.kind === 'overridden') {
    return (
      <span className="text-small text-muted">
        {' '}
        — <span className="font-medium text-ink">set on this Ticket</span>; the classifier was not consulted
      </span>
    );
  }
  if (classifier.kind === 'abstained') {
    return (
      <>
        {' '}
        <span className="rounded-full bg-raised px-[7px] py-px text-[10px] font-semibold uppercase tracking-[0.03em] text-muted">abstained</span>
        <span className="text-small text-muted">
          {' '}
          — Route Classifier abstained{classifier.reason ? ` (${classifier.reason})` : ''}; used Workspace default {harnessLabel(task.harness)} {formatModelLabel(task.model)}.
        </span>
      </>
    );
  }
  return (
    <>
      <span className="text-small text-muted"> — routed by classifier</span>{' '}
      {classifier.optionId && <code className={`${codeChip} bg-tool-tint text-tool`}>{classifier.optionId}</code>}{' '}
      {classifier.reason && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-small font-semibold text-accent hover:underline">
          {open ? 'Hide ▴' : 'Why ▾'}
        </button>
      )}
      {open && classifier.reason && (
        <div className="mt-2 flex max-w-[640px] flex-col gap-2 rounded-md bg-raised p-3">
          <div>
            <div className="text-label font-bold uppercase tracking-[0.03em] text-muted">Reason</div>
            <p className="border-l-2 border-tool pl-2 text-small text-ink">{classifier.reason}</p>
          </div>
          {classifier.optionId && (
            <div>
              <div className="text-label font-bold uppercase tracking-[0.03em] text-muted">Chosen</div>
              <p className="text-small text-ink">
                <code className={`${codeChip} bg-tool-tint text-tool`}>{classifier.optionId}</code>
                {classifier.position !== null && classifier.optionCount !== null && ` · option ${classifier.position} of ${classifier.optionCount}`} ·{' '}
                {harnessLabel(task.harness)} <span className="text-muted">{formatModelLabel(task.model)}</span>
              </p>
            </div>
          )}
          {latest && (
            <div>
              <div className="text-label font-bold uppercase tracking-[0.03em] text-muted">Attempt</div>
              <p className="text-small text-ink">{latest.number} · {priorVerdict(previous)}</p>
            </div>
          )}
          {latest?.routing && (
            <div>
              <div className="text-label font-bold uppercase tracking-[0.03em] text-muted">Routing</div>
              <p className="text-small text-muted">
                Routing {formatCost(latest.routing.cost) ?? 'cost unavailable'}
                {latest.routing.models.length > 0 && ` · ${latest.routing.models.map(formatModelLabel).join(', ')}`}
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function AgentFact({ task, attempts = [] }: { task: Task; attempts?: Attempt[] }) {
  const notStarted = task.state === 'escalated' && task.escalationCause?.kind === 'harness_unconfigured';
  return (
    <Fact label="Agent" className={task.routing || task.classifier ? 'col-span-2' : ''}>
        {notStarted ? (
          <span className="text-muted">Not started</span>
        ) : (
          <>
            {harnessLabel(task.harness)} · <span className="font-data text-muted">{formatModelLabel(task.model)}</span>
          </>
        )}
        {task.routing && <RoutedByNote routing={task.routing} />}
        {task.classifier && <ClassifierNote task={task} classifier={task.classifier} attempts={attempts} />}
      </Fact>
  );
}

export function Properties({ task, allTasks, workspaceName, latestVersion, attempts = [] }: { task: Task; allTasks: Task[]; workspaceName: string | null; latestVersion?: number | null; attempts?: Attempt[] }) {
  const createdAt = new Date(task.createdAt);
  const created = `${createdAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${createdAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  return (
    <>
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5">
      <Fact label="Priority">{task.priority}</Fact>
      {!task.execution && <AgentFact task={task} attempts={attempts} />}
      <Fact label="Workspace">{workspaceName ?? '—'}</Fact>
      <Fact label="Depends on">
        <DependsOn task={task} allTasks={allTasks} />
      </Fact>
      <Fact label="Created">{created}</Fact>
      {task.workflowRef && (
        <Fact label="Workflow" className="col-span-2">
          <WorkflowRefLabel task={{ ...task, workflowRef: task.workflowRef }} latestVersion={latestVersion} />
        </Fact>
      )}
      {task.issueWorkflow && <Fact label="Issue Workflow">{task.issueWorkflow}</Fact>}
      {task.origin === 'mirrored' && task.trackerLabel && (
        <Fact label="Tracker">
          {task.url ? (
            <a href={task.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-accent">
              {task.trackerLabel}
              {task.trackerRef ? ` #${task.trackerRef}` : ''}
            </a>
          ) : (
            <>
              {task.trackerLabel}
              {task.trackerRef ? <span className="font-data text-muted"> #{task.trackerRef}</span> : null}
            </>
          )}
        </Fact>
      )}
    </dl>
    </>
  );
}
