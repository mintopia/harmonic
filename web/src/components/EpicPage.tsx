import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { subscribe } from '../ws';
import { useLiveEffect } from '../useLiveEffect';
import { useScrollToPanel } from '../useScrollToPanel';
import type { DiffFile, Task, ModelUsage } from '../types';
import type { Epic, EpicStage, IntegrationStepState } from '../epic-model';
import { epicLifecycleSteps } from '../epic-model';
import type { Stats } from '../stats-model';
import { epicUsageSummary, tokenBarSegments, tokenBarEmpty, rowCost } from '../epic-summary-model';
import { formatCost } from '../cost';
import { issueRef, ticketRowId } from '../id-format.js';
import { toastError } from '../toast';
import { cardTitle } from '../board-sections-model';
import {
  card,
  panel,
  chip,
  stateChip,
  stateDot,
  railSectionHead,
  railSectionCount,
  railNavButton,
  railNavSelected,
  railNavIdle,
  PHASE_NODE_STYLES,
  type PhaseNodeVisual,
} from '../ui';
import { splitPathTail } from '../path';
import { NO_SELECTION, type RailSelection } from '../router-model';
import { CrumbBar } from './CrumbBar';
import { DiffViewer } from './DiffViewer';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { TokenTypeBar, TokenTypeLegend } from './TokenTypeBar';
import { ModelLabel, ProviderChip } from './TaskIdentity';
import { ChangedFilesNav, changedFileKind } from './ticket/ChangedFilesNav';

const sectionCaps = 'text-label font-bold uppercase tracking-[0.1em] text-faint';

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function fmtRelative(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-[3px] text-[10px] font-bold uppercase tracking-[0.07em] text-faint">{label}</dt>
      <dd className="min-w-0 text-[12.5px] text-ink">{children}</dd>
    </div>
  );
}

function Description({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mb-[18px] mt-1">
      <div
        className={`text-[14.5px] leading-relaxed text-ink ${expanded ? '' : 'line-clamp-3'} [&_code]:rounded-[5px] [&_code]:bg-raised [&_code]:px-[5px] [&_code]:py-px [&_code]:text-[12.5px]`}
      >
        <Markdown source={text} className="text-ink" />
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

function DependsOn({ refs }: { refs: number[] }) {
  if (refs.length === 0) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-data">
      {refs.map((ref) => (
        <span key={ref} className="text-muted">
          {issueRef(ref)}
        </span>
      ))}
    </span>
  );
}

/** The rail's Epic facts: the header's Properties card moved beside the content,
 * plus the two roll-ups an operator scans for first (Tasks done, Total cost). */
function EpicMeta({ epic, stats }: { epic: Epic | null; stats: Stats | null }) {
  const summary = epic && stats ? epicUsageSummary(stats, epic.memberCount) : null;
  return (
    <section className="border-b border-hairline px-3.5 py-3.5">
      <div className={railSectionHead}>Epic</div>
      {epic ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Fact label="Tasks done">
            <span className="tabular-nums">
              {epic.foldedCount} / {epic.memberCount}
            </span>
          </Fact>
          <Fact label="Total cost">
            <span className="tabular-nums">{summary?.hasActivity ? summary.totalCost : '—'}</span>
          </Fact>
          <Fact label="Base branch">
            <span className="font-data">{epic.baseBranch ?? epic.integration.branch}</span>
          </Fact>
          <Fact label="Depends on">
            <DependsOn refs={epic.dependsOn} />
          </Fact>
          <Fact label="Created">{fmtDate(epic.createdAt)}</Fact>
          <Fact label="Last activity">{epic.updatedAt != null ? fmtRelative(epic.updatedAt) : '—'}</Fact>
        </dl>
      ) : (
        <p className="text-small text-muted">Loading…</p>
      )}
    </section>
  );
}

function TasksNav({ count, selected, onSelect }: { count: number | null; selected: boolean; onSelect: () => void }) {
  return (
    <section className="border-b border-hairline px-3.5 py-3.5">
      <button type="button" aria-pressed={selected} onClick={onSelect} className={`${railNavButton} ${selected ? railNavSelected : railNavIdle}`}>
        <Icon name="table" className="size-3.5 shrink-0 text-muted" />
        <span className="text-data font-semibold text-ink">Tasks</span>
        {count != null && <span className={railSectionCount}>{count}</span>}
      </button>
    </section>
  );
}


interface Metric {
  label: string;
  value: ReactNode;
  dot?: string;
}

function MetricGrid({ items }: { items: Metric[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 tabular-nums sm:grid-cols-3 lg:grid-cols-5">
      {items.map((m) => (
        <div key={m.label} className="min-w-0">
          <div className="mb-[5px] flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.07em] text-faint">
            {m.dot && <span aria-hidden="true" className={`size-2 rounded-[2px] ${m.dot}`} />}
            {m.label}
          </div>
          <div className="text-[16px] font-bold leading-none text-ink">{m.value}</div>
        </div>
      ))}
    </div>
  );
}

function modelCostTag(cost: Stats['cost'], key: string): string | undefined {
  const usd = cost?.byModel[key];
  return usd == null ? undefined : (formatCost({ totalUsd: usd, byModel: {}, incomplete: false }) ?? undefined);
}

function UsageCard({ stats, epic }: { stats: Stats; epic: Epic }) {
  const summary = epicUsageSummary(stats, epic.memberCount);
  if (!summary.hasActivity) {
    return (
      <section className={`${card} p-5`}>
        <p className="text-muted">No attempts yet — usage appears once a child Task runs.</p>
      </section>
    );
  }
  const maxTotal = Math.max(...summary.modelBars.map((b) => b.tokens), 1);
  return (
    <section className={`${card} flex flex-col gap-5 p-5`}>
      <div className="flex items-baseline gap-2.5">
        <span className="text-[28px] font-extrabold leading-none tabular-nums text-ink">{summary.totalCost}</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.07em] text-faint">
          Total cost{summary.costIncomplete ? ' · ≥ floor' : ''}
        </span>
      </div>
      <MetricGrid
        items={[
          { label: 'Tasks done', value: `${epic.foldedCount} / ${epic.memberCount}` },
          { label: 'Avg cost / task', value: summary.avgCostPerTask },
          { label: 'Attempts', value: `${summary.attemptCount}` },
          { label: 'Failure rate', value: summary.failureRatePct },
          { label: 'Median duration', value: summary.durationP50 },
          { label: 'Tokens in', value: summary.tokensIn.toLocaleString(), dot: 'bg-token-input' },
          { label: 'Tokens out', value: summary.tokensOut.toLocaleString(), dot: 'bg-token-output' },
          { label: 'Cache hit', value: summary.cacheHitPct },
          { label: 'Subagent share', value: summary.subagentSharePct },
          { label: 'Tool calls', value: summary.toolCalls.toLocaleString() },
        ]}
      />
      {summary.modelBars.length > 0 && (
        <div className="border-t border-hairline pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h4 className={sectionCaps}>Tokens &amp; cost per model</h4>
            <TokenTypeLegend />
          </div>
          <div className="flex flex-col gap-4">
            {summary.modelBars.map((bar) => {
              const usage = stats.models[bar.key];
              return usage ? (
                <TokenTypeBar key={bar.key} label={bar.key} usage={usage} maxTotal={maxTotal} trailing={modelCostTag(stats.cost, bar.key)} />
              ) : null;
            })}
          </div>
        </div>
      )}
    </section>
  );
}


/** The whole-Epic diff (ADR-0018): what `epic/<ref>` changes over base, fetched
 * once — unlike the live Attempt ChangesPane on TicketPage, an Epic's diff is
 * static, so it never polls. A rail-selected file shows alone under its own
 * title; the Changed-files header shows every file. */
function ChangesPanel({
  files,
  failed,
  selectedFile,
  epic,
}: {
  files: DiffFile[] | null;
  failed: boolean;
  selectedFile: string;
  epic: Epic | null;
}) {
  if (selectedFile) {
    const file = (files ?? []).find((f) => f.path === selectedFile);
    return (
      <div>
        <div className="mx-0.5 mb-3 mt-4">
          <h2 className="flex items-center gap-2 text-[16.5px] font-bold leading-tight tracking-[-0.01em] text-ink">
            {file && (
              <span
                className={`grid size-[18px] shrink-0 place-items-center rounded-[4px] font-data text-[10px] font-bold ${
                  changedFileKind(file) === 'A' ? 'bg-merged-tint text-merged' : changedFileKind(file) === 'D' ? 'bg-fail-tint text-fail' : 'bg-running-tint text-running'
                }`}
              >
                {changedFileKind(file)}
              </span>
            )}
            {splitPathTail(selectedFile).tail}
          </h2>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 font-data text-[12px] text-faint">
            {file && (
              <>
                <span className="tabular-nums">
                  <span className="text-merged">+{file.additions}</span> <span className="text-fail">−{file.deletions}</span>
                </span>
                <span aria-hidden className="text-edge">·</span>
              </>
            )}
            <span className="min-w-0 truncate">{selectedFile}</span>
            {epic && (
              <>
                <span aria-hidden className="text-edge">·</span>
                <span>
                  epic diff · {epic.baseBranch ?? epic.integration.branch}…{epic.integration.branch}
                </span>
              </>
            )}
          </div>
        </div>
        {files === null && !failed ? (
          <p className="text-muted">Loading diff…</p>
        ) : !file ? (
          <p className="text-muted">No changed-file content available for {selectedFile}.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-hairline shadow-card">
            <DiffViewer file={file} headerless />
          </div>
        )}
      </div>
    );
  }
  return (
    <section className="mt-6">
      <div className={`${sectionCaps} mb-3`}>Changes</div>
      {failed ? (
        <div className={`${card} p-5 text-muted`}>Couldn&rsquo;t load changes.</div>
      ) : files === null ? (
        <div className={`${card} p-5 text-muted`}>Loading changes…</div>
      ) : files.length === 0 ? (
        <EmptyState title="No changes" className="py-8">
          No changes on this Epic yet.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {files.map((f) => (
            <DiffViewer key={f.path} file={f} />
          ))}
        </div>
      )}
    </section>
  );
}

const GRID =
  'grid grid-cols-[7.5rem_minmax(0,1fr)_8rem] md:grid-cols-[7.5rem_minmax(0,1fr)_8rem_5rem_5.5rem] lg:grid-cols-[7.5rem_minmax(0,1fr)_8rem_6rem_9rem_5rem_5.5rem_8rem_8rem] items-center gap-x-3 px-4';

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
        {ticketRowId(child.id, child.trackerRef)}
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


const PHASE_WORD: Record<EpicStage['key'], string> = {
  build: 'building',
  verify: 'verifying',
  merge: 'merging',
  check: 'checking',
  retire: 'retiring',
};

function EpicLifecycleChip({ epic }: { epic: Epic }) {
  const steps = epicLifecycleSteps(epic);
  const held = steps.find((s) => s.state === 'held');
  const current = steps.find((s) => s.state === 'current');
  const [label, tint] = held
    ? ['held', 'bg-await-tint text-await']
    : !current
      ? ['finished', 'bg-merged-tint text-merged']
      : [PHASE_WORD[current.key], current.key === 'merge' ? 'bg-merged-tint text-merged' : 'bg-running-tint text-running'];
  return <span className={`${chip} ${tint}`}>{label}</span>;
}

const STEP_NODE: Record<IntegrationStepState, PhaseNodeVisual> = {
  done: 'done',
  current: 'current',
  held: 'awaiting',
  pending: 'pending',
};
const STEP_LABEL_TONE: Record<IntegrationStepState, string> = {
  done: 'text-muted',
  current: 'text-accent',
  held: 'text-await',
  pending: 'text-faint',
};

function EpicStepper({ epic }: { epic: Epic }) {
  const steps = epicLifecycleSteps(epic);
  const current = steps.find((s) => s.state === 'current' || s.state === 'held');
  return (
    <ol
      className={`${card} flex items-start px-[22px] py-5`}
      aria-label={`Epic lifecycle — ${current ? current.label : 'complete'}${epic.integrate.held != null ? ' (escalated)' : ''}`}
    >
      {steps.map((step, i) => {
        const leftDone = i > 0 && steps[i - 1]!.state === 'done' && !steps[i - 1]!.disabled;
        const rightDone = step.state === 'done' && !step.disabled;
        return (
          <li
            key={step.key}
            aria-current={step.state === 'current' || step.state === 'held' ? 'step' : undefined}
            className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center"
          >
            <div className="flex w-full items-center">
              <span className={`h-0.5 flex-1 rounded ${i === 0 ? 'invisible' : leftDone ? 'bg-merged' : 'bg-edge'}`} />
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold tabular-nums ${PHASE_NODE_STYLES[step.disabled ? 'pending' : STEP_NODE[step.state]]}`}
              >
                {!step.disabled && step.state === 'done' ? <Icon name="check" className="size-3.5" /> : i + 1}
              </span>
              <span className={`h-0.5 flex-1 rounded ${i === steps.length - 1 ? 'invisible' : rightDone ? 'bg-merged' : 'bg-edge'}`} />
            </div>
            <span className={`text-[12px] font-semibold leading-tight ${step.disabled ? 'text-faint' : STEP_LABEL_TONE[step.state]}`}>{step.label}</span>
            <span className="max-w-[10rem] truncate text-[10.5px] leading-tight text-faint" title={step.sublabel}>
              {step.sublabel}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function EpicPage({
  epicRef,
  workspaceId,
  onClose,
  onOpenTask,
  selection,
  onSelect,
}: {
  epicRef: number;
  workspaceId: number;
  onClose: () => void;
  onOpenTask: (taskId: number) => void;
  /** The rail selection — owned by the route so a refresh restores the panel.
   * Only `changes` and `file` mean anything here; anything else is the overview. */
  selection: RailSelection;
  onSelect: (selection: RailSelection) => void;
}) {
  const [epic, setEpic] = useState<Epic | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [childTasks, setChildTasks] = useState<Task[] | null>(null);
  const [childTotals, setChildTotals] = useState<Map<number, ModelUsage | null>>(() => new Map());
  const [diffFiles, setDiffFiles] = useState<DiffFile[] | null>(null);
  const [diffFailed, setDiffFailed] = useState(false);
  // Bumped by the WS subscription below to re-run the epic/stats/children fetches
  // when a member Task changes, so the page updates live without a manual refresh.
  const [refreshKey, setRefreshKey] = useState(0);

  useLiveEffect((live) => {
    api.epic(workspaceId, epicRef).then((e) => live() && setEpic(e), toastError);
  }, [workspaceId, epicRef, refreshKey]);

  useLiveEffect((live) => {
    api.epicStats(epicRef, workspaceId).then((s) => live() && setStats(s), toastError);
  }, [epicRef, workspaceId, refreshKey]);

  const childIdsRef = useRef<Set<number>>(new Set());
  useLiveEffect((live) => {
    api.tasks({ workspaceId, parent: epicRef }).then(({ tasks }) => {
      if (!live()) return;
      setChildTasks(tasks);
      childIdsRef.current = new Set(tasks.map((t) => t.id));
      Promise.all(
        tasks.map((t) =>
          api.taskUsage(t.id).then(
            (u) => [t.id, u.totals] as const,
            () => [t.id, null] as const,
          ),
        ),
      ).then((pairs) => {
        if (live()) setChildTotals(new Map(pairs));
      });
    }, toastError);
  }, [epicRef, workspaceId, refreshKey]);

  useEffect(() => {
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'task_changed' && childIdsRef.current.has(msg.task.id)) setRefreshKey((k) => k + 1);
      else if (msg.type === 'task_removed' && childIdsRef.current.has(msg.id)) setRefreshKey((k) => k + 1);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let live = true;
    setDiffFiles(null);
    setDiffFailed(false);
    api.epicDiffFiles(workspaceId, epicRef).then(
      ({ files }) => live && setDiffFiles(files),
      () => live && setDiffFailed(true),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, epicRef]);

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const title = epic?.title || `Epic ${epicRef}`;
  const selectedFile = selection.kind === 'file' ? selection.path : null;
  const showChanges = selection.kind === 'file' || selection.kind === 'changes';
  // A rail pick (or a deep link to a panel) lands on the content panel itself;
  // a fresh open with nothing picked starts at the Epic header.
  const scrollRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useScrollToPanel(scrollRef, contentRef, selection.kind !== 'none', selection);

  return (
    <div className="flex h-full flex-col">
      <CrumbBar
        crumbs={[
          { node: <span className="font-semibold text-ink">Board</span>, onClick: onClose },
          { node: <span className="font-data text-[12.5px]">epic/{epicRef}</span> },
        ]}
      />

      {/* two-pane shell, mirroring TicketPage: content left, navigation rail right;
          stacks under the rail breakpoint. */}
      <div className="flex min-h-0 flex-1 overflow-hidden max-rail:flex-col max-rail:overflow-visible">
        <main ref={scrollRef} id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto pb-10 focus:outline-none max-rail:overflow-visible">
          <div className="px-[30px]">
            <div className="flex flex-wrap items-start gap-2.5 pb-1 pt-7">
              <span className={`${chip} shrink-0 bg-accent-tint text-accent`}>Epic</span>
              <h1 className="max-w-[680px] flex-1 text-[26px] font-extrabold leading-[1.15] tracking-[-0.03em]">{cardTitle(title)}</h1>
              {epic && <span className="mt-1.5"><EpicLifecycleChip epic={epic} /></span>}
            </div>

            {epic?.description && <Description text={epic.description} />}

            <div ref={contentRef} className="min-w-0 border-t border-hairline">
              {showChanges ? (
                <ChangesPanel files={diffFiles} failed={diffFailed} selectedFile={selectedFile ?? ''} epic={epic} />
              ) : (
                <>
                  <section className="mb-6 mt-6 min-w-0">
                    <div className={`${sectionCaps} mb-3`}>Integration progress</div>
                    {epic ? (
                      <EpicStepper epic={epic} />
                    ) : (
                      <div className={`${card} px-[22px] py-5 text-muted`}>Loading…</div>
                    )}
                  </section>

                  <div className="mb-6">
                    <div className={`${sectionCaps} mb-3`}>Usage &amp; statistics</div>
                    {stats && epic ? (
                      <UsageCard stats={stats} epic={epic} />
                    ) : (
                      <div className={`${card} p-5 text-muted`}>Loading usage…</div>
                    )}
                  </div>

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
        </main>

        <aside
          aria-label="Epic facts, tasks and changed files"
          className="flex w-[326px] shrink-0 flex-col border-l border-hairline bg-surface max-rail:w-auto max-rail:border-l-0 max-rail:border-t"
        >
          <div className="min-h-0 flex-1 overflow-y-auto max-rail:overflow-visible">
            <EpicMeta epic={epic} stats={stats} />
            <TasksNav
              count={childTasks?.length ?? epic?.memberCount ?? null}
              selected={!showChanges}
              onSelect={() => onSelect(NO_SELECTION)}
            />
            <section className="px-3.5 py-3.5" aria-label="Changed files">
              <ChangedFilesNav
                files={diffFiles ?? []}
                selectedFile={selectedFile}
                onSelectFile={(path) => onSelect({ kind: 'file', path })}
                onSelectChanges={() => onSelect({ kind: 'changes' })}
                emptyCopy={diffFailed ? 'Couldn’t load changes.' : diffFiles === null ? 'Loading changes…' : 'No changed files.'}
              />
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
