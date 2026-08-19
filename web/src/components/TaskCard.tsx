import type { Drive, Task } from '../types';
import { card, chip, escalatedChip } from '../ui';
import { runningReadout, type RunningReadout } from '../board-model';
import { cardBranch, cardDiffstat } from './cardBranch';
import { TaskActions } from './TaskActions';
import type { Epic } from '../epic-model';

/** One truncating identity line: id, harness · model, plus at most one
 * deviation — a non-direct isolation mode. Secondary facts (dependency count,
 * running cost) read in Task detail, not on the glance card: the card's job is
 * to let the title be the hero, so the meta line stays identity + one deviation
 * and never a stack of facts (issue #94). Sans, not mono — these are names and
 * figures, not code (the Mono Is Code Rule); never chip slabs. */
function metaLine(task: Task): string {
  const bits = [`#${task.id}`, `${task.harness} · ${task.model}`];
  if (task.isolationMode !== 'direct') bits.push(task.isolationMode);
  return bits.join('  ');
}

/** A mirrored card's type tag: 'implement' stays 'implement'; a wayfinder ticket
 * shows its decision kind (research/prototype/grilling/…), falling back to
 * 'wayfinder'. */
function typeTagLabel(task: Task): string {
  return task.workflow === 'implement' ? 'implement' : (task.wayfinderType ?? 'wayfinder');
}

/** The card's hero: the prompt, clickable to open the Task. Shared by both card
 * kinds so the title renders identically — the Title role (ink, 600) that makes
 * it the visually dominant element on either card species (DESIGN §Board "the
 * title is the hero"; issue #94). Callers pass only spacing, never weight or
 * size, so native and mirrored can't drift. */
function TitleButton({ task, onOpen, className = '' }: { task: Task; onOpen: (task: Task) => void; className?: string }) {
  return (
    <button
      type="button"
      className={`line-clamp-3 cursor-pointer whitespace-pre-wrap text-left text-title font-semibold text-ink ${className}`}
      onClick={() => onOpen(task)}
    >
      {task.prompt}
    </button>
  );
}

/** Amber "work in flight" pulse before a running card's title — motion-safe only, so reduced motion drops the animation (issue #100). */
function RunningPulse() {
  return <span aria-hidden="true" className="mt-1.5 size-[7px] shrink-0 rounded-full bg-running-dot motion-safe:animate-pulse" />;
}

/** The running card's quiet live line: elapsed · N tools, tabular figures, ticked by the Board's once-a-second `now` (issue #100). */
function RunningLine({ readout }: { readout: RunningReadout }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-small tabular-nums text-muted">
      <span className="sr-only">Running, </span>
      <span>{readout.elapsed}</span>
      <span aria-hidden="true">·</span>
      <span>{readout.tools} {readout.tools === 1 ? 'tool' : 'tools'}</span>
    </div>
  );
}

/** afk = a spark (Harmonic drives it); hitl = a person (you drive it). */
function DriveMark({ drive }: { drive: Drive }) {
  return drive === 'afk' ? (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5 shrink-0" fill="currentColor">
      <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="4.5" r="2.5" />
      <path d="M3 14c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5" strokeLinecap="round" />
    </svg>
  );
}

function MapGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M6 2.5L2 4v9.5L6 12l4 1.5 4-1.5V2.5L10 4 6 2.5z" strokeLinejoin="round" />
      <path d="M6 2.5v9.5M10 4v9.5" />
    </svg>
  );
}

/** Drive badge — afk rides Tooling cyan (Harmonic/the harness is the actor, and
 * harness chrome is cyan across the app), reusing an existing meaning rather
 * than minting a colour; hitl is neutral ink. Neither touches the state-signal
 * family, so the Signal Rule is intact. */
function DriveBadge({ drive }: { drive: Drive }) {
  return drive === 'afk' ? (
    <span className={`${chip} inline-flex items-center gap-1 bg-tool-tint text-tool`}>
      <DriveMark drive="afk" /> Auto
    </span>
  ) : (
    <span className={`${chip} inline-flex items-center gap-1 bg-raised text-ink`}>
      <DriveMark drive="hitl" /> You
    </span>
  );
}

/** The card's Epic chip (issue #167, ADR-0026): mirrors the `mapTitle` row's
 * treatment — quiet, raised, until interacted with — but is itself the
 * opener for the Epic peek, not just a label. Only rendered when the card's
 * Task is a mirrored member of a derived Epic. */
function EpicChip({ epic, onOpenEpic }: { epic: Epic; onOpenEpic: (epic: Epic) => void }) {
  return (
    <button
      type="button"
      className={`${chip} bg-raised text-muted transition-colors duration-150 hover:bg-accent-tint hover:text-accent`}
      onClick={(e) => {
        e.stopPropagation();
        onOpenEpic(epic);
      }}
    >
      Epic #{epic.ref}
    </button>
  );
}

/** The wayfinder role, grafted from prototype A (issue #34): a badge row (drive
 * + type + escalation) above the title, and the parent Map named below it. */
function MirroredCard({
  task,
  onOpen,
  readout,
  epic,
  onOpenEpic,
}: {
  task: Task;
  onOpen: (task: Task) => void;
  readout: RunningReadout | null;
  epic?: Epic;
  onOpenEpic?: (epic: Epic) => void;
}) {
  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        {task.drive && <DriveBadge drive={task.drive} />}
        <span className={`${chip} bg-raised text-muted`}>{typeTagLabel(task)}</span>
        {task.escalated && <span className={escalatedChip}>escalated</span>}
        {epic && onOpenEpic && <EpicChip epic={epic} onOpenEpic={onOpenEpic} />}
      </div>
      <div className="mb-2.5 flex items-start gap-2">
        {readout && <RunningPulse />}
        <TitleButton task={task} onOpen={onOpen} className="min-w-0 flex-1" />
      </div>
      <div className="mb-2 flex items-center gap-1.5 text-small text-muted">
        <MapGlyph />
        <span className="min-w-0 truncate text-ink">{task.mapTitle ?? '—'}</span>
        {task.trackerRef != null && <span className="ml-auto shrink-0 text-faint">#{task.trackerRef}</span>}
      </div>
      {readout && <RunningLine readout={readout} />}
    </>
  );
}

/** The native card — unchanged: hero prompt, one faint meta line, priority. */
function NativeCard({ task, onOpen, readout }: { task: Task; onOpen: (task: Task) => void; readout: RunningReadout | null }) {
  const branch = cardBranch(task);
  const diffstat = cardDiffstat(task);
  return (
    <>
      <div className="mb-2 flex items-start gap-2">
        {readout && <RunningPulse />}
        <TitleButton task={task} onOpen={onOpen} className="min-w-0 flex-1" />
      </div>
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 truncate text-small text-muted">{metaLine(task)}</span>
        {/* Priority is typographic, not chromatic (DESIGN.md § Colors);
            normal is the default and says nothing. */}
        {task.priority !== 'normal' && (
          <span
            className={`shrink-0 text-label uppercase ${task.priority === 'high' ? 'font-semibold text-ink' : 'font-medium text-muted'}`}
          >
            {task.priority}
          </span>
        )}
        {task.blockedOnFailed && (
          <span className="shrink-0 text-label font-semibold uppercase text-fail">on failed</span>
        )}
      </div>
      {readout && <RunningLine readout={readout} />}
      {/* Branch is genuine code (the Mono Is Code Rule), so it stays mono even
          on this sans-first card; the diffstat is a figure, so it's sans with
          tabular-nums — no green/red (that would spend a state colour on a
          non-state, the Signal Rule). Faint/muted keeps both a glance, not a
          console. */}
      {branch && (
        <div className="mb-2 flex items-center gap-2">
          <span className="min-w-0 truncate font-data text-label text-faint">{branch}</span>
          {diffstat && (
            <span className="shrink-0 text-label tabular-nums text-muted">
              +{diffstat.added} −{diffstat.removed}
            </span>
          )}
        </div>
      )}
    </>
  );
}

export function TaskCard({
  task,
  now = Date.now(),
  liveTools,
  onEdit,
  onOpen,
  onChanged,
  draggable = false,
  dragging = false,
  onDragStart,
  onDragEnd,
  epic,
  onOpenEpic,
}: {
  task: Task;
  now?: number;
  liveTools?: number | null;
  onEdit: (task: Task) => void;
  onOpen: (task: Task) => void;
  onChanged: () => void;
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  /** The Epic this card is a member of (issue #167, ADR-0026), if any — drives
   * the card's Epic chip. */
  epic?: Epic;
  onOpenEpic?: (epic: Epic) => void;
}) {
  const readout = runningReadout(task, now, liveTools);
  return (
    <article
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`${card} p-3.5 transition-shadow duration-150 hover:ring-1 hover:ring-edge ${
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      } ${dragging ? 'opacity-50' : ''}`}
    >
      {task.origin === 'mirrored' ? (
        <MirroredCard task={task} onOpen={onOpen} readout={readout} epic={epic} onOpenEpic={onOpenEpic} />
      ) : (
        <NativeCard task={task} onOpen={onOpen} readout={readout} />
      )}
      <TaskActions task={task} variant="card" onEdit={onEdit} onChanged={onChanged} />
    </article>
  );
}
