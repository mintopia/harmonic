import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../types';
import type { Epic, EpicLandOutcome, RailSegmentStatus } from '../epic-model';
import {
  FORCE_LAND_CONSEQUENCE,
  railSegments,
  rosterLanes,
} from '../epic-model';
import { boardSections, runningReadout } from '../board-sections-model';
import { deriveEpicFrontier, type FrontierNode } from '../epic-frontier-model';
import { issueRef, taskKey } from '../id-format.js';
import { cardBranch, cardDiffstat } from './cardBranch';
import { api } from '../api';
import { subscribe } from '../ws';
import { toastError, toastLandOutcome } from '../toast';
import { ArmedButton } from './ArmedButton';
import { Icon } from './Icon';
import { TaskIdentity } from './TaskIdentity';
import {
  btnGhost,
  btnPrimary,
  btnQuietDestructive,
  chip,
  displayTitle,
  escalatedChip,
  panel,
  sectionLabel,
  sectionLabelAttn,
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

function OpenButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`${btnGhost} h-8 min-h-11 px-3 py-0 text-small`}
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
  const [liveTools, setLiveTools] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (runId == null) return;
    setLiveTools(undefined); // a new run falls back to task.toolCount until its first tick
    return subscribe((msg) => {
      if (msg.type === 'run_usage' && msg.runId === runId) {
        setLiveTools(Object.values(msg.usage.toolCalls ?? {}).reduce((a, b) => a + b, 0));
      }
    });
  }, [runId]);
  const readout = runningReadout(task, now, liveTools);
  if (!readout) return null;
  return (
    <span className="flex items-center gap-1.5 text-small tabular-nums text-muted">
      <span className="sr-only">Running, </span>
      <span>{readout.elapsed}</span>
      <span aria-hidden="true">·</span>
      <span>
        {readout.tools} {readout.tools === 1 ? 'tool' : 'tools'}
      </span>
    </span>
  );
}

function RunNowButton({ taskId, onChanged }: { taskId: number; onChanged: () => void }) {
  return (
    <button
      type="button"
      className={`${btnPrimary} h-8 min-h-11 px-3 py-0 text-small`}
      onClick={(e) => {
        e.stopPropagation();
        api.runTask(taskId).then(onChanged, toastError);
      }}
    >
      Run now
    </button>
  );
}

function ReviewButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex min-h-11 items-center justify-center rounded-md bg-await px-3 py-2 text-small font-semibold text-on-await transition-colors hover:opacity-90"
      onClick={onOpen}
    >
      Review <span aria-hidden="true">→</span>
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

function TaskCard({ task, onOpen, onChanged }: { task: Task; onOpen: () => void; onChanged: () => void }) {
  const branch = cardBranch(task) ?? (task.isolationMode === 'worktree' ? 'worktree pending' : 'direct');
  const diffstat = cardDiffstat(task);
  const action =
    task.state === 'awaiting-review' ? (
      <ReviewButton onOpen={onOpen} />
    ) : task.escalated || task.drive === 'hitl' ? (
      <OpenButton onOpen={onOpen} />
    ) : task.state === 'ready' ? (
      <RunNowButton taskId={task.id} onChanged={onChanged} />
    ) : null;

  return (
    <article data-task-id={task.id} className={`bold-wash ${task.state} relative flex h-full w-[26.25rem] shrink-0 flex-col overflow-hidden rounded-lg bg-surface shadow-card`}>
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${CARD_ACCENT[task.state]}`} />
      <div className="flex flex-1 flex-col px-4 py-4 pl-5">
        <div className="flex items-center gap-2">
          <Dot task={task} />
          <span className="font-data text-small text-faint">{rowId(task)}</span>
          {task.mapRef != null && <span className={toolChip}>epic #{task.mapRef}</span>}
          {task.drive === 'hitl' && <span className={`${chip} bg-raised text-muted`}>HITL</span>}
          {task.escalated && <span className={escalatedChip}>needs you</span>}
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="mt-3 line-clamp-2 text-left text-title font-semibold text-ink underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent after:absolute after:inset-0 after:content-['']"
        >
          {task.prompt}
        </button>
        <div className="mt-3 space-y-1.5 text-small text-muted">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-faint">ref</span>
            <span className="min-w-0 truncate font-data">{branch}</span>
            {diffstat && (
              <span className="shrink-0 font-data text-faint">
                +{diffstat.added} −{diffstat.removed}
              </span>
            )}
          </div>
          {task.state === 'running' ? (
            <RunningReadoutLine task={task} />
          ) : task.skipReason ? (
            <p className="line-clamp-1 text-faint">{task.skipReason}</p>
          ) : null}
        </div>
        <div className="mt-3 border-t border-hairline pt-3 text-small text-muted">
          <TaskIdentity harness={task.harness} model={task.model} />
        </div>
        {action && <div className="relative z-10 mt-4 flex justify-end">{action}</div>}
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
  sub,
  attn = false,
  children,
}: {
  label: string;
  count?: string;
  sub?: string;
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
        {sub && <span className="ml-auto text-small text-faint">{sub}</span>}
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
    <div className={`bold-wash ${node.state ?? ''} w-[300px] shrink-0 rounded-lg border bg-surface p-3 ${runnable || node.state === 'running' ? 'border-ready-dot' : 'border-hairline'}`}>
      <div className="flex items-start gap-2">
        <span className={`mt-1 size-2 shrink-0 rounded-full ${frontierDot(node.state)}`} role="img" aria-label={node.state ?? 'blocked'} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            disabled={node.taskId == null}
            onClick={() => node.taskId != null && onOpenTask(node.taskId)}
            className={`${touchTargetInline} block min-w-0 text-left disabled:cursor-default`}
          >
            <span className="font-data text-small text-faint">#{node.ref}</span>
            <span className="mt-1 block truncate text-title font-semibold text-ink">{node.title}</span>
          </button>
          {node.dependencies.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {node.dependencies.map((dependency) => (
                <span
                  key={dependency.taskId}
                  className={`rounded bg-raised px-1.5 py-0.5 text-small text-muted ${dependency.satisfied ? 'line-through' : ''}`}
                >
                  {dependency.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {runnable && node.taskId != null && <RunNowButton taskId={node.taskId} onChanged={onChanged} />}
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
  onForceLandEpic,
}: {
  epic: Epic;
  defaultOpen?: boolean;
  tasks: Task[];
  onOpenTask: (taskId: number) => void;
  onChanged: () => void;
  /** Open the full Epic peek (ADR-0026) — the deep view behind the band. */
  onOpenEpic?: (epic: Epic) => void;
  onForceLandEpic: (ref: number) => Promise<EpicLandOutcome>;
}) {
  const attention = epic.members.filter((m) => m.escalated || m.state === 'awaiting-review');
  const [open, setOpen] = useState(defaultOpen || attention.length > 0);
  const segments = railSegments(epic);
  const frontier = useMemo(() => deriveEpicFrontier(epic, tasks), [epic, tasks]);
  const stuck = rosterLanes(epic).stuck;
  const verification = epic.verification.status;
  const blockingNote =
    epic.land.held ?? (stuck.length > 0 ? `${issueRef(stuck[0]!.ref)} blocked` : null);

  return (
    <div className={panel}>
      <div className="flex items-center gap-2.5 px-4 py-3">
        <button
          type="button"
          onClick={() => (onOpenEpic ? onOpenEpic(epic) : setOpen((v) => !v))}
          className={`${touchTargetInline} min-w-0 flex-1 gap-2.5 text-left`}
        >
          <span className="shrink-0 rounded bg-tool-tint px-1.5 py-0.5 text-label font-bold uppercase text-tool">
            {epic.kind}
          </span>
          <span className="shrink-0 font-data text-small text-faint">epic/{epic.ref}</span>
          <span className="truncate text-title font-semibold text-ink">{epic.title}</span>
        </button>
        {attention.length > 0 && (
          <span className={`${chip} shrink-0 bg-await-tint text-await`}>{attention.length} need you</span>
        )}
        {frontier.columns.length > 0 && (
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

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-3.5">
        <span
          className="flex items-center gap-1"
          role="img"
          aria-label={`Merge train — ${epic.foldedCount} of ${epic.memberCount} merged`}
        >
          {segments.map((seg) => (
            <span key={seg.ref} className={`h-1.5 w-5 rounded-full ${SEGMENT_FILL[seg.status]}`} />
          ))}
        </span>
        <span className="text-small text-muted">
          <span className="text-faint">merged</span> {epic.foldedCount}/{epic.memberCount}
        </span>
        {epic.integration.tip && (
          <span className="text-small text-muted">
            <span className="text-faint">tip</span> <span className="font-data">{epic.integration.tip}</span>
          </span>
        )}
        <span className="text-small text-muted">
          <span className="text-faint">verification</span>{' '}
          {verification === 'pass' ? 'passed' : verification === 'fail' ? 'failed' : 'pending'}
        </span>
        <div className="ml-auto flex items-start gap-3">
          {blockingNote && (
            <span className="mt-0.5 rounded bg-fail-tint px-2 py-0.5 text-small text-fail">{blockingNote}</span>
          )}
          <div className="flex flex-col items-end gap-1">
            <ArmedButton
              label="Force-merge"
              armedLabel="Confirm force-merge"
              ariaLabel={`Force-merge Epic #${epic.ref}`}
              className={`${touchTargetInline} ${btnQuietDestructive} text-small`}
              onConfirm={() => {
                onForceLandEpic(epic.ref).then(toastLandOutcome, toastError);
              }}
            />
            <p className="max-w-[220px] text-right text-label text-faint">{FORCE_LAND_CONSEQUENCE}.</p>
          </div>
        </div>
      </div>

      {open && frontier.columns.length > 0 && (
        <div className="overflow-x-auto border-t border-hairline p-4">
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
  onForceLandEpic,
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
        <EpicBand epic={focusEpic} defaultOpen tasks={tasks} onOpenTask={onOpenTask} onChanged={onChanged} onOpenEpic={onOpenEpic} onForceLandEpic={onForceLandEpic} />
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
        <BoardSection label="Needs you" count={String(needsYou.length)} sub="review & escalations" attn>
          <CardStrip tasks={needsYou} onOpen={onOpen} onChanged={onChanged} />
        </BoardSection>
      )}

      {active.length > 0 && (
        <BoardSection label="Active" count={String(active.length)}>
          <CardStrip tasks={active} onOpen={onOpen} onChanged={onChanged} />
        </BoardSection>
      )}

      {activeEpics.length > 0 && (
        <BoardSection label="Epics" count={activeEpics.length === 1 ? '1 epic' : `${activeEpics.length} epics`} sub="members merge as a batch">
          <div className="flex flex-col gap-3">
            {activeEpics.map((epic) => (
              <EpicBand
                key={epic.ref}
                epic={epic}
                tasks={tasks}
                onOpenTask={onOpenTask}
                onChanged={onChanged}
                onOpenEpic={onOpenEpic}
                onForceLandEpic={onForceLandEpic}
              />
            ))}
          </div>
        </BoardSection>
      )}

      {standalone.length > 0 && (
        <BoardSection label="Standalone" count={String(standalone.length)} sub="ready, blocked & draft">
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
