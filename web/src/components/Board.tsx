import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskState } from '../types';
import type {
  Epic,
  EpicIntegrateOutcome,
  EpicMember,
  IntegrateOutcomeBanner,
  IntegrateOutcomeBannerTone,
  IntegrationStepState,
  MemberPipStatus,
  RailSegmentStatus,
} from '../epic-model';
import {
  closedMembers,
  FORCE_INTEGRATE_CONSEQUENCE,
  integrateOutcomeBanner,
  integrationSteps,
  isEpicIntegrating,
  memberPipStatus,
  railSegments,
  statusLineParts,
} from '../epic-model';
import {
  boardSections,
  cardTitle,
  epicMemberSections,
  epicPendingColumns,
  fmtElapsed,
  type AttentionEntry,
  type BlockerColumn,
  type PendingItem,
} from '../board-sections-model';
import { issueRef, taskKey } from '../id-format.js';
import { api } from '../api';
import { subscribe } from '../ws';
import { toastError } from '../toast';
import { Icon } from './Icon';
import { ArmedButton } from './ArmedButton';
import { formatModelLabel, providerLabel } from './TaskIdentity';
import {
  blockerBadge,
  btnPrimary,
  btnQuietDestructive,
  chip,
  displayTitle,
  hitlBadge,
  panel,
  sectionLabel,
  stateChip,
  stateDot,
  stateFill,
  toolChip,
  touchTargetInline,
} from '../ui';

/** The recorded trigger, without the settle fact's `escalated to human:` preamble. */
export function escalationReasonText(reason: string): string {
  return reason.replace(/^escalated to human:\s*/i, '');
}

function rowId(task: Task): string {
  return task.origin === 'mirrored' && task.trackerRef != null
    ? issueRef(task.trackerRef)
    : taskKey(task.id);
}

function Dot({ task }: { task: Task }) {
  const pulse = task.state === 'working' ? 'motion-safe:animate-pulse' : '';
  return <span role="img" aria-label={task.state.replaceAll('-', ' ')} className={`${stateDot(task.state)} ${pulse}`} />;
}

const HIT44 = "after:absolute after:left-1/2 after:top-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']";

function RunningReadoutLine({ task }: { task: Task }) {
  const attemptId = task.attemptId;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  // Live context-window fill from the attempt_usage firehose (falls back to the
  // REST snapshot until the first tick); `ctx %` = contextTokens/contextWindow.
  const [liveContext, setLiveContext] = useState<number | null>(null);
  useEffect(() => {
    if (attemptId == null) return;
    setLiveContext(null);
    return subscribe((msg) => {
      if (msg.type === 'attempt_usage' && msg.attemptId === attemptId) setLiveContext(msg.contextTokens ?? null);
    });
  }, [attemptId]);
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

function runTask(taskId: number, onChanged: () => void) {
  return (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    api.runTask(taskId).then(onChanged, toastError);
  };
}

function RunNowButton({ taskId, onChanged }: { taskId: number; onChanged: () => void }) {
  return (
    <button
      type="button"
      className={`relative inline-flex items-center rounded-md border border-accent bg-accent px-[13px] py-[7px] text-[13px] font-semibold text-on-accent transition-colors hover:opacity-90 ${HIT44}`}
      onClick={runTask(taskId, onChanged)}
    >
      Run now
    </button>
  );
}

/** The escalated card's one action: open the ticket (or Epic peek), where the resolution lives. */
function ResolveButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`relative inline-flex items-center rounded-md border border-await bg-await px-[13px] py-[7px] text-[13px] font-semibold text-on-await transition-colors hover:opacity-90 ${HIT44}`}
      onClick={onOpen}
    >
      Resolve →
    </button>
  );
}

function WhoLine({ harness, model }: { harness: string; model: string }) {
  return (
    <span className="min-w-0 truncate text-small text-muted">
      {providerLabel(harness)} · {formatModelLabel(model)}
    </span>
  );
}

function BlockerBadge({ count, blockedOnFailed }: { count: number; blockedOnFailed: boolean }) {
  return (
    <span className={blockerBadge(blockedOnFailed)} title={blockedOnFailed ? 'A blocker is escalated or cancelled' : undefined}>
      {count === 1 ? '1 blocker' : `${count} blockers`}
    </span>
  );
}

function HitlBadge() {
  return (
    <span className={hitlBadge} title="Human-only ticket — Harmonic takes no actions on it">
      <Icon name="user" className="size-3" />
      HITL
    </span>
  );
}

/** Attention / Running card: the full ~420px ticket card (DESIGN.md § 6). */
function TaskCard({ task, onOpen, onChanged }: { task: Task; onOpen: () => void; onChanged: () => void }) {
  const hasReadout = task.runStartedAt != null;
  const action =
    task.state === 'escalated' ? (
      <ResolveButton onOpen={onOpen} />
    ) : task.state === 'ready' && task.agentWorkable ? (
      <RunNowButton taskId={task.id} onChanged={onChanged} />
    ) : null;
  const showFoot = !!task.branch || hasReadout || !!action;

  return (
    <article data-task-id={task.id} className={`group bold-wash ${task.state} relative flex w-[26.25rem] shrink-0 cursor-pointer flex-col overflow-hidden rounded-lg bg-surface shadow-card transition-shadow duration-150 motion-reduce:transition-none hover:shadow-float`}>
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[5px] ${stateFill(task.state)}`} />
      <div className="flex flex-1 flex-col px-4 py-4 pl-5">
        <div className="flex items-center gap-2">
          {task.mapRef != null && <span className={toolChip}>epic/{task.mapRef}</span>}
          <Dot task={task} />
          <span className="font-data text-small text-faint">{rowId(task)}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {task.openBlockerCount > 0 && <BlockerBadge count={task.openBlockerCount} blockedOnFailed={task.blockedOnFailed} />}
            {task.state === 'escalated' ? (
              <span className={stateChip(task.state)}>escalated</span>
            ) : task.state === 'working' && task.currentStep ? (
              <span className={stateChip(task.state)}>{task.currentStep}</span>
            ) : null}
          </span>
        </div>
        <button
          type="button"
          onClick={onOpen}
          title={task.summary}
          className="mt-2 line-clamp-2 cursor-pointer text-left text-[15px] font-semibold leading-[1.3] text-ink focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent after:absolute after:inset-0 after:content-['']"
        >
          {cardTitle(task.summary)}
        </button>
        {(task.escalationReason || task.origin === 'mirrored') && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
            {task.origin === 'mirrored' && (
              <span className="rounded-[3px] bg-raised px-1.5 py-0.5 text-label font-medium text-muted">mirrored</span>
            )}
            {task.escalationReason && (
              <span className="line-clamp-2 text-await" title={task.escalationReason}>
                {escalationReasonText(task.escalationReason)}
              </span>
            )}
          </div>
        )}
        <div className="-mt-1">
          <WhoLine harness={task.harness} model={task.model} />
        </div>
        {showFoot && (
          <div className="mt-auto flex items-center gap-2.5 pt-3 text-small text-muted">
            {task.branch && (
              <span className="flex min-w-0 items-center gap-1.5">
                <Icon name="branch" className="shrink-0 text-faint" />
                <span className="min-w-0 truncate font-data">{task.branch}</span>
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2.5 whitespace-nowrap">
              {hasReadout && <RunningReadoutLine task={task} />}
              {action && <span className="relative z-10">{action}</span>}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}

const SEGMENT_FILL: Record<RailSegmentStatus, string> = {
  merged: 'bg-merged-dot',
  running: 'bg-running-dot',
  healing: 'bg-running-dot motion-safe:animate-pulse',
  waiting: 'bg-raised',
  blocking: 'bg-raised',
};

function MergeTrain({ epic }: { epic: Epic }) {
  return (
    <span
      className="flex shrink-0 items-center gap-1"
      role="img"
      aria-label={`Merge train — ${epic.foldedCount} of ${epic.memberCount} merged`}
    >
      {railSegments(epic).map((seg) => (
        <span key={seg.ref} className={`h-1.5 w-4 rounded-full ${SEGMENT_FILL[seg.status]}`} />
      ))}
    </span>
  );
}

function EpicKindBadge({ epic }: { epic: Epic }) {
  return (
    <span className="shrink-0 rounded bg-tool-tint px-1.5 py-0.5 text-label font-bold text-tool">
      {epic.kind === 'map' ? 'Map' : 'Epic'}
    </span>
  );
}

/** An escalated Epic in Attention: the whole-Epic merge is held for the operator (ADR-0041). */
function EpicAttentionCard({ epic, onOpenEpic }: { epic: Epic; onOpenEpic?: (epic: Epic) => void }) {
  const open = () => onOpenEpic?.(epic);
  return (
    <article data-epic-ref={epic.ref} className="group bold-wash escalated relative flex w-[26.25rem] shrink-0 cursor-pointer flex-col overflow-hidden rounded-lg bg-surface shadow-card transition-shadow duration-150 motion-reduce:transition-none hover:shadow-float">
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[5px] ${stateFill('escalated')}`} />
      <div className="flex flex-1 flex-col px-4 py-4 pl-5">
        <div className="flex items-center gap-2">
          <EpicKindBadge epic={epic} />
          <span role="img" aria-label="escalated epic" className={stateDot('escalated')} />
          <span className="font-data text-small text-faint">epic/{epic.ref}</span>
          <span className={`ml-auto ${stateChip('escalated')}`}>escalated</span>
        </div>
        <button
          type="button"
          onClick={open}
          title={epic.title}
          className="mt-2 line-clamp-2 cursor-pointer text-left text-[15px] font-semibold leading-[1.3] text-ink focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent after:absolute after:inset-0 after:content-['']"
        >
          {epic.title}
        </button>
        <div className="mt-2 text-[12.5px]">
          <span className="line-clamp-2 text-await" title={epic.integrate.held ?? undefined}>
            {epic.integrate.held}
          </span>
        </div>
        <div className="mt-auto flex items-center gap-2.5 pt-3 text-small text-muted">
          <MergeTrain epic={epic} />
          <span className="tabular-nums">
            {epic.foldedCount} of {epic.memberCount} merged
          </span>
          {onOpenEpic && (
            <span className="relative z-10 ml-auto">
              <ResolveButton onOpen={open} />
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function CardStrip({ count, children }: { count: number; children: React.ReactNode }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(0);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => {
      const visibleCards = Math.max(1, Math.floor(strip.clientWidth / 432));
      setMore(Math.max(0, count - visibleCards));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [count]);

  return (
    <div className="relative">
      <div ref={stripRef} data-board-layout="card-strip" className="flex gap-3 overflow-x-auto pb-2 pr-20 [scrollbar-width:thin]">
        {children}
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

type SectionTone = 'attn' | 'running' | 'neutral';

// The count pill carries the section's state colour (the Signal Rule): solid
// indigo for Attention, Running amber tint, neutral for Pending.
const SECTION_COUNT: Record<SectionTone, string> = {
  attn: 'bg-await text-on-await',
  running: 'bg-running-tint text-running',
  neutral: 'bg-raised text-muted',
};

function BoardSection({
  label,
  count,
  tone = 'neutral',
  children,
}: {
  label: string;
  count?: string;
  tone?: SectionTone;
  children: React.ReactNode;
}) {
  const attn = tone === 'attn';
  return (
    <section className="mb-[26px]">
      <div className="mb-[13px] flex items-center gap-2.5 px-0.5">
        <h2 className={`text-[11px] font-bold uppercase tracking-[0.11em] ${attn ? 'text-await' : 'text-ink'}`}>{label}</h2>
        {count != null && (
          <span
            aria-atomic="true"
            aria-live={attn ? 'polite' : undefined}
            className={`rounded-full px-2 py-px text-[11px] font-bold tabular-nums ${SECTION_COUNT[tone]}`}
          >
            {count}
          </span>
        )}
        <span aria-hidden="true" className="h-px flex-1 bg-edge" />
      </div>
      {children}
    </section>
  );
}

const isBlocked = (item: PendingItem): boolean => item.openBlockerCount != null && item.openBlockerCount > 0;

// Ready ≠ blocked (DESIGN.md § 5): a ticket whose stored state is `ready` but
// which waits on a blocker shows the Blocked slate, never the actionable teal.
function itemDot(item: PendingItem): string {
  if (item.state === null) return 'bg-edge';
  if (item.humanOnly) return 'bg-faint';
  if (isBlocked(item)) return 'bg-blocked';
  return stateFill(item.state);
}

/** Pending node (DESIGN.md § 6): state dot + mono id + title + blocker chips; the
 * ▷ Run now on a runnable frontier node, the blocker-count or HITL badge otherwise. */
function PendingCard({
  item,
  onOpenTask,
  onChanged,
}: {
  item: PendingItem;
  onOpenTask: (taskId: number) => void;
  onChanged: () => void;
}) {
  const muted = item.humanOnly;
  const wash: TaskState | '' = muted || isBlocked(item) || item.state === null ? '' : item.state;
  return (
    <div className={`bold-wash ${wash} relative w-[300px] shrink-0 cursor-pointer rounded-lg border bg-surface p-2.5 transition duration-150 motion-reduce:transition-none hover:-translate-y-0.5 hover:border-edge hover:shadow-float ${item.runnable ? 'border-ready-dot/40' : 'border-hairline'}`}>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${itemDot(item)}`} />
        <span className="font-data text-small text-faint">{item.label}</span>
        <span className="sr-only">{item.humanOnly ? 'human-only' : (item.state ?? 'unmirrored')}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {item.humanOnly && <HitlBadge />}
          {item.openBlockerCount != null && item.openBlockerCount > 0 && (
            <BlockerBadge count={item.openBlockerCount} blockedOnFailed={item.blockedOnFailed} />
          )}
          {item.runnable && item.taskId != null && (
            <button
              type="button"
              aria-label="Run now"
              title="Run now"
              onClick={runTask(item.taskId, onChanged)}
              className="relative z-10 grid size-[23px] place-items-center rounded-md border border-ready-dot/40 bg-ready-tint text-ready transition-colors duration-150 hover:bg-ready-dot hover:text-white after:absolute after:-inset-2.5 after:content-['']"
            >
              <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 5l12 7-12 7V5z" />
              </svg>
            </button>
          )}
        </span>
      </div>
      <button
        type="button"
        disabled={item.taskId == null}
        onClick={() => item.taskId != null && onOpenTask(item.taskId)}
        title={item.title}
        className={`mt-1 block w-full min-w-0 cursor-pointer truncate text-left text-small font-medium disabled:cursor-default focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent enabled:after:absolute enabled:after:inset-0 enabled:after:content-[''] ${muted ? 'text-muted' : 'text-ink'}`}
      >
        {cardTitle(item.title)}
      </button>
      {item.blockers.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.blockers.map((blocker) => (
            <span
              key={blocker.taskId}
              className={`rounded bg-raised px-1.5 py-0.5 text-label text-muted ${blocker.satisfied ? 'line-through' : ''}`}
            >
              {blocker.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function BlockerColumns({
  columns,
  onOpenTask,
  onChanged,
  className = '',
}: {
  columns: BlockerColumn[];
  onOpenTask: (taskId: number) => void;
  onChanged: () => void;
  className?: string;
}) {
  return (
    <div data-board-layout="blocker-columns" className={`overflow-x-auto [scrollbar-width:thin] ${className}`}>
      <div className="flex min-w-max items-start gap-4">
        {columns.map((column) => (
          <section key={column.label} className="w-[300px] shrink-0">
            <h3 className="mb-2 flex items-center gap-1.5 text-label font-bold uppercase text-faint">
              {column.label}
              <span className="font-semibold tabular-nums">· {column.items.length}</span>
            </h3>
            <div className="flex flex-col gap-2">
              {column.items.map((item) => (
                <PendingCard key={item.key} item={item} onOpenTask={onOpenTask} onChanged={onChanged} />
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
  columns,
  defaultOpen = false,
  onOpenTask,
  onChanged,
  onOpenEpic,
}: {
  epic: Epic;
  columns: BlockerColumn[];
  defaultOpen?: boolean;
  onOpenTask: (taskId: number) => void;
  onChanged: () => void;
  /** Focus this Epic — the ADR-0011 board surface where its members, closed-task
   * rail, status pips, and force-merge control live. */
  onOpenEpic?: (epic: Epic) => void;
}) {
  const attention = epic.members.filter((m) => m.escalated);
  const hasColumns = columns.length > 0;
  // A band with pending members opens by default; one whose members are all
  // merged or promoted to the top sections has nothing to expand.
  const [open, setOpen] = useState(defaultOpen || hasColumns);

  return (
    <div className={panel}>
      <div className="flex items-center gap-2.5 px-4 py-3">
        <button
          type="button"
          aria-expanded={hasColumns ? open : undefined}
          onClick={() => (hasColumns ? setOpen((v) => !v) : onOpenEpic?.(epic))}
          className={`${touchTargetInline} min-w-0 flex-1 gap-2.5 text-left`}
        >
          <EpicKindBadge epic={epic} />
          <span className="shrink-0 font-data text-small text-faint">epic/{epic.ref}</span>
          <span className="truncate text-title font-semibold text-ink">{epic.title}</span>
        </button>
        {attention.length > 0 && (
          <span className={`${chip} shrink-0 bg-await-tint text-await`}>{attention.length} in attention</span>
        )}
        <MergeTrain epic={epic} />
        {hasColumns && (
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

      {open && hasColumns && (
        <div className="border-t border-hairline">
          <BlockerColumns columns={columns} onOpenTask={onOpenTask} onChanged={onChanged} className="p-4" />
        </div>
      )}
    </div>
  );
}

function FirstRunBoard({ onNewTask }: { onNewTask: () => void }) {
  const steps = [
    { title: 'Create a task', body: 'Describe the work and point it at a repo on this machine.' },
    { title: 'Run it', body: 'Press Run now, or turn the auto-runner on to start ready tasks for you.' },
    { title: 'Watch it merge', body: "The agent's steps stream live; verified work merges on its own, and only an escalated ticket asks for you." },
  ];
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <h1 className={displayTitle}>Run your first agent</h1>
      <p className="mx-auto mt-2 text-muted">
        Harmonic queues a task, runs an agent on it unattended, verifies the result, and merges it — you are only
        asked when a ticket escalates.
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

function AttentionCard({
  entry,
  onOpen,
  onChanged,
  onOpenEpic,
}: {
  entry: AttentionEntry;
  onOpen: (task: Task) => void;
  onChanged: () => void;
  onOpenEpic?: (epic: Epic) => void;
}) {
  if (entry.kind === 'epic') return <EpicAttentionCard epic={entry.epic} onOpenEpic={onOpenEpic} />;
  return <TaskCard task={entry.task} onOpen={() => onOpen(entry.task)} onChanged={onChanged} />;
}

const PIP_FILL: Record<MemberPipStatus, string> = {
  escalated: 'bg-await-dot',
  blocked: 'bg-fail-dot',
  merged: 'bg-merged-dot',
  cancelled: 'bg-faint',
  running: 'bg-running-dot',
  waiting: 'bg-edge',
};

/** ADR-0011: one colour-status pip per member, top-right of the Epic surface. */
function StatusPips({ epic }: { epic: Epic }) {
  return (
    <span
      className="flex max-w-[13rem] flex-wrap items-center justify-end gap-1"
      role="img"
      aria-label={`${epic.foldedCount} of ${epic.memberCount} members merged`}
    >
      {epic.members.map((m) => {
        const status = memberPipStatus(m);
        return <span key={m.ref} title={`#${m.ref} · ${status}`} className={`size-2 rounded-full ${PIP_FILL[status]}`} />;
      })}
    </span>
  );
}

const STEP_FILL: Record<IntegrationStepState, string> = {
  done: 'bg-merged-dot',
  current: 'bg-running-dot',
  held: 'bg-await-dot motion-safe:animate-pulse',
  pending: 'bg-edge',
};
const STEP_TEXT: Record<IntegrationStepState, string> = {
  done: 'text-merged',
  current: 'text-running',
  held: 'text-await',
  pending: 'text-faint',
};

/** ADR-0011: the whole-Epic integration progress bar (verify → merge →
 * post-merge check → retire), shown once the Epic reaches the gate. */
function IntegrationProgress({ epic }: { epic: Epic }) {
  const steps = integrationSteps(epic);
  const current = steps.find((s) => s.state === 'current' || s.state === 'held');
  return (
    <div className="border-t border-hairline px-4 py-3">
      <div className={sectionLabel}>Integration</div>
      <ol
        className="mt-2.5 flex items-center gap-2"
        aria-label={`Integration progress — ${current ? current.label : 'complete'}${epic.integrate.held != null ? ' (escalated)' : ''}`}
      >
        {steps.map((step, i) => (
          <li key={step.key} className="flex flex-1 items-center gap-2 last:flex-none">
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span aria-hidden="true" className={`size-2.5 rounded-full ${STEP_FILL[step.state]}`} />
              <span className={`text-small font-medium ${STEP_TEXT[step.state]}`}>{step.label}</span>
            </span>
            {i < steps.length - 1 && <span aria-hidden="true" className="h-px flex-1 bg-edge" />}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** ADR-0011: the rail below the columns holding the Epic's closed (merged/
 * cancelled) members, so finished work stays visible without crowding. */
function ClosedRail({ members, onOpenTask }: { members: EpicMember[]; onOpenTask: (taskId: number) => void }) {
  return (
    <section className="mt-2">
      <div className={`${sectionLabel} mb-2 px-0.5`}>Closed · {members.length}</div>
      <div className="flex flex-wrap gap-2">
        {members.map((m) => {
          const merged = m.mergeStatus === 'completed';
          const label = merged ? 'merged' : 'cancelled';
          const inner = (
            <>
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${merged ? 'bg-merged-dot' : 'bg-faint'}`} />
              <span className="shrink-0 font-data text-small text-faint">#{m.ref}</span>
              <span className="min-w-0 flex-1 truncate text-small text-muted">{m.title || '—'}</span>
              <span className="shrink-0 text-label uppercase tracking-[0.08em] text-faint">{label}</span>
            </>
          );
          return m.taskId == null ? (
            <span key={m.ref} className="flex w-[240px] items-center gap-2 rounded-md bg-raised px-2.5 py-1.5">
              {inner}
            </span>
          ) : (
            <button
              key={m.ref}
              type="button"
              onClick={() => onOpenTask(m.taskId!)}
              className="flex w-[240px] items-center gap-2 rounded-md bg-raised px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-surface hover:ring-1 hover:ring-edge"
            >
              {inner}
            </button>
          );
        })}
      </div>
    </section>
  );
}

const BANNER_TONE: Record<IntegrateOutcomeBannerTone, string> = {
  ok: 'bg-merged-tint text-merged',
  warn: 'bg-running-tint text-running',
  bad: 'bg-fail-tint text-fail',
  info: 'bg-raised text-muted',
};
const BANNER_TIMEOUT_MS = 6000;

/**
 * The focused Epic surface (ADR-0011, replaces the retired Epic Peek): the
 * Epic's board of open tasks (members as ordinary cards in the normal board
 * structure), colour-status pips summarising every member, a closed-task rail
 * below the columns, and — once the Epic reaches the integration gate — the
 * whole-Epic integration progress bar with any escalation legible.
 */
function EpicBoard({
  epic,
  tasks,
  onOpen,
  onOpenTask,
  onChanged,
  onClearFocus,
  onForceIntegrate,
}: {
  epic: Epic;
  tasks: Task[];
  onOpen: (task: Task) => void;
  onOpenTask: (taskId: number) => void;
  onChanged: () => void;
  onClearFocus?: () => void;
  onForceIntegrate: (epicRef: number) => Promise<EpicIntegrateOutcome>;
}) {
  const [banner, setBanner] = useState<IntegrateOutcomeBanner | null>(null);
  // Drop a stale outcome banner when the operator focuses a different Epic.
  useEffect(() => setBanner(null), [epic.ref]);
  useEffect(() => {
    if (!banner) return;
    const timer = setTimeout(() => setBanner(null), BANNER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [banner]);

  const handleForceIntegrate = () => {
    onForceIntegrate(epic.ref).then((outcome) => setBanner(integrateOutcomeBanner(outcome)), toastError);
  };

  const { attention, running } = epicMemberSections(epic, tasks);
  const columns = epicPendingColumns(epic, tasks);
  const pendingCount = columns.reduce((n, c) => n + c.items.length, 0);
  const closed = closedMembers(epic);
  const s = statusLineParts(epic);
  const hasOpen = attention.length > 0 || running.length > 0 || columns.length > 0;

  return (
    <div>
      <div className={`${panel} mb-4`}>
        <div className="flex items-start gap-2.5 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <EpicKindBadge epic={epic} />
              <span className="shrink-0 font-data text-small text-faint">epic/{epic.ref}</span>
              <span className="truncate text-title font-semibold text-ink">{epic.title}</span>
            </div>
            <div className="mt-1.5 text-small text-muted tabular-nums">
              <span className="font-data">{s.ref}</span> @ <span className="font-data">{s.tip}</span> · verification{' '}
              {s.verification} · {s.foldedCount}/{s.memberCount} merged
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {onClearFocus && (
              <button
                type="button"
                className={`${touchTargetInline} text-small font-medium text-muted hover:text-ink`}
                onClick={onClearFocus}
              >
                Clear focus
              </button>
            )}
            <StatusPips epic={epic} />
          </div>
        </div>

        {epic.integrate.held != null && (
          <div aria-atomic="true" aria-live="polite" className="mx-4 mb-3 rounded-md bg-await-tint px-3 py-2 text-small text-await">
            <span className="font-semibold">Merge escalated — awaiting you.</span> {epic.integrate.held}
          </div>
        )}

        {isEpicIntegrating(epic) && <IntegrationProgress epic={epic} />}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-hairline px-4 py-3">
          <ArmedButton
            label="Force-merge ready subset"
            armedLabel="Confirm force-merge"
            ariaLabel={`Force-merge Epic #${epic.ref}`}
            className={btnQuietDestructive}
            onConfirm={handleForceIntegrate}
          />
          <p className="min-w-0 flex-1 text-label text-faint">{FORCE_INTEGRATE_CONSEQUENCE}.</p>
        </div>
        {banner && (
          <div aria-atomic="true" aria-live="assertive" className={`mx-4 mb-3 rounded-md px-3 py-2 text-small ${BANNER_TONE[banner.tone]}`}>
            {banner.text}
          </div>
        )}
      </div>

      {attention.length > 0 && (
        <BoardSection label="Attention" count={String(attention.length)} tone="attn">
          <CardStrip count={attention.length}>
            {attention.map((task) => (
              <TaskCard key={task.id} task={task} onOpen={() => onOpen(task)} onChanged={onChanged} />
            ))}
          </CardStrip>
        </BoardSection>
      )}

      {running.length > 0 && (
        <BoardSection label="Running" count={String(running.length)} tone="running">
          <CardStrip count={running.length}>
            {running.map((task) => (
              <TaskCard key={task.id} task={task} onOpen={() => onOpen(task)} onChanged={onChanged} />
            ))}
          </CardStrip>
        </BoardSection>
      )}

      {columns.length > 0 && (
        <BoardSection label="Pending" count={String(pendingCount)}>
          <BlockerColumns columns={columns} onOpenTask={onOpenTask} onChanged={onChanged} className="pb-2" />
        </BoardSection>
      )}

      {!hasOpen && (
        <p className="mb-6 px-1 text-small text-muted">No open tasks — every member has merged or been closed.</p>
      )}

      {closed.length > 0 && <ClosedRail members={closed} onOpenTask={onOpenTask} />}
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
  onForceIntegrateEpic,
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
  onForceIntegrateEpic: (epicRef: number) => Promise<EpicIntegrateOutcome>;
  focusEpic?: Epic | null;
  onClearFocus?: () => void;
}) {
  const sections = useMemo(() => boardSections(tasks, epics), [tasks, epics]);

  if (loading) return <BoardSkeleton />;

  if (focusEpic) {
    return (
      <EpicBoard
        epic={focusEpic}
        tasks={tasks}
        onOpen={onOpen}
        onOpenTask={onOpenTask}
        onChanged={onChanged}
        onClearFocus={onClearFocus}
        onForceIntegrate={onForceIntegrateEpic}
      />
    );
  }

  if (tasks.length === 0 && epics.length === 0) return <FirstRunBoard onNewTask={onNewTask} />;

  const { attention, running, pending } = sections;
  if (attention.length === 0 && running.length === 0 && pending.length === 0) return <AllClear />;

  const pendingCount = pending.reduce((n, group) => n + group.columns.reduce((m, column) => m + column.items.length, 0), 0);
  const hasEpicGroups = pending.some((group) => group.epic !== null);

  return (
    <div>
      <h1 className="sr-only">Board</h1>

      {attention.length > 0 && (
        <BoardSection label="Attention" count={String(attention.length)} tone="attn">
          <CardStrip count={attention.length}>
            {attention.map((entry) => (
              <AttentionCard
                key={entry.kind === 'epic' ? `epic:${entry.epic.ref}` : `task:${entry.task.id}`}
                entry={entry}
                onOpen={onOpen}
                onChanged={onChanged}
                onOpenEpic={onOpenEpic}
              />
            ))}
          </CardStrip>
        </BoardSection>
      )}

      {running.length > 0 && (
        <BoardSection label="Running" count={String(running.length)} tone="running">
          <CardStrip count={running.length}>
            {running.map((task) => (
              <TaskCard key={task.id} task={task} onOpen={() => onOpen(task)} onChanged={onChanged} />
            ))}
          </CardStrip>
        </BoardSection>
      )}

      {pending.length > 0 && (
        <BoardSection label="Pending" count={String(pendingCount)}>
          <div className="flex flex-col gap-3">
            {pending.map((group) =>
              group.epic ? (
                <EpicBand
                  key={`epic:${group.epic.ref}`}
                  epic={group.epic}
                  columns={group.columns}
                  onOpenTask={onOpenTask}
                  onChanged={onChanged}
                  onOpenEpic={onOpenEpic}
                />
              ) : (
                <div key="standalone" className={hasEpicGroups ? 'mt-2' : ''}>
                  {hasEpicGroups && <div className={`${sectionLabel} mb-2.5 px-0.5`}>Standalone</div>}
                  <BlockerColumns columns={group.columns} onOpenTask={onOpenTask} onChanged={onChanged} className="pb-2" />
                </div>
              ),
            )}
          </div>
        </BoardSection>
      )}
    </div>
  );
}
