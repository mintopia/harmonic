import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { formatCost } from '../cost';
import type { Attempt, Step, StepType, GuardrailEvent, AttemptSummary, AttemptLogEvent, AttemptUsageEvent, Task, TicketTimelineEvent, VerificationAttempt, VerifierStatus } from '../types';
import { EmptyState } from './EmptyState';
import { DiffViewer } from './DiffViewer';
import type { DiffFile } from '../types';
import { describeGuardrailTrip } from '../guardrail-trip-model';
import { parseSkipReasonTaskRef } from '../skip-reason-model';
import { changedFilesFromNumstat } from '../attempt-rail-model';
import { sumCosts } from '../activity-model';
import { Markdown } from './Markdown';
import { Icon } from './Icon';
import { subscribe } from '../ws';
import { gateForAttempt } from '../ticket-gate-model';
import { cardTitle } from '../board-sections-model';
import { AttemptRail } from './ticket/AttemptRail';
import { Gate } from './ticket/Gate';
import { CrumbBar } from './CrumbBar';
import { LifecycleTimeline } from './ticket/LifecycleTimeline';
import { MergeProgress } from './MergeProgress';
import { mergeStepsFromTimeline } from '../merge-progress-model.js';
import { attemptTone, runFailureBannerLabel, runForAttempt, stateTone, type TimelineTone } from '../attempt-timeline-model';
import { attemptStepTabs, contentPanel, defaultSelection, defaultStepTab, harnessLabel, taskLifecycle, taskStats, verificationOutputTail, type ContentSelection, type LifecycleStepKey, type LifecycleStepStatus, type StepTab, type TaskStats } from '../task-detail-model';
import { isAtLiveEdge } from '../follow-tail-model';
import { ChatTranscript } from './ticket/ChatTranscript';
import { btnPrimary, card, labelType, railSectionHead, railSectionCount, railNavButton, railNavSelected, railNavIdle, PHASE_NODE_STYLES, statePill, mergeStatusPill } from '../ui';
import { toastError } from '../toast';
import { ticketIdentity } from '../id-format.js';
import { splitPathTail } from '../path';
import { useLiveEffect } from '../useLiveEffect';
import { useScrollToPanel } from '../useScrollToPanel';
import { useTicketAttempts } from './useTicketAttempts';
import { useAttemptLogStream } from './useAttemptLogStream';
import { useAttemptVerification } from './useAttemptVerification';
import { useLiveUsage } from './useLiveUsage';
import { AttemptStats, AttemptSummaryCard, StatsPanel, statsAttemptsOf } from './ticket/StatsPanel';
import { CriticSessions, Verification } from './ticket/Verification';
import { Fact } from './Fact';
import { ResumeOffer } from './ResumeOffer';


const sectionCaps = 'text-label font-bold uppercase tracking-[0.1em] text-faint';

function humanState(state: string): string {
  return state.replace(/-/g, ' ');
}

function StatePill({ state }: { state: string }) {
  return <span className={statePill(state)}>{humanState(state)}</span>;
}


function descriptionBody(prompt: string): string {
  const title = cardTitle(prompt);
  let body = prompt.trimStart();
  if (body.startsWith(title)) body = body.slice(title.length);
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

/** The exact prompt a Step's work was driven by — the implementation prompt sent
 * to the harness, or the review prompt sent to the critic — verbatim and
 * monospaced, clamped when long. Distinct from {@link Description} (the ticket's
 * own body): this is what actually went to the agent. */
function PromptSent({ prompt, label = 'Prompt sent' }: { prompt: string; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const clampable = prompt.length > 320;
  return (
    <div className="mt-4 rounded-lg border border-hairline bg-surface p-4 shadow-card">
      <div className={`mb-2 ${sectionCaps}`}>{label}</div>
      <pre className={`overflow-x-auto whitespace-pre-wrap break-words font-data text-[12.5px] leading-[1.55] text-muted ${clampable && !expanded ? 'line-clamp-[8]' : ''}`}>
        {prompt}
      </pre>
      {clampable && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-[12.5px] font-semibold text-accent transition-colors hover:text-ink"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
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
  const items: Array<[string, ReactNode]> = [
    ['Cost', formatCost(cost) ?? '—'],
    ['Elapsed', runs.length ? fmtDur(elapsed) : '—'],
    ['Attempts', `${runs.length}`],
    ['Diff', diff],
  ];
  return (
    <div className="mb-[18px] flex flex-wrap gap-y-3 tabular-nums">
      {items.map(([k, v]) => (
        <div key={k} className="mr-5 min-w-0 border-r border-hairline pr-5 last:mr-0 last:border-r-0 last:pr-0">
          <div className="mb-[5px] text-[10px] font-bold uppercase tracking-[0.07em] text-faint">{k}</div>
          <div className="text-[16px] font-bold leading-none text-ink">{v}</div>
        </div>
      ))}
    </div>
  );
}


function DependsOn({ task, allTasks }: { task: Task; allTasks: Task[] }) {
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

function Properties({ task, allTasks, workspaceName }: { task: Task; allTasks: Task[]; workspaceName: string | null }) {
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


function stepGlyph(status: LifecycleStepStatus, index: number) {
  if (status === 'done') return <Icon name="check" className="size-3.5" />;
  if (status === 'failed') return <Icon name="close" className="size-3.5" />;
  return <span>{index + 1}</span>;
}

const STEP_LABEL_TONE: Record<LifecycleStepStatus, string> = {
  done: 'text-muted',
  current: 'text-accent',
  awaiting: 'text-await',
  pending: 'text-faint',
  failed: 'text-fail',
};

const STEP_STATUS_LABEL: Record<LifecycleStepStatus, string> = {
  done: 'completed',
  current: 'in progress',
  awaiting: 'awaiting review',
  pending: 'pending',
  failed: 'failed',
};

function stepCaption(key: LifecycleStepKey, status: LifecycleStepStatus, task: Task, attemptCount: number, disabled: boolean): string | null {
  switch (key) {
    case 'worktree':
      return task.branch ? splitPathTail(task.branch).tail : null;
    case 'implementation':
      return attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? '' : 's'}` : null;
    case 'merge':
      return status === 'awaiting' ? 'awaiting review' : null;
    case 'postMergeCheck':
      return disabled ? 'not configured' : 'revert on red';
    case 'closeIssue':
      return task.trackerRef != null ? `#${task.trackerRef}` : null;
    case 'retire':
      return 'cleanup';
  }
}

function TaskProgressBar({ task, attempts, commandConfigured }: { task: Task; attempts: AttemptSummary[]; commandConfigured: boolean }) {
  const { steps } = taskLifecycle(task.state, attempts, commandConfigured, task.mergeStatus);
  return (
    <div className="mb-6 mt-1">
      <div className={`mb-3 ${sectionCaps}`}>Task progress</div>
      <ol className={`${card} flex items-start px-[22px] py-5`} aria-label="Task progress">
        {steps.map((step, i) => {
          const leftDone = i > 0 && steps[i - 1]?.status === 'done' && !steps[i - 1]?.disabled;
          const rightDone = step.status === 'done' && !step.disabled;
          const caption = stepCaption(step.key, step.status, task, attempts.length, !!step.disabled);
          return (
            <li
              key={step.key}
              aria-current={step.status === 'current' || step.status === 'awaiting' ? 'step' : undefined}
              className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center"
            >
              <div className="flex w-full items-center">
                <span className={`h-0.5 flex-1 rounded ${i === 0 ? 'invisible' : leftDone ? 'bg-merged' : 'bg-edge'}`} />
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold tabular-nums ${PHASE_NODE_STYLES[step.status]} ${step.disabled ? 'opacity-60' : ''}`}
                >
                  {stepGlyph(step.status, i)}
                </span>
                <span className={`h-0.5 flex-1 rounded ${i === steps.length - 1 ? 'invisible' : rightDone ? 'bg-merged' : 'bg-edge'}`} />
              </div>
              <span className={`text-[12px] font-semibold leading-tight ${step.disabled ? 'text-faint' : STEP_LABEL_TONE[step.status]}`}>
                {step.label}
                <span className="sr-only"> — {step.disabled ? 'not configured' : STEP_STATUS_LABEL[step.status]}</span>
              </span>
              {caption && <span className="text-[10.5px] leading-tight text-faint">{caption}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}



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
          placeholder="Steer this attempt — send guidance to the live session…"
          aria-label="Steer this attempt"
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
        Session is warm — a message resumes this attempt and continues from here.
      </div>
    </div>
  );
}


function attemptPillState(run: AttemptSummary, steps: readonly Step[]): string {
  if (run.state === 'completed') return 'passed';
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
  useLiveEffect((live) => {
    if (attemptId == null) {
      setFiles([]);
      return;
    }
    setFiles(null);
    setFailed(false);
    const load = () =>
      api.attemptDiffFiles(attemptId).then(
        ({ files }) => live() && setFiles(files),
        () => live() && setFailed(true),
      );
    load();
    const timer = running ? window.setInterval(load, 2_000) : undefined;
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, [attemptId, running]);

  if (selectedFile) {
    const file = (files ?? []).find((f) => f.path === selectedFile);
    return (
      <div>
        <div className="mx-0.5 mb-3 mt-4">
          <h2 className="flex items-center gap-2 text-[16.5px] font-bold leading-tight tracking-[-0.01em] text-ink">
            {file && (
              <span
                className={`grid size-[18px] shrink-0 place-items-center rounded-[4px] font-data text-[10px] font-bold ${
                  file.deletions === 0 && file.additions > 0 ? 'bg-merged-tint text-merged' : 'bg-running-tint text-running'
                }`}
              >
                {file.deletions === 0 && file.additions > 0 ? 'A' : 'M'}
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
            {task.branch && (
              <>
                <span aria-hidden className="text-edge">·</span>
                <span>
                  worktree diff · {task.baseBranch ?? 'HEAD'}…{task.branch}
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

function NoRunsYet({ task, onChanged }: { task: Task; onChanged: () => void }) {
  return (
    <EmptyState
      title="No attempts yet"
      className="py-8"
      action={
        task.state === 'ready' ? (
          <button className={btnPrimary} onClick={() => api.runTask(task.id).then(onChanged, toastError)}>
            Run now
          </button>
        ) : undefined
      }
    >
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
                  className={`${railNavButton} ${selected ? railNavSelected : railNavIdle}`}
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

/** The whole-Task panels: Stats and the lifecycle Timeline. */
function PanelNav({ selected, onSelect }: { selected: 'stats' | 'timeline' | null; onSelect: (s: ContentSelection) => void }) {
  const entries = [
    { kind: 'stats', label: 'Stats', icon: 'stats' },
    { kind: 'timeline', label: 'Timeline', icon: 'activity' },
  ] as const;
  return (
    <section className="flex flex-col gap-1 border-b border-hairline px-3.5 py-3.5">
      {entries.map((entry) => (
        <button
          key={entry.kind}
          type="button"
          aria-pressed={selected === entry.kind}
          onClick={() => onSelect({ kind: entry.kind })}
          className={`${railNavButton} ${selected === entry.kind ? railNavSelected : railNavIdle}`}
        >
          <Icon name={entry.icon} className="size-3.5 shrink-0 text-muted" />
          <span className="text-data font-semibold text-ink">{entry.label}</span>
        </button>
      ))}
    </section>
  );
}


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
            {tab.state === 'passed' ? (
              <Icon name="check" className="size-3.5 text-merged" />
            ) : tab.state === 'failed' ? (
              <Icon name="close" className="size-3.5 text-fail" />
            ) : (
              <span role="img" aria-label={tab.state} className={`size-2 rounded-full ${NAV_DOT[tone]}`} />
            )}
            <span>
              {tab.label}
              {tab.detail && <span className="ml-1 font-normal text-faint">· {tab.detail}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

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
  primaryModel,
  agent,
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
  primaryModel: string;
  agent: string;
}) {
  const steps = attempt?.steps ?? [];
  const tabs = attemptStepTabs(steps, attempt?.verifierStatuses ?? verifierStatuses);
  const [picked, setPicked] = useState<StepType | null>(null);
  const active = picked && tabs.some((tab) => tab.type === picked) ? picked : defaultStepTab(tabs);
  const activeTab = tabs.find((tab) => tab.type === active);

  const topModel = stats.byModel[0]?.model ?? primaryModel;
  const chat = (
    <ChatTranscript
      events={events}
      unavailable={logUnavailable}
      following={following}
      onToggleFollow={onToggleFollow}
      steer={run.state === 'running' ? <SteerBox taskId={run.taskId} /> : undefined}
      model={topModel}
      agent={agent}
      stepLabel="Implementation"
    />
  );
  // The prompt the critic was actually driven with — the latest critic attempt's,
  // since re-verify turns share the operator prompt but differ by candidate OID.
  const reviewPrompt = verificationAttempts.filter((a) => a.mechanism === 'critic' && a.prompt).at(-1)?.prompt ?? null;
  const tabContent =
    activeTab && active ? (
      activeTab.pending ? (
        <PendingStep label={activeTab.label} />
      ) : active === 'rebase' ? (
        <RebaseStatus step={steps.find((s) => s.type === 'rebase')!} baseBranch={baseBranch} />
      ) : active === 'implementation' ? (
        <>
          <GuardrailAlert events={guardrailEvents} />
          {run.prompt && <PromptSent prompt={run.prompt} />}
          {chat}
        </>
      ) : active === 'verification' ? (
        <div className="mt-4">
          <Verification attempts={verificationAttempts} statuses={verifierStatuses} run={run} only="command" steps={steps} liveOutput={verificationOutputTail(events, 'command')} />
        </div>
      ) : (
        <div className="mt-4">
          {reviewPrompt && <PromptSent prompt={reviewPrompt} label="Review prompt sent" />}
          <Verification attempts={verificationAttempts} statuses={verifierStatuses} run={run} only="critic" steps={steps} criticAgent={agent} />
          <CriticSessions attempts={verificationAttempts} run={run} />
        </div>
      )
    ) : (
      chat
    );

  return (
    <>
      <AttemptHeader run={run} steps={steps} />
      {tabs.length > 0 && active && <StepTabsBar tabs={tabs} active={active} onSelect={setPicked} />}
      <AttemptSummaryCard run={run} snapshot={snapshot} model={topModel} toolCalls={stats.toolCalls} />
      <AttemptStats stats={stats} />
      {tabContent}
    </>
  );
}


export function TicketPage({
  task,
  onEdit,
  onChanged,
  onClose,
  onOpenTask,
  onOpenEpic,
  parentEpicRef = null,
  error,
  selection,
  onSelect,
}: {
  task: Task;
  onEdit: (task: Task) => void;
  onChanged: () => void;
  onClose: () => void;
  onOpenTask: (taskId: number) => void;
  /** Open this Ticket's parent Epic's summary page, from the crumb bar. */
  onOpenEpic?: (ref: number) => void;
  /** The Epic this Ticket belongs to, resolved by the caller from the derived
   * Epic model (rolls up nested containers to the top-level Epic); null when it
   * has none or its Epic isn't currently derived. */
  parentEpicRef?: number | null;
  error?: string | null;
  /** The rail selection — owned by the route so a refresh restores the panel. */
  selection: ContentSelection;
  onSelect: (selection: ContentSelection) => void;
}) {
  const { runs, attempts } = useTicketAttempts(task.id);
  const liveUsage = useLiveUsage();
  const [maxAttempts, setMaxAttempts] = useState<number | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [commandConfigured, setCommandConfigured] = useState(true);
  const [guardrailEvents, setGuardrailEvents] = useState<GuardrailEvent[]>([]);
  const [timelineEvents, setTimelineEvents] = useState<TicketTimelineEvent[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [detail, setDetail] = useState<Task | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [liveStat, setLiveStat] = useState<string | null>(null);

  // The AttemptSummary the selected Attempt owns (its log/verification/guardrail
  // streams key off this). Only an Attempt selection loads run-scoped data; the
  // Stats / Timeline / diff panels don't need it.
  // Nothing picked ⇒ the panel most relevant to the Task's state (a working
  // Task's live Attempt, an escalated one's latest, else Stats).
  const resolved = selection.kind === 'none' ? defaultSelection(task.state, runs) : selection;
  // The content panel: what a rail pick scrolls to.
  const contentRef = useRef<HTMLDivElement>(null);
  const selectedRun = resolved.kind === 'attempt' ? runForAttempt(runs, { number: resolved.attemptNumber }) : null;
  const selectedRunId = selectedRun?.id ?? null;

  const { events, logUnavailable } = useAttemptLogStream(selectedRunId);
  const { verificationAttempts, verifierStatuses } = useAttemptVerification(selectedRunId);

  useLiveEffect((live) => {
    api.tasks().then(({ tasks }) => live() && setAllTasks(tasks), toastError);
  }, [task.id]);

  useLiveEffect((live) => {
    setDetail(null);
    api.task(task.id).then((full) => live() && setDetail(full), toastError);
  }, [task.id]);

  useLiveEffect((live) => {
    const load = () =>
      api.taskTimeline(task.id).then(({ events: next }) => {
        if (live()) setTimelineEvents(next);
      }, toastError);
    load();
    const unsubscribe = subscribe((msg) => {
      if ((msg.type === 'attempt_timeline_changed' && msg.taskId === task.id) || (msg.type === 'attempt_changed' && msg.run.taskId === task.id)) load();
      // The full Task rides `task_changed`; apply it so state/escalationReason/mergeStatus update live without a refetch.
      if (msg.type === 'task_changed' && msg.task.id === task.id) setDetail(msg.task);
    }, load);
    return () => {
      unsubscribe();
    };
  }, [task.id]);

  useLiveEffect((live) => {
    Promise.all([api.config(), api.workspaces()]).then(([config, { workspaces }]) => {
      if (!live()) return;
      const workspace = workspaces.find((workspace) => workspace.id === task.workspaceId);
      setMaxAttempts(workspace?.maxAttempts ?? config.maxAttempts);
      setWorkspaceName(workspace?.name ?? null);
      setCommandConfigured((workspace?.verificationCommand ?? config.verify.commands).length > 0);
    }, toastError);
  }, [task.workspaceId]);

  const anyRunning = runs.some((r) => r.state === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [anyRunning]);

  const latestAttemptId = runs[runs.length - 1]?.id ?? null;
  useLiveEffect((live) => {
    if (!anyRunning || latestAttemptId === null) {
      setLiveStat(null);
      return;
    }
    const load = () =>
      api
        .attemptDiff(latestAttemptId)
        .then((d) => live() && setLiveStat(d.stat))
        .catch(() => {});
    load();
    const timer = window.setInterval(load, 2_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [anyRunning, latestAttemptId]);

  useLiveEffect((live) => {
    if (selectedRunId === null) {
      setGuardrailEvents([]);
      return;
    }
    const load = () =>
      api.attemptGuardrailEvents(selectedRunId).then(({ guardrailEvents }) => live() && setGuardrailEvents(guardrailEvents));
    load();
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'attempt_changed' && msg.run.id === selectedRunId) load();
    }, load);
    return () => {
      unsubscribe();
    };
  }, [selectedRunId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !following) return;
    el.scrollTop = el.scrollHeight;
  }, [events, timelineEvents, following]);

  // Every selection change releases the tail and re-homes the scroll: a rail
  // pick (or a deep link to a panel) lands on the content panel itself, so the
  // Attempt, file or Timeline the operator asked for is what they see; a fresh
  // open with nothing picked starts at the Ticket header.
  useScrollToPanel(scrollRef, contentRef, selection.kind !== 'none', selection);
  useEffect(() => {
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
  const escalationReason =
    task.state === 'escalated'
      ?
        (task.escalationReason ?? latestAttempt?.escalationReason)?.replace(/^escalated to human:\s*/i, '') ?? null
      : null;
  const skipHolderId = parseSkipReasonTaskRef(task.skipReason);
  const gateModel = gateForAttempt({ task, runs, selectedAttemptId: selectedRunId });
  const panel = contentPanel(resolved);
  const selectAttempt = (attempt: Attempt) => onSelect({ kind: 'attempt', attemptNumber: attempt.number });
  const selectRunById = (runId: number) => {
    const run = runs.find((r) => r.id === runId);
    if (run) onSelect({ kind: 'attempt', attemptNumber: run.number });
  };
  const selectedFile = resolved.kind === 'file' ? resolved.path : null;

  return (
    <div className="flex h-full flex-col">
      <CrumbBar
        crumbs={[
          { node: <span className="font-semibold text-ink">{workspaceName ?? '…'}</span>, onClick: onClose },
          ...((parentEpicRef ?? task.mapRef) !== null
            ? [
                {
                  node: (
                    <span className="inline-flex items-center gap-[7px] text-tool">
                      <span className="rounded-[5px] bg-tool-tint px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.06em]">
                        Epic
                      </span>
                      <span className="font-data text-[12.5px]">epic/{parentEpicRef ?? task.mapRef}</span>
                    </span>
                  ),
                  onClick: () => onOpenEpic?.((parentEpicRef ?? task.mapRef)!),
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

      <div className="flex min-h-0 flex-1 overflow-hidden max-rail:flex-col max-rail:overflow-visible">
        <main
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
              <span className="mt-2.5 flex items-center gap-1.5">
                <StatePill state={task.state} />
                {task.mergeStatus && (
                  <span className={mergeStatusPill(task.mergeStatus)}>{task.mergeStatus.replace(/-/g, ' ')}</span>
                )}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-11 max-rail:grid-cols-1 max-rail:gap-3">
              <div className="min-w-0">
                {(detail?.prompt ?? task.prompt) != null && (
                  <Description prompt={detail?.prompt ?? task.prompt ?? ''} />
                )}
              </div>
              <div className="min-w-0">
                <Metrics task={task} runs={runs} live={liveUsage} now={now} />
                <Properties task={task} allTasks={allTasks} workspaceName={workspaceName} />
              </div>
            </div>

            <TaskProgressBar task={task} attempts={runs} commandConfigured={commandConfigured} />

            <ResumeOffer taskId={task.id} />

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
                  {task.mergeStatus === 'resolving-conflicts' ? 'Resolving merge conflicts' : 'Escalated'}
                </span>
                {escalationReason && (
                  <div className="mt-0.5 whitespace-pre-wrap break-words text-ink">{escalationReason}</div>
                )}
              </div>
            )}

            {/* content panel: driven by the sidebar selection — Stats (default),
                an Attempt, a changed-file diff, or the Timeline. */}
            <div ref={contentRef} className="min-w-0 border-t border-hairline">
              {panel.kind === 'diff' ? (
                <ChangesPane task={task} attemptId={latestAttemptId} selectedFile={selectedFile ?? ''} running={anyRunning} />
              ) : panel.kind === 'timeline' ? (
                <>
                  <LifecycleTimeline
                    events={timelineEvents}
                    following={following}
                    onToggleFollow={() => setFollowing((f) => !f)}
                  />
                  {mergeStepsFromTimeline(timelineEvents).length > 0 && (
                    <div className="px-5 pb-6">
                      <MergeProgress steps={mergeStepsFromTimeline(timelineEvents)} />
                    </div>
                  )}
                </>
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
                    primaryModel={task.model}
                    agent={harnessLabel(task.harness)}
                  />
                ) : (
                  <NoRunsYet task={task} onChanged={onChanged} />
                )
              ) : (
                <StatsPanel stats={taskStats(statsAttemptsOf(runs, liveUsage))} />
              )}
            </div>
          </div>
        </main>

        <aside
          aria-label="Attempts, timeline and changed files"
          className="flex w-[326px] shrink-0 flex-col border-l border-hairline bg-surface max-rail:w-auto max-rail:border-l-0 max-rail:border-t"
        >
          <div className="min-h-0 flex-1 overflow-y-auto max-rail:overflow-visible">
            <AttemptsNav
              attempts={attempts}
              maxAttempts={maxAttempts}
              selectedNumber={resolved.kind === 'attempt' ? resolved.attemptNumber : null}
              onSelect={selectAttempt}
            />
            <PanelNav selected={resolved.kind === 'timeline' ? 'timeline' : resolved.kind === 'none' || resolved.kind === 'stats' ? 'stats' : null} onSelect={onSelect} />
            <AttemptRail
              worktree={{
                branch: task.branch,
                baseBranch: task.baseBranch,
                isolationMode: task.isolationMode,
                stat: liveStat ?? task.stat,
              }}
              selectedFile={selectedFile}
              onSelectFile={(path) => onSelect({ kind: 'file', path })}
              onSelectChanges={() => onSelect({ kind: 'changes' })}
              taskState={task.state}
            />
          </div>
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
