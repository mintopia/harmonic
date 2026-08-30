import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { formatCost, usd } from '../cost';
import type { Attempt, Step, StepType, GuardrailEvent, AttemptSummary, AttemptLogEvent, AttemptUsageEvent, Task, TicketTimelineEvent, VerificationAttempt, VerifierStatus } from '../types';
import { appendAttemptLogEvents, eventsAfterLiveCursor, attemptLogCursor } from '../attempt-log-stream-model';
import { EmptyState } from './EmptyState';
import { TranscriptTimeline } from './TranscriptTimeline';
import { DiffViewer } from './DiffViewer';
import type { DiffFile } from '../types';
import { describeGuardrailTrip } from '../guardrail-trip-model';
import { parseSkipReasonTaskRef } from '../skip-reason-model';
import { overallDecision, verificationRows, criticUnavailableReason } from '../verification-attempts-model';
import { changedFilesFromStat } from '../attempt-rail-model';
import { sumCosts } from '../activity-model';
import { Markdown } from './Markdown';
import { Icon } from './Icon';
import { subscribe, subscribeAttemptLog } from '../ws';
import { gateForAttempt } from '../ticket-gate-model';
import { cardTitle } from '../board-sections-model';
import { AttemptRail } from './ticket/AttemptRail';
import { Gate } from './ticket/Gate';
import { CrumbBar } from './CrumbBar';
import { LifecycleTimeline } from './ticket/LifecycleTimeline';
import { attemptTone, runFailureBannerLabel, runForAttempt, stateTone, verifiedSha, type TimelineTone } from '../attempt-timeline-model';
import { attemptStepTabs, contentPanel, defaultStepTab, taskLifecycle, modelTotal, taskStats, type ContentSelection, type LifecycleStepStatus, type StatsAttempt, type StepTab, type TaskModelStats, type TaskStats } from '../task-detail-model';
import { isAtLiveEdge } from '../follow-tail-model';
import { ChatTranscript } from './ticket/ChatTranscript';
import { Donut, type DonutSegment } from './Donut';
import { card, labelType, railSectionHead, railSectionCount, PHASE_NODE_STYLES } from '../ui';
import { toastError } from '../toast';
import { ticketIdentity } from '../id-format.js';
import { splitPathTail } from '../path';

// ─── small shared bits ───────────────────────────────────────────────────────

const sectionCaps = 'text-label font-bold uppercase tracking-[0.1em] text-faint';

function humanState(state: string): string {
  return state.replace(/-/g, ' ');
}

const STATE_PILL: Record<string, string> = {
  escalated: 'bg-await-tint text-await',
  working: 'bg-running-tint text-running',
  running: 'bg-running-tint text-running',
  ready: 'bg-ready-tint text-ready',
  failed: 'bg-fail-tint text-fail',
  done: 'bg-merged-tint text-merged',
  merged: 'bg-merged-tint text-merged',
  cancelled: 'bg-raised text-muted',
  draft: 'bg-raised text-muted',
};

function StatePill({ state }: { state: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-sm px-2.5 py-1 text-[11px] font-semibold ${
        STATE_PILL[state] ?? 'bg-raised text-muted'
      }`}
    >
      {humanState(state)}
    </span>
  );
}

// ─── description ─────────────────────────────────────────────────────────────

function descriptionBody(prompt: string): string {
  const title = cardTitle(prompt);
  let body = prompt.trimStart();
  if (body.startsWith(title)) body = body.slice(title.length);
  // Strip a leading heading line the title split left behind ("## Summary").
  body = body.replace(/^[\s]*#{1,6}[^\n]*\n+/, '').trim();
  return body || prompt;
}

function Description({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  const body = descriptionBody(prompt);
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

// ─── flat metric row ─────────────────────────────────────────────────────────

function fmtK(n: number): string {
  if (n <= 0) return '—';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function Metrics({
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
  // A live AttemptSummary reads its freshest `attempt_usage` snapshot; a settled AttemptSummary its
  // persisted totals/cost — so Cost, I/O, and Elapsed all tick as it runs.
  const costFor = (r: AttemptSummary) => (r.state === 'running' ? live.get(r.id)?.cost ?? r.cost : r.cost);
  // Honest-numbers headline (no total-token scalar): billable I/O = input + output.
  const io = taskStats(statsAttemptsOf(runs, live)).billableIO;
  const cost = sumCosts(runs.map(costFor)) ?? task.cost;
  // A finished AttemptSummary contributes its settled span; a live AttemptSummary its wall-clock so
  // far (now − startedAt), which the 1s `now` tick advances while it executes.
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
  const files = changedFilesFromStat(task.stat);
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
  const items: Array<[string, ReactNode]> = [
    ['Cost', formatCost(cost) ?? '—'],
    ['I/O', fmtK(io)],
    ['Elapsed', runs.length ? fmtDur(elapsed) : '—'],
    ['Attempts', `${runs.length}`],
    ['Diff', diff],
  ];
  return (
    <div className="mb-4 flex flex-wrap gap-x-5 gap-y-3 tabular-nums">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <div className="mb-[5px] text-[10px] font-bold uppercase tracking-[0.07em] text-faint">{k}</div>
          <div className="text-[17px] font-bold leading-none text-ink">{v}</div>
        </div>
      ))}
    </div>
  );
}

// ─── properties fact-list ────────────────────────────────────────────────────

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[7px]">
      <dt className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">{label}</dt>
      <dd className="min-w-0 text-right text-[12.5px] text-ink">{children}</dd>
    </div>
  );
}

function DependsOn({ task, allTasks }: { task: Task; allTasks: Task[] }) {
  if (task.dependsOn.length === 0) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 font-data">
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

function Properties({ task, allTasks, workspaceName }: { task: Task; allTasks: Task[]; workspaceName: string | null }) {
  const created = new Date(task.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <dl className="divide-y divide-hairline border-t border-hairline">
      <Fact label="Priority">{task.priority}</Fact>
      <Fact label="Agent">
        {task.harness.charAt(0).toUpperCase() + task.harness.slice(1)} <span className="font-data text-muted">{task.model}</span>
      </Fact>
      <Fact label="Workspace">{workspaceName ?? '—'}</Fact>
      <Fact label="Depends on">
        <DependsOn task={task} allTasks={allTasks} />
      </Fact>
      <Fact label="Created">{created}</Fact>
    </dl>
  );
}

// ─── task-progress bar ───────────────────────────────────────────────────────

function stepGlyph(status: LifecycleStepStatus, index: number) {
  if (status === 'done') return <Icon name="check" className="size-3.5" />;
  if (status === 'failed') return <Icon name="close" className="size-3.5" />;
  return <span>{index + 1}</span>;
}

const STEP_LABEL_TONE: Record<LifecycleStepStatus, string> = {
  done: 'text-muted',
  current: 'text-accent',
  pending: 'text-faint',
  failed: 'text-fail',
};

// Status word for screen readers, since sighted status reads from colour + glyph.
const STEP_STATUS_LABEL: Record<LifecycleStepStatus, string> = {
  done: 'completed',
  current: 'in progress',
  pending: 'pending',
  failed: 'failed',
};

/** The full-width Task-progress bar: the six lifecycle nodes as a horizontal
 * stepper, each with its label stacked below so all six fit. Every Attempt's own
 * Steps collapse into the single Implementation node (see `taskLifecycle`). */
function TaskProgressBar({ state, attempts }: { state: Task['state']; attempts: AttemptSummary[] }) {
  const { steps } = taskLifecycle(state, attempts);
  return (
    <ol className="mb-6 mt-1 flex items-start border-y border-hairline py-4" aria-label="Task progress">
      {steps.map((step, i) => {
        const leftDone = i > 0 && steps[i - 1]?.status === 'done';
        const rightDone = step.status === 'done';
        return (
          <li
            key={step.key}
            aria-current={step.status === 'current' ? 'step' : undefined}
            className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center"
          >
            <div className="flex w-full items-center">
              <span className={`h-px flex-1 ${i === 0 ? 'invisible' : leftDone ? 'bg-merged' : 'bg-edge'}`} />
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold tabular-nums ${PHASE_NODE_STYLES[step.status]}`}
              >
                {stepGlyph(step.status, i)}
              </span>
              <span className={`h-px flex-1 ${i === steps.length - 1 ? 'invisible' : rightDone ? 'bg-merged' : 'bg-edge'}`} />
            </div>
            <span className={`text-[11px] leading-tight ${STEP_LABEL_TONE[step.status]}`}>
              {step.label}
              <span className="sr-only"> — {STEP_STATUS_LABEL[step.status]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ─── verification ────────────────────────────────────────────────────────────

const OUTCOME_TONE: Record<string, string> = {
  proceed: 'text-merged',
  block: 'text-fail',
  escalate: 'text-running',
};
const VERDICT_TONE: Record<string, string> = {
  pass: 'text-merged',
  fail: 'text-fail',
  inconclusive: 'text-running',
};

function mechanismName(mechanism: string, run: AttemptSummary): string {
  if (mechanism === 'critic') {
    const critic = Object.keys(run.usage?.models ?? {}).find((k) => /critic/i.test(k));
    const model = critic?.split('·')[1]?.trim();
    return model ? `Critic · ${model}` : 'Critic';
  }
  return mechanism.charAt(0).toUpperCase() + mechanism.slice(1);
}

/** The critic's own native session transcript (ADR-0040) — what it read, ran,
 * and reasoned to reach its verdict — lazily fetched on first expand. One per
 * critic attempt, so a self-heal back-and-forth surfaces every critic pass. */
function CriticSessionLog({ attemptId, label }: { attemptId: number; label: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [events, setEvents] = useState<AttemptLogEvent[]>([]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && state === 'idle') {
      setState('loading');
      api.criticLog(attemptId).then(
        (log) => {
          if (log.status === 'available' && log.events.length > 0) {
            setEvents(log.events);
            setState('ready');
          } else {
            setState('unavailable');
          }
        },
        () => setState('unavailable'),
      );
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[12px] font-medium text-muted transition-colors hover:text-ink"
      >
        <Icon name="chevron-down" className={`size-3 transition-transform ${open ? '' : '-rotate-90'}`} />
        {label}
      </button>
      {open && (
        <div className="mt-2">
          {state === 'loading' && <p className="text-[12px] text-muted">Loading critic session…</p>}
          {(state === 'unavailable' || (state === 'ready' && events.length === 0)) && (
            <p className="text-[12px] text-muted">Critic session log could not be loaded.</p>
          )}
          {state === 'ready' && events.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
              <TranscriptTimeline events={events} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** `only` narrows the block to a single mechanism — the Attempt panel's Verify
 * tab passes `'command'` and its Review tab `'critic'`, so each Step tab shows
 * just its own checks; unset renders the whole verification block (its header
 * and gate caption included). */
function Verification({ attempts, statuses, run, only }: { attempts: VerificationAttempt[]; statuses: VerifierStatus[]; run: AttemptSummary; only?: 'command' | 'critic' }) {
  const decision = overallDecision(attempts);
  const rows = verificationRows(statuses, attempts).filter(({ status }) => !only || status.mechanism === only);
  // Every critic attempt with a transcript, oldest first (the store lists in
  // seq order): a corrective-attempt back-and-forth records one critic
  // session per pass, and the operator needs to see all of them, not just the
  // latest (ADR-0040).
  const criticSessions = attempts.filter((a) => a.mechanism === 'critic' && a.hasTranscript);
  const hasPlanned = statuses.some((status) => status.state === 'planned');
  // The gate-on-pass caption: commands run in order, review (if in the plan)
  // gates on all of them passing (issue #345).
  const commandRow = rows.find(({ status }) => status.mechanism === 'command');
  const commandCount = commandRow?.status.commands?.length ?? 0;
  const reviewRow = rows.find(({ status }) => status.mechanism === 'critic');
  const reviewInPlan = reviewRow ? reviewRow.status.state !== 'disabled' : false;
  // "review gates on all commands passing" only reads true when commands exist;
  // with none it would be a vacuous sentence. A lone step needs no ordering line.
  const gateCaption =
    reviewInPlan && commandCount >= 1
      ? 'Runs top to bottom — review gates on all commands passing.'
      : commandCount + (reviewInPlan ? 1 : 0) >= 2
        ? 'Runs top to bottom.'
        : null;
  return (
    <div className="mt-2">
      {!only && (
        <div className="flex items-center">
          <span className={sectionCaps}>Verification</span>
          <span className={`ml-auto inline-flex items-center gap-1.5 text-[12.5px] font-semibold ${attempts.length > 0 ? OUTCOME_TONE[decision.outcome] ?? 'text-muted' : 'text-muted'}`}>
            <span className="size-2 rounded-full bg-current" />
            {attempts.length > 0 ? decision.outcome : hasPlanned ? 'planned' : 'not run'}
          </span>
        </div>
      )}
      {!only && gateCaption && <p className="mt-1 text-[12px] text-muted">{gateCaption}</p>}
      <div className="mt-3 flex flex-col gap-3">
        {rows.map(({ status, attempt }) => {
          // With no critic-session log to show, say *why* (driven by the #327
          // status): disabled / did-not-run / not-captured — not a bare blank.
          const criticReason =
            status.mechanism === 'critic' && criticSessions.length === 0
              ? criticUnavailableReason(status.state, !!attempt, false)
              : null;
          return (
          <div key={status.mechanism} className="flex items-start gap-3">
            <span
              className={`mt-px grid size-[18px] shrink-0 place-items-center rounded-md ${
                status.state === 'failed' || status.state === 'unrunnable'
                  ? 'bg-fail-tint text-fail'
                  : status.state === 'passed'
                    ? 'bg-merged-tint text-merged'
                    : 'bg-raised text-muted'
              }`}
            >
              {status.state === 'failed' ? (
                <span className="text-[11px] leading-none">✕</span>
              ) : status.state === 'unrunnable' ? (
                <span className="text-[11px] leading-none font-bold">!</span>
              ) : status.state === 'passed' ? (
                <Icon name="check" className="size-3" />
              ) : status.state === 'planned' ? (
                <span className="size-2 rounded-full border border-current" />
              ) : (
                <span className="text-[11px] leading-none">–</span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-[13px] font-semibold ${status.state === 'disabled' ? 'text-muted' : 'text-ink'}`}>{mechanismName(status.mechanism, run)}</div>
              <div
                className="mt-1 text-[13px] leading-[1.55] text-muted [&_code]:rounded-[5px] [&_code]:bg-raised [&_code]:px-[5px] [&_code]:py-px [&_code]:font-data [&_code]:text-[12px]"
              >
                {attempt ? (attempt.mechanism === 'critic' ? <Markdown source={attempt.summary} className="text-muted" /> : attempt.summary) : status.reason}
              </div>
              {status.commands && status.commands.length > 0 && (
                <ol className="mt-1 flex flex-col gap-0.5">
                  {status.commands.map((cmd, i) => (
                    <li key={i} className="text-[12px] text-muted">
                      <span className="mr-1.5 tabular-nums text-edge">{i + 1}.</span>
                      <code className="rounded-[5px] bg-raised px-[5px] py-px font-data text-[12px]">{cmd}</code>
                    </li>
                  ))}
                </ol>
              )}
              {status.mechanism === 'critic' && criticSessions.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {criticSessions.map((c, i) => (
                    <CriticSessionLog
                      key={c.id}
                      attemptId={c.id}
                      label={
                        criticSessions.length > 1
                          ? `Critic session ${i + 1} of ${criticSessions.length} · ${c.verdict}`
                          : 'Critic session'
                      }
                    />
                  ))}
                </div>
              )}
              {criticReason && <p className="mt-2 text-[12px] text-muted">{criticReason}</p>}
            </div>
            <span
              className={`shrink-0 text-[10px] font-bold uppercase tracking-[0.04em] ${attempt ? VERDICT_TONE[attempt.verdict] ?? 'text-muted' : 'text-muted'}`}
            >
              {status.state}
            </span>
          </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── session line ────────────────────────────────────────────────────────────

/** A compact session/cost caption for the selected Attempt: its harness session
 * id (or a cold-start note) and the cost this run. The per-model and
 * agent-vs-subagent token breakdown now lives in the Attempt's Stats block. */
function AttemptSession({ run, snapshot }: { run: AttemptSummary; snapshot: AttemptUsageEvent | undefined }) {
  // A live Attempt's settled cost is still null — read the `attempt_usage`
  // snapshot instead so the figure ticks as it runs.
  const runCost = run.state === 'running' ? snapshot?.cost ?? run.cost : run.cost;
  const cost = formatCost(runCost);
  return (
    <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 border-t border-hairline pt-3">
      <div className="flex items-baseline gap-2">
        <span className={sectionCaps}>Session</span>
        <span className="text-[13px] text-ink">
          {run.sessionId ? <span className="font-data text-[12.5px]">{run.sessionId}</span> : 'cold start · fresh session'}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={sectionCaps}>Cost · this run</span>
        <span className="text-[13px] tabular-nums text-ink">{cost ?? '—'}</span>
      </div>
    </div>
  );
}

// ─── steer ───────────────────────────────────────────────────────────────────

function SteerBox({ taskId }: { taskId: number }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      await api.steerTask(taskId, message);
      setText('');
    } catch (err) {
      toastError(err);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="mt-3.5">
      <div className="flex items-center gap-2.5 rounded-md border border-edge bg-field py-2 pl-3.5 pr-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Steer this run — send guidance to the live session…"
          aria-label="Steer this run"
          className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-faint"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || text.trim().length === 0}
          aria-label="Send"
          className="grid size-8 shrink-0 place-items-center rounded-sm bg-accent text-on-accent transition-colors hover:opacity-90 disabled:opacity-50"
        >
          <Icon name="send" className="size-[15px]" />
        </button>
      </div>
      <div className="mt-2 text-[11.5px] text-faint">
        Session is warm — a message resumes this run and continues from here.
      </div>
    </div>
  );
}

// ─── run header + pane ───────────────────────────────────────────────────────

/** `steps` is the owning Attempt's timeline (matched by `run.number` ===
 * `Attempt.number`) — the currently-running Step's type carries the pill
 * word for a live run (ADR-0001 Vocabulary; AttemptSummary/Phase are deleted concepts). */
function attemptPillState(run: AttemptSummary, steps: readonly Step[]): string {
  if (run.state === 'completed') return 'merged';
  if (run.state === 'running') return steps.find((step) => step.state === 'running')?.type ?? 'running';
  return run.state;
}

function AttemptHeader({ run, steps }: { run: AttemptSummary; steps: readonly Step[] }) {
  return (
    <div className="mx-0.5 mb-2.5 mt-4 flex items-center gap-2.5">
      <span className="text-[16.5px] font-bold leading-none tracking-[-0.01em]">Attempt {run.number}</span>
      <StatePill state={attemptPillState(run, steps)} />
      {run.number > 1 && (
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-faint">
          <Icon name="refresh" className="size-3.5" />
          continued Attempt {run.number - 1}
        </span>
      )}
    </div>
  );
}

function ChangesPane({
  task,
  attemptId,
  selectedFile,
  running,
}: {
  task: Task;
  attemptId: number | null;
  selectedFile: string;
  running: boolean;
}) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (attemptId == null) {
      setFiles([]);
      return;
    }
    let live = true;
    setFiles(null);
    setFailed(false);
    const load = () =>
      api.attemptDiffFiles(attemptId).then(
        ({ files }) => live && setFiles(files),
        () => live && setFailed(true),
      );
    load();
    // While the run is live the diff keeps growing — refresh so the hunks track
    // the agent's edits, matching the rail's live changed-file list.
    const timer = running ? window.setInterval(load, 2_000) : undefined;
    return () => {
      live = false;
      if (timer) window.clearInterval(timer);
    };
  }, [attemptId, running]);

  // A single changed file selected in the sidebar: its filename is the content
  // title, a ± summary and the full path sit beneath it, then the hunks. The
  // diff is the run-agnostic cumulative worktree diff (the latest Attempt's
  // worktree state), not tied to the Attempt the operator has open.
  if (selectedFile) {
    const file = (files ?? []).find((f) => f.path === selectedFile);
    return (
      <div>
        <div className="mx-0.5 mb-3 mt-4">
          <h2 className="text-[16.5px] font-bold leading-tight tracking-[-0.01em] text-ink">
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

  const add = (files ?? []).reduce((s, f) => s + f.additions, 0);
  const del = (files ?? []).reduce((s, f) => s + f.deletions, 0);
  const shown = files ?? [];

  return (
    <div>
      <div className="mx-0.5 mb-2.5 mt-4 flex flex-wrap items-center gap-2.5">
        <span className="text-[16.5px] font-bold leading-none tracking-[-0.01em]">Changes</span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5 font-data text-[12px] text-faint">
          <Icon name="branch" className="size-3.5" />
          <span>{task.branch}</span>
          <span className="text-edge">·</span>
          <span>{(files ?? []).length} files</span>
          {(add > 0 || del > 0) && (
            <span className="tabular-nums">
              <span className="text-merged">+{add}</span> <span className="text-fail">−{del}</span>
            </span>
          )}
        </span>
      </div>
      {files === null && !failed ? (
        <p className="text-muted">Loading diff…</p>
      ) : shown.length === 0 ? (
        <p className="text-muted">
          {failed || task.branch
            ? `No changed-file content available${selectedFile ? ` for ${selectedFile}` : ''}.`
            : 'This task has no worktree changes.'}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {shown.map((f) => (
            <DiffViewer key={f.path} file={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function NoRunsYet() {
  return (
    <EmptyState title="No runs yet" className="py-8">
      This task hasn't run yet.
    </EmptyState>
  );
}

function GuardrailAlert({ events }: { events: GuardrailEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {events.map((event) => {
        const { dimensionLabel, evidence } = describeGuardrailTrip(event);
        return (
          <div key={event.id} className="rounded-md bg-fail-tint px-3 py-2 text-small">
            <span className="font-semibold text-fail">Guardrail tripped — {dimensionLabel}</span>
            <div className="mt-0.5 text-ink">{evidence}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── navigation sidebar ──────────────────────────────────────────────────────

const NAV_DOT: Record<TimelineTone, string> = {
  running: 'bg-running-dot motion-safe:animate-dot-pulse',
  passed: 'bg-merged-dot',
  failed: 'bg-fail-dot',
  neutral: 'bg-edge',
};
const NAV_WORD: Record<TimelineTone, string> = {
  running: 'text-running',
  passed: 'text-merged',
  failed: 'text-fail',
  neutral: 'text-muted',
};

const NAV_SELECTED = 'border-await bg-await-tint';
const NAV_IDLE = 'border-transparent hover:bg-raised';

/** The Attempts list: one row per Attempt — `Attempt N` + a state dot + the
 * state word, no per-attempt Step breakdown. Selecting a row opens that Attempt
 * in the content panel. */
function AttemptsNav({
  attempts,
  maxAttempts,
  selectedNumber,
  onSelect,
}: {
  attempts: Attempt[];
  maxAttempts: number | null;
  selectedNumber: number | null;
  onSelect: (attempt: Attempt) => void;
}) {
  return (
    <section className="border-b border-hairline px-3.5 py-3.5" aria-label="Attempt history">
      <div className={railSectionHead}>
        Attempts <span className={railSectionCount}>{attempts.length}{maxAttempts !== null && ` / ${maxAttempts}`}</span>
      </div>
      {attempts.length === 0 ? (
        <p className="text-small text-muted">This ticket hasn't been attempted yet.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {attempts.map((attempt) => {
            const tone = attemptTone(attempt.state);
            const selected = attempt.number === selectedNumber;
            return (
              <li key={attempt.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(attempt)}
                  className={`flex min-h-11 w-full items-center gap-2.5 rounded-sm border px-2.5 py-2 text-left transition-colors ${selected ? NAV_SELECTED : NAV_IDLE}`}
                >
                  <span role="img" aria-label={attempt.state} className={`size-2 shrink-0 rounded-full ${NAV_DOT[tone]}`} />
                  <span className="text-data font-semibold text-ink">Attempt {attempt.number}</span>
                  <span className={`ml-auto text-label font-bold uppercase tracking-[0.03em] ${NAV_WORD[tone]}`}>{attempt.state}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** The lone Timeline entry: opens the Task's lifecycle stream in the content panel. */
function TimelineNav({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  return (
    <section className="border-b border-hairline px-3.5 py-3.5">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={`flex min-h-11 w-full items-center gap-2.5 rounded-sm border px-2.5 py-2 text-left transition-colors ${selected ? NAV_SELECTED : NAV_IDLE}`}
      >
        <Icon name="activity" className="size-3.5 shrink-0 text-muted" />
        <span className="text-data font-semibold text-ink">Timeline</span>
      </button>
    </section>
  );
}

// The Stats panel's token bars ride a neutral monochrome opacity ramp on the
// ink token — never state hues, so a "cached" segment can't pre-read as
// running/blocked (Two Voices) — and resolves in both themes. Billable I/O
// (input, then output) sits darkest; cache fades back.
const TOKEN_SEGMENTS = [
  { key: 'input' as const, label: 'input', fill: 'bg-ink' },
  { key: 'output' as const, label: 'output', fill: 'bg-ink/60' },
  { key: 'cachedIn' as const, label: 'cached in', fill: 'bg-ink/35' },
  { key: 'cachedOut' as const, label: 'cached out', fill: 'bg-ink/15' },
];

/** Donut palette for the per-model cost slices (mirrors StatsPage's ramp): the
 * teal accent for the largest, then the neutral ink→edge steps. */
const COST_DONUT_COLORS = [
  'var(--hm-accent)',
  'var(--hm-ink)',
  'var(--hm-muted)',
  'var(--hm-faint)',
  'var(--hm-edge-strong)',
];

const compactTokens = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** One model's stacked input/output/cached-in/cached-out bar, scaled so the
 * widest bar is the model with the most tokens. Values are shown beneath so the
 * magnitude is honest without a total-token scalar. */
function ModelTokenBar({ model, maxTotal }: { model: TaskModelStats; maxTotal: number }) {
  const total = modelTotal(model);
  const widthPct = maxTotal > 0 ? (total / maxTotal) * 100 : 0;
  const seg = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-data text-data font-semibold text-ink" title={model.model}>
          {model.model}
        </span>
        <span className="shrink-0 tabular-nums text-data text-muted">
          {compactTokens.format(model.input + model.output)} I/O
          {model.cost !== null && <span className="ml-2 font-semibold text-ink">{usd(model.cost)}</span>}
        </span>
      </div>
      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-raised"
        style={{ width: `${Math.max(4, widthPct)}%` }}
        aria-hidden="true"
      >
        {TOKEN_SEGMENTS.map((s) => (
          <span key={s.key} className={`h-full ${s.fill}`} style={{ width: `${seg(model[s.key])}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-label tabular-nums text-faint">
        {TOKEN_SEGMENTS.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-[2px] ${s.fill}`} aria-hidden="true" />
            {s.label} {model[s.key].toLocaleString()}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The default content-panel view (nothing selected): the whole-Task AI-usage
 * breakdown. Honest-numbers rule — no total-token scalar; the token magnitude
 * is surfaced only as the per-model bars and the donut proportions, and the
 * headline figures are billable I/O and cost. */
function StatsPanel({ stats }: { stats: TaskStats }) {
  if (stats.byModel.length === 0) {
    return (
      <EmptyState title="Stats" className="py-12">
        The Task's AI-usage breakdown will appear here once an Attempt has run.
      </EmptyState>
    );
  }
  const maxTotal = Math.max(...stats.byModel.map(modelTotal), 1);
  const { agentTokens, subagentTokens } = stats.agentVsSubagent;
  const agentTotal = agentTokens + subagentTokens;
  const agentSegments: DonutSegment[] = [
    { key: 'agent', label: 'Agent', value: agentTokens, valueLabel: compactTokens.format(agentTokens), color: 'var(--hm-ink)' },
    { key: 'subagent', label: 'Subagent', value: subagentTokens, valueLabel: compactTokens.format(subagentTokens), color: 'var(--hm-muted)' },
  ];
  const costSegments: DonutSegment[] = stats.costByModel.map((m, i) => ({
    key: m.model,
    label: m.model,
    value: m.cost,
    valueLabel: usd(m.cost),
    color: COST_DONUT_COLORS[i % COST_DONUT_COLORS.length]!,
  }));
  const costTotal = stats.costByModel.reduce((sum, m) => sum + m.cost, 0);

  return (
    <div className="flex flex-col gap-4 py-5">
      <section className={`${card} p-5`}>
        <h2 className="mb-4 text-title font-semibold">Tokens per model</h2>
        <div className="flex flex-col gap-4">
          {stats.byModel.map((m) => (
            <ModelTokenBar key={m.model} model={m} maxTotal={maxTotal} />
          ))}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className={`${card} p-5`}>
          <h2 className="mb-4 text-title font-semibold">Agent vs subagent</h2>
          {agentTotal > 0 ? (
            <Donut
              segments={agentSegments}
              total={agentTotal}
              totalDisplay={`${Math.round((subagentTokens / agentTotal) * 100)}%`}
              totalLabel="SUBAGENT"
              ariaLabel="Agent versus subagent token share"
            />
          ) : (
            <p className="text-muted">No per-agent breakdown for this Task.</p>
          )}
        </section>

        <section className={`${card} p-5`}>
          <h2 className="mb-4 text-title font-semibold">Cost by model</h2>
          {costSegments.length > 0 ? (
            <Donut
              segments={costSegments}
              total={costTotal}
              totalDisplay={usd(costTotal)}
              totalLabel="COST"
              ariaLabel="Cost by model"
            />
          ) : (
            <p className="text-muted">No priced usage yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}

/** The live-merged {usage, cost} each Attempt contributes to the Stats
 * breakdown: a running Attempt reads its `attempt_usage` firehose snapshot (its
 * settled row is still null), a finished one its persisted figures. */
function statsAttemptsOf(runs: AttemptSummary[], live: Map<number, AttemptUsageEvent>): StatsAttempt[] {
  return runs.map((r) => {
    const snapshot = r.state === 'running' ? live.get(r.id) : undefined;
    return { usage: snapshot?.usage ?? r.usage, cost: snapshot?.cost ?? r.cost };
  });
}

// ─── attempt panel ─────────────────────────────────────────────────────────────

/** The Attempt's Step tabs (one per Step type present). The active tab underlines
 * in the teal action voice; each tab carries a state dot rolled up from its
 * Steps. */
function StepTabsBar({ tabs, active, onSelect }: { tabs: StepTab[]; active: StepType; onSelect: (type: StepType) => void }) {
  return (
    <div role="tablist" aria-label="Attempt steps" className="mt-4 flex flex-wrap gap-1 border-b border-hairline">
      {tabs.map((tab) => {
        const selected = tab.type === active;
        const tone = stateTone(tab.state);
        return (
          <button
            key={tab.type}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onSelect(tab.type)}
            className={`-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors ${
              selected ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            <span role="img" aria-label={tab.state} className={`size-2 rounded-full ${NAV_DOT[tone]}`} />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** The Rebase Step's content: which base it rebased onto, its outcome, and any
 * verdict note (a conflict the rebase hit). */
function RebaseStatus({ step, baseBranch }: { step: Step; baseBranch: string | null }) {
  const tone = stateTone(step.state);
  return (
    <div className="mt-5 rounded-lg border border-hairline bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">
          Rebase onto <span className="font-data text-[12.5px]">{baseBranch ?? 'base'}</span>
        </span>
        <span className={`inline-flex items-center gap-1.5 text-[12px] font-semibold ${NAV_WORD[tone]}`}>
          <span className={`size-2 rounded-full ${NAV_DOT[tone]}`} />
          {step.state}
        </span>
      </div>
      {step.verdict && <p className="mt-2 whitespace-pre-wrap break-words text-[13px] text-muted">{step.verdict}</p>}
    </div>
  );
}

function PendingStep({ label }: { label: string }) {
  return (
    <EmptyState title={label} className="py-12">
      This step hasn't run yet.
    </EmptyState>
  );
}

/** The Attempt content panel: the Attempt header and session line, its own
 * per-model / agent-vs-subagent Stats (the #395 aggregation scoped to this one
 * Attempt), then the Step tabs whose selected tab shows that Step's content —
 * the chat transcript for Implementation, the command checks for Verify, the
 * critic for Review — a pending Step showing an empty placeholder. */
function AttemptPanel({
  run,
  attempt,
  snapshot,
  stats,
  events,
  logUnavailable,
  following,
  onToggleFollow,
  verificationAttempts,
  verifierStatuses,
  guardrailEvents,
  baseBranch,
}: {
  run: AttemptSummary;
  attempt: Attempt | undefined;
  snapshot: AttemptUsageEvent | undefined;
  stats: TaskStats;
  events: AttemptLogEvent[];
  logUnavailable: boolean;
  following: boolean;
  onToggleFollow: () => void;
  verificationAttempts: VerificationAttempt[];
  verifierStatuses: VerifierStatus[];
  guardrailEvents: GuardrailEvent[];
  baseBranch: string | null;
}) {
  const steps = attempt?.steps ?? [];
  const tabs = attemptStepTabs(steps);
  // Repair (rather than reset) the operator's tab pick as the run progresses: a
  // still-valid choice stands; otherwise fall back to the default tab. The panel
  // is remounted per Attempt (keyed on run id), so switching Attempts starts
  // fresh at the default.
  const [picked, setPicked] = useState<StepType | null>(null);
  const active = picked && tabs.some((tab) => tab.type === picked) ? picked : defaultStepTab(tabs);
  const activeTab = tabs.find((tab) => tab.type === active);

  return (
    <>
      <AttemptHeader run={run} steps={steps} />
      <AttemptSession run={run} snapshot={snapshot} />
      <StatsPanel stats={stats} />
      {activeTab && active ? (
        <>
          <StepTabsBar tabs={tabs} active={active} onSelect={setPicked} />
          {activeTab.pending ? (
            <PendingStep label={activeTab.label} />
          ) : active === 'rebase' ? (
            <RebaseStatus step={steps.find((s) => s.type === 'rebase')!} baseBranch={baseBranch} />
          ) : active === 'implementation' ? (
            <>
              <GuardrailAlert events={guardrailEvents} />
              <ChatTranscript
                events={events}
                unavailable={logUnavailable}
                following={following}
                onToggleFollow={onToggleFollow}
                steer={run.state === 'running' ? <SteerBox taskId={run.taskId} /> : undefined}
              />
            </>
          ) : active === 'verification' ? (
            <div className="mt-4">
              <Verification attempts={verificationAttempts} statuses={verifierStatuses} run={run} only="command" />
            </div>
          ) : (
            <div className="mt-4">
              <Verification attempts={verificationAttempts} statuses={verifierStatuses} run={run} only="critic" />
            </div>
          )}
        </>
      ) : (
        // A run with no recorded Steps yet — nothing to tab through, but its
        // transcript is still worth showing as it starts up.
        <ChatTranscript
          events={events}
          unavailable={logUnavailable}
          following={following}
          onToggleFollow={onToggleFollow}
          steer={run.state === 'running' ? <SteerBox taskId={run.taskId} /> : undefined}
        />
      )}
    </>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────

export function TicketPage({
  task,
  onEdit,
  onChanged,
  onClose,
  onOpenTask,
  error,
}: {
  task: Task;
  onEdit: (task: Task) => void;
  onChanged: () => void;
  onClose: () => void;
  onOpenTask: (taskId: number) => void;
  error?: string | null;
}) {
  const [runs, setRuns] = useState<AttemptSummary[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [maxAttempts, setMaxAttempts] = useState<number | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  // The sidebar selection driving the content panel: nothing (Stats), an
  // Attempt, a changed file, or the Timeline. `contentPanel` maps it to the
  // panel that renders.
  const [selection, setSelection] = useState<ContentSelection>({ kind: 'none' });
  const [events, setEvents] = useState<AttemptLogEvent[]>([]);
  const [logUnavailable, setLogUnavailable] = useState(false);
  const [guardrailEvents, setGuardrailEvents] = useState<GuardrailEvent[]>([]);
  const [verificationAttempts, setVerificationAttempts] = useState<VerificationAttempt[]>([]);
  const [verifierStatuses, setVerifierStatuses] = useState<VerifierStatus[]>([]);
  const [timelineEvents, setTimelineEvents] = useState<TicketTimelineEvent[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  // The full prompt/description lives on the item GET, not the lean list row the
  // Board/list pass in (ADR-0045). Fetch it here so the description renders the
  // whole body even once list rows drop the prompt; the live `task` prop still
  // drives everything state-related.
  const [detail, setDetail] = useState<Task | null>(null);
  const [liveUsage, setLiveUsage] = useState<Map<number, AttemptUsageEvent>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  // The worktree diffstat while a run is in flight. `task.stat` is only
  // snapshotted at settle, so the rail's changed-file list would be empty for
  // the whole run; poll the live diffstat instead so files appear as the agent
  // writes them, falling back to the settled `task.stat` once it merges.
  const [liveStat, setLiveStat] = useState<string | null>(null);

  // The AttemptSummary the selected Attempt owns (its log/verification/guardrail
  // streams key off this). Only an Attempt selection loads run-scoped data; the
  // Stats / Timeline / diff panels don't need it.
  const selectedRun = selection.kind === 'attempt' ? runForAttempt(runs, { number: selection.attemptNumber }) : null;
  const selectedRunId = selectedRun?.id ?? null;

  useEffect(() => {
    let live = true;
    api.tasks().then(({ tasks }) => live && setAllTasks(tasks), toastError);
    return () => {
      live = false;
    };
  }, [task.id]);

  useEffect(() => {
    let live = true;
    setDetail(null);
    api.task(task.id).then((full) => live && setDetail(full), toastError);
    return () => {
      live = false;
    };
  }, [task.id]);

  useEffect(() => {
    let live = true;
    const load = () =>
      api.taskTimeline(task.id).then(({ events: next }) => {
        if (live) setTimelineEvents(next);
      }, toastError);
    load();
    const unsubscribe = subscribe((msg) => {
      if ((msg.type === 'attempt_timeline_changed' && msg.taskId === task.id) || (msg.type === 'attempt_changed' && msg.run.taskId === task.id)) load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [task.id]);

  useEffect(() => {
    let live = true;
    Promise.all([api.config(), api.workspaces()]).then(([config, { workspaces }]) => {
      if (!live) return;
      const workspace = workspaces.find((workspace) => workspace.id === task.workspaceId);
      setMaxAttempts(workspace?.maxAttempts ?? config.maxAttempts);
      setWorkspaceName(workspace?.name ?? null);
    }, toastError);
    return () => {
      live = false;
    };
  }, [task.workspaceId]);

  useEffect(() => {
    let live = true;
    const load = () =>
      api.taskAttemptTimeline(task.id).then(({ attempts: next }) => {
        if (!live) return;
        setAttempts(next);
      }, toastError);
    load();
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'attempt_timeline_changed' && msg.taskId === task.id) {
        setAttempts(msg.attempts);
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [task.id]);

  useEffect(() => {
    let live = true;
    api.taskAttempts(task.id).then(({ attempts: list }) => {
      if (!live) return;
      setRuns(list);
    });
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'attempt_changed' && msg.run.taskId === task.id) {
        setRuns((current) => {
          const rest = current.filter((r) => r.id !== msg.run.id);
          return [...rest, msg.run].sort((a, b) => a.number - b.number);
        });
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [task.id]);

  // Live token/cost deltas for the in-flight AttemptSummary (the `attempt_usage` firehose, ~1s)
  // — `attempt_changed` only merges at Step transitions, so without this the metric
  // row holds the stale settled figures while the AttemptSummary is executing.
  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.type !== 'attempt_usage') return;
        setLiveUsage((prev) => new Map(prev).set(msg.attemptId, msg));
      }),
    [],
  );

  // Tick a 1s clock only while a AttemptSummary is live, so Elapsed advances in real time
  // without re-rendering the page once everything has settled.
  const anyRunning = runs.some((r) => r.state === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [anyRunning]);

  // Poll the live worktree diffstat while the latest run is in flight so the
  // rail's changed-file list fills as the agent edits, instead of staying empty
  // until settle. Idle → clear it and fall back to the settled `task.stat`.
  const latestAttemptId = runs[runs.length - 1]?.id ?? null;
  useEffect(() => {
    if (!anyRunning || latestAttemptId === null) {
      setLiveStat(null);
      return;
    }
    let live = true;
    const load = () =>
      api
        .attemptDiff(latestAttemptId)
        .then((d) => live && setLiveStat(d.stat))
        .catch(() => {});
    load();
    const timer = window.setInterval(load, 2_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [anyRunning, latestAttemptId]);

  useEffect(() => {
    if (selectedRunId === null) return;
    let live = true;
    let hydrated = false;
    const pending: AttemptLogEvent[] = [];
    let cursor = 0;
    setEvents([]);
    setLogUnavailable(false);
    // Subscribe before hydrating but deliberately skip the existing replay:
    // the REST snapshot already contains it, in a different id space. Events
    // arriving during hydration are buffered and cut over at its live cursor.
    const unsubscribe = subscribeAttemptLog({ attemptId: selectedRunId, after: () => cursor, onEvent: (event) => {
      cursor = Math.max(cursor, event.seq);
      if (!hydrated) {
        pending.push(event);
        return;
      }
      setEvents((current) => appendAttemptLogEvents({ current, additions: [event] }));
    } });
    api.attemptLog(selectedRunId).then(
      (log) => {
        if (!live) return;
        setLogUnavailable(log.status === 'unavailable');
        const hydratedEvents = appendAttemptLogEvents({
          current: log.status === 'available' ? log.events : [],
          additions: log.status === 'available' ? eventsAfterLiveCursor({ events: pending, liveCursor: log.liveCursor }) : pending,
        });
        cursor = Math.max(log.liveCursor, attemptLogCursor({ events: pending }));
        setEvents(hydratedEvents);
        hydrated = true;
      },
      (error: unknown) => {
        if (!live) return;
        const hydratedEvents = appendAttemptLogEvents({ current: [], additions: pending });
        cursor = attemptLogCursor({ events: pending });
        setEvents(hydratedEvents);
        hydrated = true;
        toastError(error);
      },
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (selectedRunId === null) {
      setGuardrailEvents([]);
      return;
    }
    let live = true;
    const load = () =>
      api.attemptGuardrailEvents(selectedRunId).then(({ guardrailEvents }) => live && setGuardrailEvents(guardrailEvents));
    load();
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'attempt_changed' && msg.run.id === selectedRunId) load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (selectedRunId === null) {
      setVerificationAttempts([]);
      setVerifierStatuses([]);
      return;
    }
    let live = true;
    const load = () =>
      api
        .attemptVerificationAttempts(selectedRunId)
        .then(({ verificationAttempts, verifierStatuses }) => {
          if (!live) return;
          setVerificationAttempts(verificationAttempts);
          setVerifierStatuses(verifierStatuses);
        });
    load();
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'attempt_changed' && msg.run.id === selectedRunId) load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [selectedRunId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // The follow/tail state shared by the Timeline and the Attempt transcript:
  // while engaged, a newly-appended event (either live stream) keeps the panel
  // pinned to the bottom. Releasing it — by scrolling up — frees the view.
  const [following, setFollowing] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !following) return;
    el.scrollTop = el.scrollHeight;
  }, [events, timelineEvents, following]);

  // Every selection change re-homes the panel to the top and releases the tail,
  // so a new Attempt, file, or the Timeline always starts from its beginning
  // rather than inheriting the previous content's scroll depth.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    setFollowing(false);
  }, [selection]);

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const latestRun = runs[runs.length - 1];
  const latestAttempt = attempts.at(-1) ?? null;
  const failureLabel = task.state === 'escalated' ? null : runFailureBannerLabel(latestRun, latestAttempt);
  const failure = failureLabel ? latestRun?.reason ?? null : null;
  // The escalation trigger — the reason this Task was handed to a human. Its
  // Accept / Reject / Close actions live in the pinned sidebar Actions block.
  const escalationReason =
    task.state === 'escalated'
      ? (latestAttempt?.escalationReason ?? task.escalationReason)?.replace(/^escalated to human:\s*/i, '') ?? null
      : null;
  const skipHolderId = parseSkipReasonTaskRef(task.skipReason);
  const gateModel = gateForAttempt({ task, runs, selectedAttemptId: selectedRunId });
  const panel = contentPanel(selection);
  const selectAttempt = (attempt: Attempt) => setSelection({ kind: 'attempt', attemptNumber: attempt.number });
  const selectRunById = (runId: number) => {
    const run = runs.find((r) => r.id === runId);
    if (run) setSelection({ kind: 'attempt', attemptNumber: run.number });
  };
  const selectedFile = selection.kind === 'file' ? selection.path : null;

  return (
    <div className="flex h-full flex-col">
      <CrumbBar
        crumbs={[
          { node: <span className="font-semibold text-ink">{workspaceName ?? '…'}</span>, onClick: onClose },
          ...(task.mapRef !== null
            ? [
                {
                  node: (
                    <span className="inline-flex items-center gap-[7px] text-tool">
                      <span className="rounded-[5px] bg-tool-tint px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.06em]">
                        Epic
                      </span>
                      <span className="font-data text-[12.5px]">epic/{task.mapRef}</span>
                    </span>
                  ),
                  onClick: onClose,
                },
              ]
            : []),
          { node: <span>{ticketIdentity(task.id, task.trackerRef)}</span> },
        ]}
      />

      {error && (
        <div role="alert" className="mx-6 mt-4 shrink-0 rounded-lg bg-fail-tint px-4 py-2 text-fail">
          {error}
        </div>
      )}

      {/* two-pane shell */}
      <div className="flex min-h-0 flex-1 overflow-hidden max-rail:flex-col max-rail:overflow-visible">
        <div
          id="main-content"
          ref={scrollRef}
          tabIndex={-1}
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = isAtLiveEdge({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
            setFollowing((prev) => (prev === near ? prev : near));
          }}
          className="min-w-0 flex-1 overflow-y-auto pb-10 focus:outline-none max-rail:overflow-visible"
        >
          <div className="px-[30px]">
            <div className="flex items-start gap-4 pb-1 pt-7">
              <h1 className="max-w-[680px] text-[26px] font-extrabold leading-[1.15] tracking-[-0.03em]">
                {cardTitle(task.summary)}
              </h1>
              <span className="mt-2.5">
                <StatePill state={task.state} />
              </span>
            </div>

            {/* Condensed two-column header: the description (with its Show more
                clamp) on the left, the metrics row above the Properties fact-list
                on the right. Stacks under the rail breakpoint. */}
            <div className="mt-3 flex gap-8 max-rail:flex-col max-rail:gap-3">
              <div className="min-w-0 flex-1">
                {/* The full prompt lives on the item GET (`detail`) or a WS-full
                    store task, never on a lean list row (issue #350). Until one
                    arrives, render nothing rather than the truncated `summary`,
                    which would flash through the markdown "Show more" body as if
                    it were the whole description. */}
                {(detail?.prompt ?? task.prompt) != null && (
                  <Description prompt={detail?.prompt ?? task.prompt ?? ''} />
                )}
              </div>
              <div className="w-[320px] shrink-0 max-rail:w-full">
                <Metrics task={task} runs={runs} live={liveUsage} now={now} />
                <Properties task={task} allTasks={allTasks} workspaceName={workspaceName} />
              </div>
            </div>

            <TaskProgressBar state={task.state} attempts={runs} />

            {verifiedSha(attempts) && (
              <p className="mb-4 -mt-2 text-small text-muted">
                verified <span className="font-data text-ink">{verifiedSha(attempts)}</span>
              </p>
            )}

            {task.skipReason && (
              <div className="mb-4 text-small text-muted">
                <span className={labelType}>Waiting to run</span> —{' '}
                {skipHolderId === null ? (
                  task.skipReason
                ) : (
                  (() => {
                    const marker = `task ${skipHolderId}`;
                    const [before, ...after] = task.skipReason.split(marker);
                    return (
                      <>
                        {before}
                        <button onClick={() => onOpenTask(skipHolderId)} className="text-accent hover:underline">
                          {marker}
                        </button>
                        {after.join(marker)}
                      </>
                    );
                  })()
                )}
              </div>
            )}
            {failure && (
              <div className="mb-4 rounded-md bg-fail-tint px-3 py-2 text-small">
                <span className="font-semibold text-fail">{failureLabel}</span>
                <div className="mt-0.5 whitespace-pre-wrap break-words text-ink">{failure}</div>
              </div>
            )}
            {task.state === 'escalated' && (
              <div className="mb-4 rounded-md bg-await-tint px-3 py-2 text-small">
                <span className="inline-flex items-center gap-1.5 font-semibold text-await">
                  <Icon name="alert-triangle" className="size-3.5" />
                  Escalated
                </span>
                {escalationReason && (
                  <div className="mt-0.5 whitespace-pre-wrap break-words text-ink">{escalationReason}</div>
                )}
              </div>
            )}

            {/* content panel: driven by the sidebar selection — Stats (default),
                an Attempt, a changed-file diff, or the Timeline. */}
            <div className="min-w-0 border-t border-hairline">
              {panel.kind === 'diff' ? (
                <ChangesPane task={task} attemptId={latestAttemptId} selectedFile={selectedFile ?? ''} running={anyRunning} />
              ) : panel.kind === 'timeline' ? (
                <LifecycleTimeline
                  events={timelineEvents}
                  following={following}
                  onToggleFollow={() => setFollowing((f) => !f)}
                />
              ) : panel.kind === 'attempt' ? (
                selectedRun ? (
                  <AttemptPanel
                    key={selectedRun.id}
                    run={selectedRun}
                    attempt={attempts.find((a) => a.number === selectedRun.number)}
                    snapshot={liveUsage.get(selectedRun.id)}
                    stats={taskStats(statsAttemptsOf([selectedRun], liveUsage))}
                    events={events}
                    logUnavailable={logUnavailable}
                    following={following}
                    onToggleFollow={() => setFollowing((f) => !f)}
                    verificationAttempts={verificationAttempts}
                    verifierStatuses={verifierStatuses}
                    guardrailEvents={guardrailEvents}
                    baseBranch={task.baseBranch}
                  />
                ) : (
                  <NoRunsYet />
                )
              ) : (
                <StatsPanel stats={taskStats(statsAttemptsOf(runs, liveUsage))} />
              )}
            </div>
          </div>
        </div>

        {/* right navigation sidebar */}
        <aside className="flex w-[326px] shrink-0 flex-col border-l border-hairline bg-surface max-rail:w-auto max-rail:border-l-0 max-rail:border-t">
          <div className="min-h-0 flex-1 overflow-y-auto max-rail:overflow-visible">
            <AttemptsNav
              attempts={attempts}
              maxAttempts={maxAttempts}
              selectedNumber={selection.kind === 'attempt' ? selection.attemptNumber : null}
              onSelect={selectAttempt}
            />
            <TimelineNav selected={selection.kind === 'timeline'} onSelect={() => setSelection({ kind: 'timeline' })} />
            <AttemptRail
              worktree={{
                branch: task.branch,
                baseBranch: task.baseBranch,
                isolationMode: task.isolationMode,
                stat: liveStat ?? task.stat,
              }}
              selectedFile={selectedFile}
              onSelectFile={(path) => setSelection({ kind: 'file', path })}
              onSelectChanges={() => setSelection({ kind: 'file', path: '' })}
            />
          </div>
          {/* Review Actions, pinned at the bottom with no section title — the
              buttons speak for themselves. Escalated Accept / Reject / Close ride
              the same block (TaskActions handles the escalated state). */}
          <Gate
            model={gateModel}
            task={task}
            verificationAttempts={verificationAttempts}
            onEdit={(t) => {
              onClose();
              onEdit(t);
            }}
            onChanged={onChanged}
            onGoToCurrent={selectRunById}
          />
        </aside>
      </div>
    </div>
  );
}
