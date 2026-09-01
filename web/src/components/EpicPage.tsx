import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { Task, ModelUsage } from '../types';
import type { Epic } from '../epic-model';
import type { Stats } from '../stats-model';
import { epicUsageSummary, tokenBarSegments, tokenBarEmpty, rowCost } from '../epic-summary-model';
import { taskKey } from '../id-format.js';
import { toastError } from '../toast';
import { cardTitle } from '../board-sections-model';
import { card, panel, chip, sectionLabel, stateChip, stateDot } from '../ui';
import { CrumbBar } from './CrumbBar';
import { EpicIntegrationBar } from './EpicIntegrationBar';
import { Markdown } from './Markdown';
import { EmptyState } from './EmptyState';
import { TokenTypeBar, TokenTypeLegend } from './TokenTypeBar';
import { ModelLabel, ProviderChip } from './TaskIdentity';

const sectionCaps = 'text-label font-bold uppercase tracking-[0.1em] text-faint';

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// ─── small shared bits (deliberately re-implemented, not imported, from
// TicketPage's private helpers of the same name — see EpicPage's file header
// in the PR description) ─────────────────────────────────────────────────

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-[3px] text-[10px] font-bold uppercase tracking-[0.07em] text-faint">{label}</dt>
      <dd className="min-w-0 text-[12.5px] text-ink">{children}</dd>
    </div>
  );
}

// Mirrors TicketPage's `descriptionBody`: drop the leading title line (and a
// heading it left behind) so the body doesn't repeat the <h1> above it.
function descriptionBody(prompt: string): string {
  const title = cardTitle(prompt);
  let body = prompt.trimStart();
  if (body.startsWith(title)) body = body.slice(title.length);
  body = body.replace(/^[\s]*#{1,6}[^\n]*\n+/, '').trim();
  return body || prompt;
}

function Description({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const body = descriptionBody(text);
  return (
    <div className="mb-[18px] mt-1">
      <div
        className={`text-[14.5px] leading-relaxed text-ink ${expanded ? '' : 'line-clamp-3'} [&_code]:rounded-[5px] [&_code]:bg-raised [&_code]:px-[5px] [&_code]:py-px [&_code]:text-[12.5px]`}
      >
        <Markdown source={body} className="text-ink" />
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-1.5 text-[12.5px] font-semibold text-accent transition-colors hover:text-ink"
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}

function DependsOn({ ids, onOpenTask }: { ids: number[]; onOpenTask: (taskId: number) => void }) {
  if (ids.length === 0) return <span className="text-faint">None</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-data">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onOpenTask(id)}
          className="text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          {taskKey(id)}
        </button>
      ))}
    </span>
  );
}

function Properties({ task, epic, onOpenTask }: { task: Task; epic: Epic; onOpenTask: (taskId: number) => void }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5">
      <Fact label="Depends on">
        <DependsOn ids={task.dependsOn} onOpenTask={onOpenTask} />
      </Fact>
      <Fact label="Base branch">
        <span className="font-data">{task.baseBranch ?? epic.integration.branch}</span>
      </Fact>
      <Fact label="Created">{fmtTime(task.createdAt)}</Fact>
      <Fact label="Last activity">{fmtTime(task.updatedAt)}</Fact>
    </dl>
  );
}

// ─── usage & statistics ──────────────────────────────────────────────────

function MetricGrid({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 tabular-nums sm:grid-cols-3 lg:grid-cols-4">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <div className="mb-[5px] text-[10px] font-bold uppercase tracking-[0.07em] text-faint">{k}</div>
          <div className="text-[16px] font-bold leading-none text-ink">{v}</div>
        </div>
      ))}
    </div>
  );
}

function UsageCard({ stats, childCount }: { stats: Stats; childCount: number }) {
  const summary = epicUsageSummary(stats, childCount);
  if (!summary.hasActivity) {
    return (
      <section className={`${card} p-5`}>
        <h3 className={`${sectionCaps} mb-1`}>Usage &amp; statistics</h3>
        <p className="mt-3 text-muted">No attempts yet — usage appears once a child Task runs.</p>
      </section>
    );
  }
  const maxTotal = Math.max(...summary.modelBars.map((b) => b.tokens), 1);
  return (
    <section className={`${card} flex flex-col gap-5 p-5`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className={sectionCaps}>Usage &amp; statistics</h3>
        <span className="text-[20px] font-bold leading-none tabular-nums text-ink">{summary.totalCost}</span>
      </div>
      <MetricGrid
        items={[
          ['Attempts', `${summary.attemptCount}`],
          ['Avg cost / task', summary.avgCostPerTask],
          ['Failure rate', summary.failureRatePct],
          ['Duration p50 / p95', `${summary.durationP50} / ${summary.durationP95}`],
          ['Tokens in → out', `${summary.tokensIn.toLocaleString()} → ${summary.tokensOut.toLocaleString()}`],
          ['Cache hit', summary.cacheHitPct],
          ['Subagent share', summary.subagentSharePct],
          ['Tool calls', summary.toolCalls.toLocaleString()],
        ]}
      />
      {summary.modelBars.length > 0 && (
        <div className="border-t border-hairline pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h4 className={sectionCaps}>Token breakdown by model</h4>
            <TokenTypeLegend />
          </div>
          <div className="flex flex-col gap-4">
            {summary.modelBars.map((bar) => {
              const usage = stats.models[bar.key];
              return usage ? <TokenTypeBar key={bar.key} label={bar.key} usage={usage} maxTotal={maxTotal} /> : null;
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// ─── child tasks table ───────────────────────────────────────────────────

// Column tracks mirror TableView's Tasks-list GRID (ADR-0015: same columns, no
// bespoke row shape) plus a trailing Tokens track; keep the two in sync.
const GRID =
  'grid grid-cols-[3.5rem_minmax(0,1fr)_8rem] md:grid-cols-[3.5rem_minmax(0,1fr)_8rem_5rem_5.5rem] lg:grid-cols-[3.5rem_minmax(0,1fr)_8rem_6rem_9rem_5rem_5.5rem_10rem_9rem] items-center gap-x-3 px-4';

function ChildTokenBar({ totals }: { totals: ModelUsage | null | undefined }) {
  const segments = tokenBarSegments(totals);
  if (tokenBarEmpty(segments)) return <span className="text-faint">—</span>;
  const title = segments.map((s) => `${s.label} ${s.value.toLocaleString()}`).join(' · ');
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-raised" title={title} aria-label={title}>
      {segments.map((s) => (
        <span key={s.key} className={`h-full ${s.fill}`} style={{ width: `${s.pct}%` }} />
      ))}
    </div>
  );
}

function ChildRow({
  child,
  totals,
  onOpenTask,
}: {
  child: Task;
  totals: ModelUsage | null | undefined;
  onOpenTask: (taskId: number) => void;
}) {
  return (
    <div
      role="row"
      className={`${GRID} min-h-11 cursor-pointer py-2 transition-colors duration-150 hover:bg-raised/50`}
      onClick={() => onOpenTask(child.id)}
    >
      <div role="cell" className="flex items-center justify-end gap-1.5 whitespace-nowrap tabular-nums text-muted">
        <span aria-hidden="true" className={stateDot(child.state)} />
        <span className="sr-only">Id: </span>
        {taskKey(child.id)}
      </div>
      <div role="cell" className="min-w-0 pr-2">
        <span title={child.summary} className="block truncate text-ink">
          {cardTitle(child.summary)}
        </span>
        <div className="mt-1 lg:hidden">
          <ProviderChip harness={child.harness} compact className="text-small" />
        </div>
      </div>
      <div role="cell">
        <span className={`${stateChip(child.state)} capitalize`}>{child.state}</span>
      </div>
      <div role="cell" className="hidden lg:block">
        <ProviderChip harness={child.harness} />
      </div>
      <div role="cell" className="hidden lg:block">
        <ModelLabel model={child.model} className="text-muted" />
      </div>
      <div role="cell" className={`hidden capitalize md:block ${child.priority === 'high' ? 'font-semibold text-ink' : 'text-muted'}`}>
        {child.priority}
      </div>
      <div role="cell" className="hidden text-right tabular-nums text-muted md:block">
        {rowCost(child.cost)}
      </div>
      <div role="cell" className="hidden text-right tabular-nums text-faint lg:block">
        {fmtTime(child.createdAt)}
      </div>
      <div role="cell" className="hidden lg:block">
        <ChildTokenBar totals={totals} />
      </div>
    </div>
  );
}

function ChildTasksTable({
  tasks,
  totals,
  onOpenTask,
}: {
  tasks: Task[];
  totals: Map<number, ModelUsage | null>;
  onOpenTask: (taskId: number) => void;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className={sectionCaps}>Child tasks</h3>
        <div className="hidden lg:block">
          <TokenTypeLegend />
        </div>
      </div>
      {tasks.length === 0 ? (
        <EmptyState title="No child tasks" className="py-8">
          This Epic has no member Tasks yet.
        </EmptyState>
      ) : (
        <div className={`${panel} overflow-x-auto`} role="table" aria-label="Child tasks">
          <div role="rowgroup">
            <div role="row" className={`${GRID} text-label font-semibold uppercase text-muted py-2.5`}>
              <span role="columnheader" className="text-right">
                #
              </span>
              <span role="columnheader">Prompt</span>
              <span role="columnheader">State</span>
              <span role="columnheader" className="hidden lg:block">
                Harness
              </span>
              <span role="columnheader" className="hidden lg:block">
                Model
              </span>
              <span role="columnheader" className="hidden md:block">
                Priority
              </span>
              <span role="columnheader" className="hidden text-right md:block">
                Cost
              </span>
              <span role="columnheader" className="hidden text-right lg:block">
                Created
              </span>
              <span role="columnheader" className="hidden lg:block">
                Tokens
              </span>
            </div>
          </div>
          <div role="rowgroup" className="divide-y divide-hairline">
            {tasks.map((c) => (
              <ChildRow key={c.id} child={c} totals={totals.get(c.id)} onOpenTask={onOpenTask} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ─── page ────────────────────────────────────────────────────────────────

export function EpicPage({
  task,
  onClose,
  onOpenTask,
}: {
  task: Task;
  onClose: () => void;
  onOpenTask: (taskId: number) => void;
}) {
  const epicRef = task.trackerRef;
  const workspaceId = task.workspaceId;

  const [epic, setEpic] = useState<Epic | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [childTasks, setChildTasks] = useState<Task[] | null>(null);
  const [childTotal, setChildTotal] = useState(0);
  const [childTotals, setChildTotals] = useState<Map<number, ModelUsage | null>>(() => new Map());

  useEffect(() => {
    if (epicRef == null) return;
    let live = true;
    api.epic(workspaceId, epicRef).then((e) => live && setEpic(e), toastError);
    return () => {
      live = false;
    };
  }, [workspaceId, epicRef]);

  useEffect(() => {
    if (epicRef == null) return;
    let live = true;
    api.epicStats(epicRef, workspaceId).then((s) => live && setStats(s), toastError);
    return () => {
      live = false;
    };
  }, [epicRef, workspaceId]);

  useEffect(() => {
    if (epicRef == null) return;
    let live = true;
    api.tasks({ workspaceId, parent: epicRef }).then(({ tasks, total }) => {
      if (!live) return;
      setChildTasks(tasks);
      setChildTotal(total);
      // Bounded by the Epic's own member count; tolerate individual failures
      // (a row simply shows no token bar) rather than failing the whole page.
      Promise.all(
        tasks.map((t) =>
          api.taskUsage(t.id).then(
            (u) => [t.id, u.totals] as const,
            () => [t.id, null] as const,
          ),
        ),
      ).then((pairs) => {
        if (live) setChildTotals(new Map(pairs));
      });
    }, toastError);
    return () => {
      live = false;
    };
  }, [epicRef, workspaceId]);

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const title = epic?.title || task.summary;
  const description = task.prompt ?? task.summary;

  return (
    <div className="flex h-full flex-col">
      <CrumbBar
        crumbs={[
          { node: <span className="font-semibold text-ink">Board</span>, onClick: onClose },
          { node: <span className="font-data text-[12.5px]">epic/{epicRef ?? task.id}</span> },
        ]}
      />

      <div id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto pb-10 focus:outline-none">
        <div className="px-[30px]">
          <div className="flex flex-wrap items-start gap-2.5 pb-1 pt-7">
            <span className={`${chip} shrink-0 bg-accent-tint text-accent`}>Epic</span>
            <h1 className="max-w-[680px] flex-1 text-[26px] font-extrabold leading-[1.15] tracking-[-0.03em]">{cardTitle(title)}</h1>
            <span className="mt-1.5">
              <span className={`${stateChip(task.state)} capitalize`}>{task.state}</span>
            </span>
          </div>

          {epicRef == null ? (
            <EmptyState title="Epic reference unavailable" className="py-16">
              This mirrored Epic has no tracker reference to resolve — its summary can't be loaded.
            </EmptyState>
          ) : (
            <>
              {description && <Description text={description} />}

              <div className={`${panel} mb-6`}>
                {epic ? (
                  <>
                    <EpicIntegrationBar epic={epic} />
                    {epic.integrate.held != null && (
                      <p className="border-t border-hairline px-4 py-2.5 text-small text-await">
                        <span className="font-semibold">Held — </span>
                        {epic.integrate.held}
                      </p>
                    )}
                  </>
                ) : (
                  <div className="px-4 py-3">
                    <div className={sectionLabel}>Integration</div>
                    <p className="mt-2 text-muted">Loading…</p>
                  </div>
                )}
              </div>

              <div className="mb-6">
                <h3 className={`${sectionCaps} mb-3`}>Properties</h3>
                {epic ? (
                  <Properties task={task} epic={epic} onOpenTask={onOpenTask} />
                ) : (
                  <p className="text-muted">Loading…</p>
                )}
              </div>

              <div className="mb-6">{stats ? <UsageCard stats={stats} childCount={childTotal} /> : <p className="text-muted">Loading usage…</p>}</div>

              <div className="mb-8">
                {childTasks ? (
                  <ChildTasksTable tasks={childTasks} totals={childTotals} onOpenTask={onOpenTask} />
                ) : (
                  <p className="text-muted">Loading child tasks…</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
