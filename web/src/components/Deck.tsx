import { useEffect, useMemo, useState } from 'react';
import type { Task } from '../types';
import type { Epic, EpicMember, EpicLandOutcome, RailSegmentStatus } from '../epic-model';
import {
  FORCE_LAND_CONSEQUENCE,
  memberRailStatus,
  railSegments,
  rosterLanes,
} from '../epic-model';
import { deckSections, startOfDay, type RecentSummary } from '../deck-model';
import { issueRef, taskKey } from '../id-format.js';
import { runningReadout } from '../board-model';
import { api } from '../api';
import { subscribe } from '../ws';
import { toastError, toastLandOutcome } from '../toast';
import { ArmedButton } from './ArmedButton';
import { Icon } from './Icon';
import {
  btnGhost,
  btnPrimary,
  btnQuietDestructive,
  chip,
  deckRow,
  displayTitle,
  escalatedChip,
  panel,
  sectionLabel,
  sectionLabelAttn,
  stateDot,
  toolChip,
  touchTargetInline,
} from '../ui';

/* ────────────────────────────────────────────────────────────────────────
 * The Deck (DESIGN.md § 5, issue #182) — the home surface. A single centred
 * column of panelled sections ordered by the operator's attention
 * (`Needs you → In flight → Landing → Queued → Recent`), replacing the kanban
 * Board's state columns and drag. Rows are the summary; clicking one opens the
 * full Ticket page. The pure section model lives in `deck-model.ts`.
 * ──────────────────────────────────────────────────────────────────────── */

/** A mirrored Task reads by its tracker issue number; a native Task by its id,
 * `T-<id>` (DESIGN.md § 6 — "faint mono id"; a native task id is never a bare
 * number). */
function rowId(task: Task): string {
  return task.origin === 'mirrored' && task.trackerRef != null
    ? issueRef(task.trackerRef)
    : taskKey(task.id);
}

/** One quiet identity fact: harness · model, plus a non-direct isolation
 * deviation (the Mono Is Code Rule keeps these names sans, never chips). */
function metaLine(task: Task): string {
  const bits = [`${task.harness} · ${task.model}`];
  if (task.isolationMode !== 'direct') bits.push(task.isolationMode);
  return bits.join('  ·  ');
}

/** The row's small set of meaningful chips (DESIGN.md § 6: "Escalated and
 * mirrored get their one meaningful chip … neutral afk/high"): a mirrored issue
 * keeps its cyan tag *and* an amber `escalated` when both apply — the pair the
 * prototype shows on a triage row — with a neutral `afk` when a mirrored Task
 * runs unattended and isn't escalated. Native/normal carry none; caps at two,
 * never a slab. */
function RowChips({ task }: { task: Task }) {
  return (
    <>
      {task.origin === 'mirrored' && <span className={toolChip}>mirrored</span>}
      {task.escalated ? (
        <span className={escalatedChip}>escalated</span>
      ) : (
        task.drive === 'afk' && <span className={`${chip} bg-raised text-muted`}>afk</span>
      )}
      {task.origin !== 'mirrored' && task.priority === 'high' && (
        <span className={`${chip} bg-raised text-muted`}>high</span>
      )}
    </>
  );
}

/** A round state dot; a running Task's dot pulses (motion-safe, so reduced
 * motion keeps the figure and drops the animation — DESIGN.md § 6). */
function Dot({ task }: { task: Task }) {
  const pulse = task.state === 'running' ? 'motion-safe:animate-pulse' : '';
  return <span aria-hidden="true" className={`${stateDot(task.state)} ${pulse}`} />;
}

/** A Deck summary row: state dot · faint id · loud title · one quiet fact ·
 * right-aligned signal/action. The title is a **stretched link** (its `::after`
 * overlays the whole row) so the entire row opens the Ticket while the only
 * focusable element is a genuine control — no `role=button` wrapper nesting the
 * row's own action button (WAI-ARIA bans focusable descendants of a widget).
 * The aside sits `z-10` above the overlay so its button stays clickable. */
function DeckRow({
  task,
  onOpen,
  aside,
  indent = false,
}: {
  task: Task;
  onOpen: () => void;
  aside?: React.ReactNode;
  indent?: boolean;
}) {
  return (
    <div className={`${deckRow} relative cursor-pointer ${indent ? 'pl-7' : ''}`}>
      <Dot task={task} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-data text-small text-faint">{rowId(task)}</span>
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 flex-1 truncate text-left text-title font-medium text-ink after:absolute after:inset-0 after:content-['']"
          >
            {task.prompt}
          </button>
        </div>
        <div className="mt-1 flex items-center gap-2 text-small text-faint">
          <RowChips task={task} />
          <span className="truncate text-muted">{metaLine(task)}</span>
        </div>
      </div>
      {aside && <div className="relative z-10 flex items-center gap-2.5 justify-self-end">{aside}</div>}
    </div>
  );
}

/** A quiet forward-action ghost button on a row — opens the Ticket (DESIGN.md
 * § 5: the escalated row "carries its state's forward action as a button …
 * `Open`"). Sits above the stretched-link overlay, so `stopPropagation` keeps
 * the click from also firing the row's navigate. */
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
      Open
    </button>
  );
}

/** The right-aligned accent pill on an awaiting-review row — its state IS the
 * cobalt accent (DESIGN.md § 2: "awaiting review = the cobalt accent"). */
function ReviewPill() {
  return <span className={`${chip} bg-accent-tint text-accent`}>awaiting review</span>;
}

/** A running row's live readout: elapsed · N tools, tabular figures. Self-
 * contained (issue #222): it owns its once-a-second elapsed tick and subscribes
 * to the `run_usage` firehose for *its own* run, so a usage tick re-renders only
 * this leaf — never the whole Deck subtree. Renders nothing until the Task is a
 * live run (mirrors `runningReadout`'s null). */
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

/** The forward-action button on a ready Task (DESIGN.md § 5: "a `Run now` on
 * each"): starts a Run, then refreshes. Stops propagation so it never doubles
 * as opening the Ticket. */
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

/** A quiet right-aligned status word (blocked / draft / when). */
function WhenNote({ children }: { children: React.ReactNode }) {
  return <span className="text-small text-faint">{children}</span>;
}

/** A disclosure chevron; points right when closed, down when open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="chevron-down"
      className={`text-faint transition-transform duration-150 motion-reduce:transition-none ${open ? '' : '-rotate-90'}`}
    />
  );
}

/* ── Section ──────────────────────────────────────────────────────────── */

function Section({
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
        {count != null && <span className="text-small font-semibold text-muted">{count}</span>}
        {sub && <span className="ml-auto text-small text-faint">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

/* ── Epic band (Landing) ──────────────────────────────────────────────── */

/** Merge-train segment fill by land status (DESIGN.md § 6 — "the Epic's colour
 * lives here"): landed emerald / running amber / blocking rose / pending
 * neutral; a heal in progress pulses (the one genuinely-live thing, ADR-0026). */
const SEGMENT_FILL: Record<RailSegmentStatus, string> = {
  landed: 'bg-accept-dot',
  running: 'bg-running-dot',
  healing: 'bg-running-dot motion-safe:animate-pulse',
  waiting: 'bg-raised',
  blocking: 'bg-fail-dot',
};

/** The state dot for an Epic member row, mapped from its rail status. */
const MEMBER_DOT: Record<RailSegmentStatus, string> = {
  landed: 'bg-accept-dot',
  running: 'bg-running-dot motion-safe:animate-pulse',
  healing: 'bg-running-dot motion-safe:animate-pulse',
  waiting: 'bg-ready-dot',
  blocking: 'bg-fail-dot',
};

const MEMBER_STATUS_WORD: Record<RailSegmentStatus, string> = {
  landed: 'folded',
  running: 'running',
  healing: 'healing',
  waiting: 'waiting',
  blocking: 'blocked',
};

function MemberRow({ member, epic, onOpenTask }: { member: EpicMember; epic: Epic; onOpenTask: (taskId: number) => void }) {
  const status = memberRailStatus(member, epic);
  const open = member.taskId != null ? () => onOpenTask(member.taskId!) : undefined;
  const inner = (
    <>
      <span aria-hidden="true" className={`size-2 rounded-full ${MEMBER_DOT[status]}`} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-data text-small text-faint">#{member.ref}</span>
          <span className="truncate text-title font-medium text-ink">{member.title || `member #${member.ref}`}</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-small text-faint">
          {member.escalated && <span className={escalatedChip}>escalated</span>}
          <span className="text-muted">{MEMBER_STATUS_WORD[status]}</span>
        </div>
      </div>
    </>
  );
  const cls = `${deckRow} pl-7`;
  return open ? (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      className={`${cls} cursor-pointer`}
    >
      {inner}
      <span className="justify-self-end" />
    </div>
  ) : (
    <div className={cls}>
      {inner}
      <span className="justify-self-end" />
    </div>
  );
}

/** One Epic as a band (DESIGN.md § 6 Epic band): a header (kind badge · ref ·
 * title · disclosure), a status row (merge-train · folded · tip · verification
 * · blocking note · Force-land), and — when open — the member roster. This is
 * the one place the parallel-Epic machinery is legible at a glance. */
function EpicBand({
  epic,
  defaultOpen = false,
  onOpenTask,
  onOpenEpic,
  onForceLandEpic,
}: {
  epic: Epic;
  defaultOpen?: boolean;
  onOpenTask: (taskId: number) => void;
  /** Open the full Epic peek (ADR-0026) — the deep view behind the band. */
  onOpenEpic?: (epic: Epic) => void;
  onForceLandEpic: (ref: number) => Promise<EpicLandOutcome>;
}) {
  // Members that need the operator (escalated or awaiting-review): the band
  // opens by default when it holds one, so nothing that needs you stays below
  // the fold even though it lives inside a Landing band and not Needs-you
  // (DESIGN.md § 5 Prime Directive; reconciles the rail's cobalt count, which
  // includes Epic members, with what the Deck actually shows — issue #182).
  const attention = epic.members.filter((m) => m.escalated || m.state === 'awaiting-review');
  const [open, setOpen] = useState(defaultOpen || attention.length > 0);
  const segments = railSegments(epic);
  const stuck = rosterLanes(epic).stuck;
  const verification = epic.verification.status;
  const blockingNote =
    epic.land.held ?? (stuck.length > 0 ? `${issueRef(stuck[0]!.ref)} blocked` : null);

  return (
    <div className={panel}>
      {/* Header: the identity opens the full peek (the deep view); the trailing
          chevron toggles the inline member roster (DESIGN.md § 6 Epic band). */}
      <div className="flex items-center gap-2.5 px-4 py-3">
        <button
          type="button"
          onClick={() => (onOpenEpic ? onOpenEpic(epic) : setOpen((v) => !v))}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <span className="shrink-0 rounded bg-tool-tint px-1.5 py-0.5 text-label font-bold uppercase text-tool">
            {epic.kind}
          </span>
          <span className="shrink-0 font-data text-small text-faint">epic/{epic.ref}</span>
          <span className="truncate text-title font-semibold text-ink">{epic.title}</span>
        </button>
        {attention.length > 0 && (
          <span className={`${chip} shrink-0 bg-running-tint text-running`}>{attention.length} need you</span>
        )}
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Collapse Epic #${epic.ref} members` : `Expand Epic #${epic.ref} members`}
          onClick={() => setOpen((v) => !v)}
          className={`${touchTargetInline} shrink-0`}
        >
          <Chevron open={open} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-3.5">
        <span
          className="flex items-center gap-1"
          role="img"
          aria-label={`Merge train — ${epic.foldedCount} of ${epic.memberCount} folded`}
        >
          {segments.map((seg) => (
            <span key={seg.ref} className={`h-1.5 w-5 rounded-full ${SEGMENT_FILL[seg.status]}`} />
          ))}
        </span>
        <span className="text-small text-muted">
          <span className="text-faint">folded</span> {epic.foldedCount}/{epic.memberCount}
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
              label="Force-land"
              armedLabel="Confirm force-land"
              ariaLabel={`Force-land Epic #${epic.ref}`}
              className={`${touchTargetInline} ${btnQuietDestructive} text-small`}
              onConfirm={() => {
                onForceLandEpic(epic.ref).then(toastLandOutcome, toastError);
              }}
            />
            <p className="max-w-[220px] text-right text-label text-faint">{FORCE_LAND_CONSEQUENCE}.</p>
          </div>
        </div>
      </div>

      {open && (
        <div className="divide-y divide-hairline border-t border-hairline">
          {epic.members.map((m) => (
            <MemberRow key={m.ref} member={m} epic={epic} onOpenTask={onOpenTask} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Recent (collapsed count) ─────────────────────────────────────────── */

function RecentBar({ recent, onShowRecent }: { recent: RecentSummary; onShowRecent: () => void }) {
  return (
    <button
      type="button"
      onClick={onShowRecent}
      className={`${panel} mt-3 flex w-full items-center gap-4 px-4 py-3 text-left text-small text-muted transition-colors duration-150 hover:bg-raised/50`}
    >
      {recent.landed > 0 && (
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="size-2 rounded-full bg-accept-dot" />
          {recent.landed} landed
        </span>
      )}
      {recent.failed > 0 && (
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="size-2 rounded-full bg-fail-dot" />
          {recent.failed} failed
        </span>
      )}
      {recent.cancelled > 0 && (
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="size-2 rounded-full bg-faint" />
          {recent.cancelled} cancelled
        </span>
      )}
      <span className="text-faint">today</span>
      <span className="ml-auto">
        <Icon name="chevron-down" className="-rotate-90 text-faint" />
      </span>
    </button>
  );
}

/* ── Empty & loading states ───────────────────────────────────────────── */

/** First-run: the empty Deck teaches its own shape — one quiet guide and a
 * single primary driving to the first agent Run (no tour, no overlay). */
function FirstRunDeck({ onNewTask }: { onNewTask: () => void }) {
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

/** Skeleton: panelled section shapes so the Deck's geometry is stable from the
 * first paint (skeletons, not a spinner). */
function DeckSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse motion-reduce:animate-none">
      {[2, 3].map((rows, i) => (
        <section key={i} className="mt-6 first:mt-3">
          <div className="mb-2 h-3 w-24 rounded bg-raised" />
          <div className={panel}>
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

/** When the workspace has tasks but nothing needs the operator right now. */
function AllClear() {
  return (
    <div className="mx-auto mt-16 max-w-sm text-center">
      <h1 className={displayTitle}>All clear</h1>
      <p className="mt-2 text-muted">Nothing needs you right now. Queued and landed work shows here as it moves.</p>
    </div>
  );
}

/* ── Deck ─────────────────────────────────────────────────────────────── */

export function Deck({
  tasks,
  loading,
  epics,
  onOpen,
  onOpenTask,
  onChanged,
  onNewTask,
  onOpenEpic,
  onForceLandEpic,
  onShowRecent,
  focusEpic = null,
  onClearFocus,
}: {
  tasks: Task[];
  loading: boolean;
  epics: Epic[];
  /** Open a standalone Task's Ticket. */
  onOpen: (task: Task) => void;
  /** Open a Task's Ticket by id (Epic member deep-links). */
  onOpenTask: (taskId: number) => void;
  onChanged: () => void;
  onNewTask: () => void;
  /** Open the full Epic peek from a Landing band (ADR-0026). */
  onOpenEpic?: (epic: Epic) => void;
  onForceLandEpic: (epicRef: number) => Promise<EpicLandOutcome>;
  /** Show the full terminal history (the Table view) from the Recent bar. */
  onShowRecent: () => void;
  /** Epic focus-mode (ADR-0026): filters the Deck to one Epic's band. */
  focusEpic?: Epic | null;
  onClearFocus?: () => void;
}) {
  // Running rows' elapsed figure ticks off a once-a-second `now`, only while a
  // Task is actually running (issue #100).
  const hasRunning = tasks.some((t) => t.state === 'running');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunning) return;
    // `now` here only feeds Recent's midnight boundary (deckSections keys off
    // startOfDay(now)); running readouts tick in their own leaf now (issue #222),
    // so advance `now` only when the local day rolls over — the Deck no longer
    // re-renders every second.
    const timer = setInterval(() => {
      const t = Date.now();
      setNow((prev) => (startOfDay(t) !== startOfDay(prev) ? t : prev));
    }, 1_000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  // Re-derive sections when the inputs or the *day bucket* change — not on every
  // one-second `now` tick. `now` only feeds Recent's midnight boundary inside
  // `deckSections` (its sole consumer now that readouts self-tick — issue #222).
  const dayStart = startOfDay(now);
  const sections = useMemo(
    () => deckSections(tasks, epics, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` intentionally excluded; `dayStart` is its only section-relevant projection
    [tasks, epics, dayStart],
  );

  if (loading) return <DeckSkeleton />;

  // Epic focus-mode (ADR-0026): the Deck narrows to one Epic's band, expanded,
  // with a Clear-focus control — the same feature the Board's focus header gave.
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
        <EpicBand epic={focusEpic} defaultOpen onOpenTask={onOpenTask} onOpenEpic={onOpenEpic} onForceLandEpic={onForceLandEpic} />
      </div>
    );
  }

  if (tasks.length === 0 && epics.length === 0) return <FirstRunDeck onNewTask={onNewTask} />;

  const { needsYou, inFlight, landing, queued, recent } = sections;
  const nothingActive =
    needsYou.length === 0 && inFlight.length === 0 && landing.length === 0 && queued.length === 0 && recent.total === 0;
  if (nothingActive) return <AllClear />;

  return (
    <div>
      <h1 className="sr-only">Deck</h1>

      {needsYou.length > 0 && (
        <Section label="Needs you" count={String(needsYou.length)} sub="review & escalations" attn>
          <div className={`${panel} divide-y divide-hairline`}>
            {needsYou.map((task) => (
              <DeckRow
                key={task.id}
                task={task}
                onOpen={() => onOpen(task)}
                aside={task.state === 'awaiting-review' ? <ReviewPill /> : <OpenButton onOpen={() => onOpen(task)} />}
              />
            ))}
          </div>
        </Section>
      )}

      {inFlight.length > 0 && (
        <Section label="In flight" count={String(inFlight.length)}>
          <div className={`${panel} divide-y divide-hairline`}>
            {inFlight.map((task) => (
              <DeckRow
                key={task.id}
                task={task}
                onOpen={() => onOpen(task)}
                aside={
                  task.state === 'running' && task.runStartedAt != null ? <RunningReadoutLine task={task} /> : null
                }
              />
            ))}
          </div>
        </Section>
      )}

      {landing.length > 0 && (
        <Section label="Landing" count={landing.length === 1 ? '1 epic' : `${landing.length} epics`} sub="members land as a batch">
          <div className="flex flex-col gap-3">
            {landing.map((epic) => (
              <EpicBand
                key={epic.ref}
                epic={epic}
                onOpenTask={onOpenTask}
                onOpenEpic={onOpenEpic}
                onForceLandEpic={onForceLandEpic}
              />
            ))}
          </div>
        </Section>
      )}

      {queued.length > 0 && (
        <Section label="Queued" count={String(queued.length)} sub="auto-runner picks by priority">
          <div className={`${panel} divide-y divide-hairline`}>
            {queued.map((task) => (
              <DeckRow
                key={task.id}
                task={task}
                onOpen={() => onOpen(task)}
                aside={
                  task.state === 'ready' ? (
                    <RunNowButton taskId={task.id} onChanged={onChanged} />
                  ) : task.state === 'blocked' ? (
                    <WhenNote>waiting</WhenNote>
                  ) : (
                    <WhenNote>draft</WhenNote>
                  )
                }
              />
            ))}
          </div>
        </Section>
      )}

      {recent.total > 0 && <RecentBar recent={recent} onShowRecent={onShowRecent} />}
    </div>
  );
}
