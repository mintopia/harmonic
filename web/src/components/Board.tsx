import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../types';
import type { Epic, EpicLandOutcome, RailSegmentStatus } from '../epic-model';
import { railSegments } from '../epic-model';
import { boardSections, cardTitle, fmtElapsed } from '../board-sections-model';
import { deriveEpicFrontier, type EpicFrontier, type FrontierNode } from '../epic-frontier-model';
import { issueRef, taskKey } from '../id-format.js';
import { api } from '../api';
import { subscribe } from '../ws';
import { toastError } from '../toast';
import { Icon } from './Icon';
import { formatModelLabel, providerLabel } from './TaskIdentity';
import {
  btnPrimary,
  chip,
  displayTitle,
  panel,
  sectionLabel,
  sectionLabelAttn,
  stateChip,
  stateDot,
  toolChip,
  touchTargetInline,
} from '../ui';

function rowId(task: Task): string {
  return task.origin === 'mirrored' && task.trackerRef != null
    ? issueRef(task.trackerRef)
    : taskKey(task.id);
}

function Dot({ task }: { task: Task }) {
  const pulse = task.state === 'running' ? 'motion-safe:animate-pulse' : '';
  return <span role="img" aria-label={task.state.replaceAll('-', ' ')} className={`${stateDot(task.state)} ${pulse}`} />;
}

const HIT44 = "after:absolute after:left-1/2 after:top-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']";

function OpenButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`relative inline-flex items-center rounded-md border border-edge bg-surface px-[13px] py-[7px] text-small font-medium text-ink transition-colors hover:border-faint ${HIT44}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      Take over
    </button>
  );
}

function RunningReadoutLine({ task }: { task: Task }) {
  const runId = task.runId;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  // Live context-window fill from the run_usage firehose (falls back to the
  // REST snapshot until the first tick); `ctx %` = contextTokens/contextWindow.
  const [liveContext, setLiveContext] = useState<number | null>(null);
  useEffect(() => {
    if (runId == null) return;
    setLiveContext(null);
    return subscribe((msg) => {
      if (msg.type === 'run_usage' && msg.runId === runId) setLiveContext(msg.contextTokens ?? null);
    });
  }, [runId]);
  if (task.runStartedAt === null) return null;
  const elapsed = fmtElapsed(Math.max(0, now - task.runStartedAt));
  const contextTokens = liveContext ?? task.contextTokens;
  const pct =
    task.contextWindow && contextTokens != null ? Math.round((contextTokens / task.contextWindow) * 100) : null;
  return (
    <span className="flex items-center gap-1.5 text-small tabular-nums text-muted">
      <span>{elapsed}</span>
      {pct != null && (
        <>
          <span aria-hidden="true">·</span>
          <span>ctx {pct}%</span>
        </>
      )}
    </span>
  );
}

function RunNowButton({ taskId, onChanged, icon }: { taskId: number; onChanged: () => void; icon?: boolean }) {
  const run = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    api.runTask(taskId).then(onChanged, toastError);
  };
  if (icon) {
    return (
      <button
        type="button"
        aria-label="Run now"
        title="Run now"
        onClick={run}
        className={`${btnPrimary} relative z-10 grid size-8 min-h-11 min-w-11 shrink-0 place-items-center p-0`}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M7 5l12 7-12 7V5z" />
        </svg>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`relative inline-flex items-center rounded-md border border-accent bg-accent-tint px-[13px] py-[7px] text-small font-semibold text-accent transition-colors hover:bg-accent hover:text-on-accent ${HIT44}`}
      onClick={run}
    >
      Run now
    </button>
  );
}

function ReviewButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`relative inline-flex items-center rounded-md border border-await bg-await-tint px-[13px] py-[7px] text-small font-semibold text-await transition-colors hover:bg-await hover:text-on-await ${HIT44}`}
      onClick={onOpen}
    >
      Review →
    </button>
  );
}

const CARD_ACCENT: Record<Task['state'], string> = {
  draft: 'bg-muted',
  blocked: 'bg-blocked',
  ready: 'bg-ready-dot',
  running: 'bg-running-dot',
  'awaiting-review': 'bg-await-dot',
  completed: 'bg-merged-dot',
  failed: 'bg-fail-dot',
  cancelled: 'bg-faint',
};

function WhoLine({ harness, model }: { harness: string; model: string }) {
  return (
    <span className="min-w-0 truncate text-small text-muted">
      {providerLabel(harness)} · {formatModelLabel(model)}
    </span>
  );
}

function TaskCard({ task, onOpen, onChanged }: { task: Task; onOpen: () => void; onChanged: () => void }) {
  const hasReadout = task.runStartedAt != null;
  const action =
    task.drive === 'hitl' ? (
      <OpenButton onOpen={onOpen} />
    ) : task.state === 'awaiting-review' ? (
      <ReviewButton onOpen={onOpen} />
    ) : task.escalated ? (
      <OpenButton onOpen={onOpen} />
    ) : task.state === 'ready' ? (
      <RunNowButton taskId={task.id} onChanged={onChanged} />
    ) : null;
  const showFoot = !!task.branch || hasReadout || !!action;

  return (
    <article data-task-id={task.id} className={`group bold-wash ${task.state} relative flex h-full w-[26.25rem] shrink-0 cursor-pointer flex-col overflow-hidden rounded-lg bg-surface shadow-card transition-shadow duration-150 hover:shadow-float`}>
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${CARD_ACCENT[task.state]}`} />
      <div className="flex flex-1 flex-col px-4 py-4 pl-5">
        <div className="flex items-center gap-2">
          {task.mapRef != null && <span className={toolChip}>epic/{task.mapRef}</span>}
          <Dot task={task} />
          <span className="font-data text-small text-faint">{rowId(task)}</span>
          {task.drive === 'hitl' ? (
            <span className="ml-auto rounded-full bg-running-tint px-2 py-0.5 text-label font-semibold uppercase text-running">
              HITL
            </span>
          ) : task.state === 'awaiting-review' ? (
            <span className={`ml-auto ${stateChip(task.state)}`}>awaiting review</span>
          ) : task.state === 'running' && task.phase && task.phase !== 'terminal' ? (
            <span className="ml-auto rounded-full bg-running-tint px-2 py-0.5 text-label font-semibold uppercase text-running">
              {task.phase === 'landing' ? 'merging' : task.phase}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onOpen}
          title={task.prompt}
          className="mt-3 line-clamp-2 text-left text-title font-semibold text-ink underline-offset-4 group-hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent after:absolute after:inset-0 after:content-['']"
        >
          {cardTitle(task.prompt)}
        </button>
        {(task.state === 'awaiting-review' || task.origin === 'mirrored') && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-small text-muted">
            {task.state === 'awaiting-review' && task.drive !== 'hitl' && (
              <span className="text-merged">✓ verification proceed</span>
            )}
            {task.origin === 'mirrored' && (
              <span className="rounded bg-raised px-1.5 py-0.5 text-label font-medium text-muted">mirrored</span>
            )}
          </div>
        )}
        <div className="mt-2">
          <WhoLine harness={task.harness} model={task.model} />
        </div>
        {showFoot && (
          <div className="mt-auto flex items-center gap-3 pt-4 text-small text-muted">
            {task.branch && (
              <span className="flex min-w-0 items-center gap-1.5">
                <Icon name="branch" className="text-faint" />
                <span className="min-w-0 truncate font-data">{task.branch}</span>
              </span>
            )}
            <span className="ml-auto flex items-center gap-3">
              {hasReadout && <RunningReadoutLine task={task} />}
              {action && <span className="relative z-10">{action}</span>}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}

function CardStrip({
  tasks,
  onOpen,
  onChanged,
}: {
  tasks: Task[];
  onOpen: (task: Task) => void;
  onChanged: () => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(0);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => {
      const visibleCards = Math.max(1, Math.floor(strip.clientWidth / 432));
      setMore(Math.max(0, tasks.length - visibleCards));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [tasks.length]);

  return (
    <div className="relative">
      <div ref={stripRef} data-board-layout="card-strip" className="flex gap-3 overflow-x-auto pb-2 pr-20 [scrollbar-width:thin]">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onOpen={() => onOpen(task)} onChanged={onChanged} />
        ))}
      </div>
      {more > 0 && (
        <>
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-canvas" />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-raised px-2 py-1 text-small font-medium text-muted">
            → {more} more
          </span>
        </>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="chevron-down"
      className={`text-faint transition-transform duration-150 motion-reduce:transition-none ${open ? '' : '-rotate-90'}`}
    />
  );
}

function BoardSection({
  label,
  count,
  attn = false,
  children,
}: {
  label: string;
  count?: string;
  attn?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 first:mt-3">
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h2 className={attn ? sectionLabelAttn : sectionLabel}>{label}</h2>
        {count != null && (
          <span aria-atomic="true" aria-live={attn ? 'polite' : undefined} className="text-small font-semibold text-muted">
            {count}
          </span>
        )}
        <span aria-hidden="true" className="ml-auto" />
      </div>
      {children}
    </section>
  );
}

const SEGMENT_FILL: Record<RailSegmentStatus, string> = {
  landed: 'bg-merged-dot',
  running: 'bg-running-dot',
  healing: 'bg-running-dot motion-safe:animate-pulse',
  waiting: 'bg-raised',
  blocking: 'bg-raised',
};

function frontierDot(state: FrontierNode['state']): string {
  switch (state) {
    case null:
    case 'draft':
    case 'completed':
      return 'bg-edge';
    case 'running':
      return 'bg-running-dot motion-safe:animate-pulse';
    case 'ready':
      return 'bg-ready-dot';
    case 'awaiting-review':
      return 'bg-await-dot';
    case 'blocked':
      return 'bg-blocked';
    case 'failed':
      return 'bg-fail-dot';
    case 'cancelled':
      return 'bg-faint';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function FrontierNodeCard({
  node,
  onOpenTask,
  onChanged,
}: {
  node: FrontierNode;
  onOpenTask: (taskId: number) => void;
  onChanged: () => void;
}) {
  const runnable = node.runnable && node.taskId != null;
  return (
    <div className={`bold-wash ${node.state ?? ''} relative w-[300px] shrink-0 rounded-lg border bg-surface p-2.5 ${runnable || node.state === 'running' ? 'border-ready-dot' : 'border-hairline'}`}>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${frontierDot(node.state)}`} />
        <span className="font-data text-small text-faint">#{node.ref}</span>
        <span className="sr-only">{node.state ?? 'blocked'}</span>
      </div>
      <button
        type="button"
        disabled={node.taskId == null}
        onClick={() => node.taskId != null && onOpenTask(node.taskId)}
        title={node.title}
        className="mt-1 block w-full min-w-0 truncate pr-7 text-left text-small font-medium text-ink underline-offset-4 hover:underline disabled:cursor-default disabled:no-underline"
      >
        {node.title}
      </button>
      {node.dependencies.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {node.dependencies.map((dependency) => (
            <span
              key={dependency.taskId}
              className={`rounded bg-raised px-1.5 py-0.5 text-label text-muted ${dependency.satisfied ? 'line-through' : ''}`}
            >
              {dependency.label}
            </span>
          ))}
        </div>
      )}
      {runnable && node.taskId != null && (
        <button
          type="button"
          aria-label="Run now"
          title="Run now"
          onClick={(e) => {
            e.stopPropagation();
            api.runTask(node.taskId!).then(onChanged, toastError);
          }}
          className="absolute right-2.5 top-2.5 grid size-[23px] place-items-center rounded-md border border-ready-dot/40 bg-ready-tint text-ready transition-colors duration-150 hover:bg-ready-dot hover:text-white after:absolute after:-inset-2.5 after:content-['']"
        >
          <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 5l12 7-12 7V5z" />
          </svg>
        </button>
      )}
    </div>
  );
}

function FrontierColumns({
  frontier,
  onOpenTask,
  onChanged,
}: {
  frontier: EpicFrontier;
  onOpenTask: (taskId: number) => void;
  onChanged: () => void;
}) {
  return (
    <div className="overflow-x-auto p-4">
      <div className="flex min-w-max gap-4">
        {frontier.columns.map((column) => (
          <section key={column.label} className="w-[300px] shrink-0">
            <h3 className="mb-2 text-label font-bold uppercase text-faint">{column.label}</h3>
            <div className="flex flex-col gap-2">
              {column.nodes.map((node) => (
                <FrontierNodeCard key={node.ref} node={node} onOpenTask={onOpenTask} onChanged={onChanged} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function EpicBand({
  epic,
  defaultOpen = false,
  tasks,
  onOpenTask,
  onChanged,
  onOpenEpic,
}: {
  epic: Epic;
  defaultOpen?: boolean;
  tasks: Task[];
  onOpenTask: (taskId: number) => void;
  onChanged: () => void;
  /** Open the full Epic peek (ADR-0026) — the deep view behind the band, where
   * the merge/verification detail and Force-merge live. */
  onOpenEpic?: (epic: Epic) => void;
}) {
  const attention = epic.members.filter((m) => m.escalated || m.state === 'awaiting-review');
  const segments = railSegments(epic);
  const frontier = useMemo(() => deriveEpicFrontier(epic, tasks), [epic, tasks]);
  const hasDag = frontier.columns.length > 0;
  // The Board shows the frontier-DAG inline by default (the Paper mockup); a
  // fully-merged epic has no visible members (hasDag=false) and stays collapsed.
  const [open, setOpen] = useState(defaultOpen || attention.length > 0 || hasDag);

  return (
    <div className={panel}>
      <div className="flex items-center gap-2.5 px-4 py-3">
        <button
          type="button"
          aria-expanded={hasDag ? open : undefined}
          onClick={() => (hasDag ? setOpen((v) => !v) : onOpenEpic?.(epic))}
          className={`${touchTargetInline} min-w-0 flex-1 gap-2.5 text-left`}
        >
          <span className="shrink-0 rounded bg-tool-tint px-1.5 py-0.5 text-label font-bold text-tool">
            {epic.kind === 'map' ? 'Map' : 'Epic'}
          </span>
          <span className="shrink-0 font-data text-small text-faint">epic/{epic.ref}</span>
          <span className="truncate text-title font-semibold text-ink">{epic.title}</span>
        </button>
        {attention.length > 0 && (
          <span className={`${chip} shrink-0 bg-await-tint text-await`}>{attention.length} need you</span>
        )}
        <span
          className="flex shrink-0 items-center gap-1"
          role="img"
          aria-label={`Merge train — ${epic.foldedCount} of ${epic.memberCount} merged`}
        >
          {segments.map((seg) => (
            <span key={seg.ref} className={`h-1.5 w-4 rounded-full ${SEGMENT_FILL[seg.status]}`} />
          ))}
        </span>
        {hasDag && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `Collapse Epic #${epic.ref} members` : `Expand Epic #${epic.ref} members`}
            onClick={() => setOpen((v) => !v)}
            className={`${touchTargetInline} shrink-0`}
          >
            <Chevron open={open} />
          </button>
        )}
      </div>

      {open && hasDag && (
        <div className="border-t border-hairline">
          <FrontierColumns frontier={frontier} onOpenTask={onOpenTask} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

function FirstRunBoard({ onNewTask }: { onNewTask: () => void }) {
  const steps = [
    { title: 'Create a task', body: 'Describe the work and point it at a repo on this machine.' },
    { title: 'Run it', body: 'Press Run now, or turn the auto-runner on to start ready tasks for you.' },
    { title: 'Review the result', body: "The agent's steps stream live; read the diff and accept to merge." },
  ];
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <h1 className={displayTitle}>Run your first agent</h1>
      <p className="mx-auto mt-2 text-muted">
        Harmonic queues a task, runs an agent on it unattended, and holds the result at a review gate until you
        accept the merge.
      </p>
      <ol className="mx-auto mt-7 flex max-w-sm flex-col gap-3.5 text-left">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-raised text-label font-bold text-muted">
              {i + 1}
            </span>
            <span>
              <span className="font-semibold text-ink">{s.title}</span> <span className="text-muted">— {s.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <button className={`${btnPrimary} mt-8`} onClick={onNewTask}>
        Create your first task
      </button>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse motion-reduce:animate-none">
      {[2, 3].map((rows, i) => (
        <section key={i} className="mt-6 first:mt-3">
          <div className="mb-2 h-3 w-24 rounded bg-raised" />
          <div className="rounded-lg bg-surface shadow-card">
            {Array.from({ length: rows }, (_, j) => (
              <div key={j} className="flex items-center gap-3 px-4 py-3.5">
                <span className="size-2 rounded-full bg-raised" />
                <span className="h-3 flex-1 rounded bg-raised" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function AllClear() {
  return (
    <div className="mx-auto mt-16 max-w-sm text-center">
      <h1 className={displayTitle}>All clear</h1>
      <p className="mt-2 text-muted">Nothing needs you right now. Queued and merged work shows here as it moves.</p>
    </div>
  );
}

export function Board({
  tasks,
  loading,
  epics,
  onOpen,
  onOpenTask,
  onChanged,
  onNewTask,
  onOpenEpic,
  focusEpic = null,
  onClearFocus,
}: {
  tasks: Task[];
  loading: boolean;
  epics: Epic[];
  onOpen: (task: Task) => void;
  onOpenTask: (taskId: number) => void;
  onChanged: () => void;
  onNewTask: () => void;
  onOpenEpic?: (epic: Epic) => void;
  onForceLandEpic: (epicRef: number) => Promise<EpicLandOutcome>;
  focusEpic?: Epic | null;
  onClearFocus?: () => void;
}) {
  const sections = useMemo(() => boardSections(tasks, epics), [tasks, epics]);

  if (loading) return <BoardSkeleton />;

  if (focusEpic) {
    return (
      <div>
        <div className="mb-3 flex items-center justify-between px-1">
          <h2 className={sectionLabel}>Focused Epic</h2>
          {onClearFocus && (
            <button type="button" className={`${touchTargetInline} text-small font-medium text-muted hover:text-ink`} onClick={onClearFocus}>
              Clear focus
            </button>
          )}
        </div>
        <EpicBand epic={focusEpic} defaultOpen tasks={tasks} onOpenTask={onOpenTask} onChanged={onChanged} onOpenEpic={onOpenEpic} />
      </div>
    );
  }

  if (tasks.length === 0 && epics.length === 0) return <FirstRunBoard onNewTask={onNewTask} />;

  const { needsYou, active, epics: activeEpics, standalone } = sections;
  const nothingActive =
    needsYou.length === 0 && active.length === 0 && activeEpics.length === 0 && standalone.length === 0;
  if (nothingActive) return <AllClear />;

  return (
    <div>
      <h1 className="sr-only">Board</h1>

      {needsYou.length > 0 && (
        <BoardSection label="Needs you" count={String(needsYou.length)} attn>
          <CardStrip tasks={needsYou} onOpen={onOpen} onChanged={onChanged} />
        </BoardSection>
      )}

      {active.length > 0 && (
        <BoardSection label="Active" count={String(active.length)}>
          <CardStrip tasks={active} onOpen={onOpen} onChanged={onChanged} />
        </BoardSection>
      )}

      {activeEpics.length > 0 && (
        <BoardSection label="Epics" count={activeEpics.length === 1 ? '1 active' : `${activeEpics.length} active`}>
          <div className="flex flex-col gap-3">
            {activeEpics.map((epic) => (
              <EpicBand
                key={epic.ref}
                epic={epic}
                tasks={tasks}
                onOpenTask={onOpenTask}
                onChanged={onChanged}
                onOpenEpic={onOpenEpic}
              />
            ))}
          </div>
        </BoardSection>
      )}

      {standalone.length > 0 && (
        <BoardSection label="Standalone" count={String(standalone.length)}>
          <div data-board-layout="loose-cards" className="flex flex-wrap gap-3">
            {standalone.map((task) => (
              <TaskCard key={task.id} task={task} onOpen={() => onOpen(task)} onChanged={onChanged} />
            ))}
          </div>
        </BoardSection>
      )}
    </div>
  );
}
