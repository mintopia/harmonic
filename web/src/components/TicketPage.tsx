import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { formatCost } from '../cost';
import type { Attempt, AttemptTask, Cost, GuardrailEvent, Run, RunLogEvent, RunUsageEvent, Task, VerificationAttempt } from '../types';
import { appendRunLogEvents, eventsAfterLiveCursor, runLogCursor } from '../run-log-stream-model';
import { EmptyState } from './EmptyState';
import { TranscriptTimeline } from './TranscriptTimeline';
import { DiffViewer } from './DiffViewer';
import type { DiffFile } from '../types';
import { describeGuardrailTrip } from '../guardrail-trip-model';
import { parseSkipReasonTaskRef } from '../skip-reason-model';
import { latestAttempts, overallDecision } from '../verification-attempts-model';
import { changedFilesFromStat } from '../run-rail-model';
import { sumCosts } from '../activity-model';
import { Markdown } from './Markdown';
import { Icon } from './Icon';
import { subscribe, subscribeRunLog } from '../ws';
import { gateForRun } from '../ticket-gate-model';
import { cardTitle } from '../board-sections-model';
import { RunRail } from './ticket/RunRail';
import { Gate } from './ticket/Gate';
import { CrumbBar } from './CrumbBar';
import { AttemptTimeline } from './ticket/AttemptTimeline';
import { TaskLog } from './ticket/TaskLog';
import { runForAttempt, verifiedSha } from '../attempt-timeline-model';
import { labelType } from '../ui';
import { toastError } from '../toast';
import { ticketIdentity } from '../id-format.js';

// ─── small shared bits ───────────────────────────────────────────────────────

const sectionCaps = 'text-label font-bold uppercase tracking-[0.1em] text-faint';

function MetaSep() {
  return <span aria-hidden className="text-edge">·</span>;
}

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

function Description({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);
  const body = descriptionBody(task.prompt);
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

type TokenUsage =
  | {
      totals?: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null } | null;
      models?: Record<string, { inputTokens?: number | null; outputTokens?: number | null; cacheReadTokens?: number | null }>;
    }
  | null
  | undefined;

function usageTokens(usage: TokenUsage): number {
  const t = usage?.totals;
  const fromTotals = t?.totalTokens ?? (t ? (t.inputTokens ?? 0) + (t.outputTokens ?? 0) : 0);
  if (fromTotals > 0) return fromTotals;
  // ACP harnesses report only the per-model breakdown — sum it as the fallback.
  return Object.values(usage?.models ?? {}).reduce(
    (s, m) => s + (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheReadTokens ?? 0),
    0,
  );
}

function Metrics({
  task,
  runs,
  live,
  now,
}: {
  task: Task;
  runs: Run[];
  live: Map<number, RunUsageEvent>;
  now: number;
}) {
  // A live Run reads its freshest `run_usage` snapshot; a settled Run its
  // persisted totals/cost — so Cost, Tokens, and Elapsed all tick as it runs.
  const usageFor = (r: Run): TokenUsage => (r.state === 'running' ? live.get(r.id)?.usage ?? r.usage : r.usage);
  const costFor = (r: Run) => (r.state === 'running' ? live.get(r.id)?.cost ?? r.cost : r.cost);
  const tokens = runs.reduce((s, r) => s + usageTokens(usageFor(r)), 0);
  const cost = sumCosts(runs.map(costFor)) ?? task.cost;
  // A finished Run contributes its settled span; a live Run its wall-clock so
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
    ['Tokens', fmtK(tokens)],
    ['Elapsed', runs.length ? fmtDur(elapsed) : '—'],
    ['Runs', `${runs.length}`],
    ['Diff', diff],
  ];
  return (
    <div className="mb-[18px] mt-0.5 flex flex-wrap gap-y-3 tabular-nums">
      {items.map(([k, v], i) => (
        <div
          key={k}
          className={`mr-[26px] pr-[26px] ${i < items.length - 1 ? 'border-r border-hairline' : ''}`}
        >
          <div className="mb-[5px] text-[10px] font-bold uppercase tracking-[0.07em] text-faint">{k}</div>
          <div className="text-[17px] font-bold leading-none text-ink">{v}</div>
        </div>
      ))}
    </div>
  );
}

// ─── meta facts line ─────────────────────────────────────────────────────────

function DependsOnFact({ task, allTasks }: { task: Task; allTasks: Task[] }) {
  if (task.dependsOn.length === 0) return null;
  return (
    <>
      <MetaSep />
      <span className="inline-flex items-center gap-1.5">
        <span className="text-faint">deps</span>
        <span className="inline-flex flex-wrap items-center gap-1.5 font-data text-faint">
          {task.dependsOn.map((id) => {
            const done = allTasks.find((t) => t.id === id)?.state === 'done';
            return (
              <span key={id} className={`inline-flex items-center gap-0.5 ${done ? 'text-merged' : ''}`}>
                {done && <Icon name="check" className="size-3" />}#{id}
              </span>
            );
          })}
        </span>
      </span>
    </>
  );
}

function NotifyFact({ taskId }: { taskId: number }) {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      api.channels(),
      fetch(`/api/tasks/${taskId}/channels`).then((r) => r.json()) as Promise<{ channelIds: number[] }>,
    ]).then(([c, t]) => {
      if (!live) return;
      setNames(t.channelIds.map((id) => c.channels.find((ch) => ch.id === id)?.name ?? `#${id}`));
    }, toastError);
    return () => {
      live = false;
    };
  }, [taskId]);
  if (!names || names.length === 0) return null;
  return (
    <>
      <MetaSep />
      <span className="inline-flex items-center gap-1.5">
        <span className="text-faint">notify</span>
        <span className="font-data text-faint">{names.join(' ')}</span>
      </span>
    </>
  );
}

function MetaLine({ task, allTasks }: { task: Task; allTasks: Task[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pb-5 pt-3 text-[12.5px] text-muted">
      <span>{task.origin}</span>
      <MetaSep />
      <span className="inline-flex items-center gap-1.5">
        <span className="text-faint">priority</span>
        {task.priority}
      </span>
      <MetaSep />
      <span className="inline-flex items-center gap-1.5">
        <span className="text-faint">agent</span>
        {task.harness.charAt(0).toUpperCase() + task.harness.slice(1)} <span className="font-data">{task.model}</span>
      </span>
      <DependsOnFact task={task} allTasks={allTasks} />
      <NotifyFact taskId={task.id} />
    </div>
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

function mechanismName(mechanism: string, run: Run): string {
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
  const [events, setEvents] = useState<RunLogEvent[]>([]);

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
            <p className="text-[12px] text-muted">Critic session log unavailable.</p>
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

function Verification({ attempts, run }: { attempts: VerificationAttempt[]; run: Run }) {
  if (attempts.length === 0) return null;
  const decision = overallDecision(attempts);
  const rows = latestAttempts(attempts);
  // Every critic attempt with a transcript, oldest first (the store lists in
  // seq order): a corrective-attempt back-and-forth records one critic
  // session per pass, and the operator needs to see all of them, not just the
  // latest (ADR-0040).
  const criticSessions = attempts.filter((a) => a.mechanism === 'critic' && a.hasTranscript);
  return (
    <div className="mt-2">
      <div className="flex items-center">
        <span className={sectionCaps}>Verification</span>
        <span className={`ml-auto inline-flex items-center gap-1.5 text-[12.5px] font-semibold ${OUTCOME_TONE[decision.outcome] ?? 'text-muted'}`}>
          <span className="size-2 rounded-full bg-current" />
          {decision.outcome}
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {rows.map((a) => (
          <div key={a.mechanism} className="flex items-start gap-3">
            <span
              className={`mt-px grid size-[18px] shrink-0 place-items-center rounded-md ${
                a.verdict === 'fail' ? 'bg-fail-tint text-fail' : 'bg-merged-tint text-merged'
              }`}
            >
              {a.verdict === 'fail' ? (
                <span className="text-[11px] leading-none">✕</span>
              ) : (
                <Icon name="check" className="size-3" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-ink">{mechanismName(a.mechanism, run)}</div>
              <div
                className="mt-1 text-[13px] leading-[1.55] text-muted [&_code]:rounded-[5px] [&_code]:bg-raised [&_code]:px-[5px] [&_code]:py-px [&_code]:font-data [&_code]:text-[12px]"
              >
                {a.mechanism === 'critic' ? <Markdown source={a.summary} className="text-muted" /> : a.summary}
              </div>
              {a.mechanism === 'critic' && criticSessions.length > 0 && (
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
            </div>
            <span
              className={`shrink-0 text-[10px] font-bold uppercase tracking-[0.04em] ${VERDICT_TONE[a.verdict] ?? 'text-muted'}`}
            >
              {a.mechanism === 'critic' ? decision.outcome : a.verdict}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── session + agents ────────────────────────────────────────────────────────

// Usage categories ride a neutral monochrome ramp, never state hues — an amber
// "write" or slate "cached" here would pre-read as running/blocked (Two Voices).
const U = { read: 'bg-ink', write: 'bg-muted', cached: 'bg-edge' } as const;

function Swatch({ tone, children }: { tone: keyof typeof U; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-2 rounded-[2px] ${U[tone]}`} />
      {children}
    </span>
  );
}

function agentCost(cost: Cost | null, key: string, model: string): string | null {
  const by = cost?.byModel ?? {};
  const n = by[key] ?? by[model] ?? null;
  return typeof n === 'number' ? `$${n.toFixed(2)}` : null;
}

function SessionAgents({ run, snapshot }: { run: Run; snapshot: RunUsageEvent | undefined }) {
  // While the Run is live its settled usage/cost are still null — read the
  // `run_usage` snapshot instead so the table fills as the agents work.
  const usage = run.state === 'running' ? snapshot?.usage ?? run.usage : run.usage;
  const runCost = run.state === 'running' ? snapshot?.cost ?? run.cost : run.cost;
  const models = usage?.models ?? {};
  const agents = Object.entries(models);
  const cost = formatCost(runCost);
  return (
    <div className="mt-[18px] border-t border-hairline pt-[15px]">
      <div className="mb-4 flex flex-wrap justify-between gap-x-10 gap-y-3">
        <div className="flex flex-col gap-1.5">
          <span className={sectionCaps}>Session</span>
          <span className="text-[13px] text-ink">
            {run.sessionId ? <span className="font-data text-[12.5px]">{run.sessionId}</span> : 'cold start · fresh session'}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 text-right">
          <span className={sectionCaps}>Cost · this run</span>
          <span className="text-[13px] tabular-nums text-ink">{cost ?? '—'}</span>
        </div>
      </div>

      {agents.length > 0 && (
        <div>
          <div className="flex items-center justify-between">
            <span className={sectionCaps}>
              Agents <span className="ml-1 rounded-full bg-raised px-[7px] text-[11px] font-bold normal-case tracking-normal text-muted">{agents.length}</span>
            </span>
            <span className="flex gap-3.5 text-[11px] text-faint">
              <Swatch tone="read">read</Swatch>
              <Swatch tone="write">write</Swatch>
              <Swatch tone="cached">cached</Swatch>
            </span>
          </div>
          <div className="mt-1">
            {agents.map(([key, u]) => {
              const parts = key.split('·').map((s) => s.trim());
              const role = parts[0] || key;
              const model = parts[1];
              const read = u.inputTokens ?? 0;
              const write = u.outputTokens ?? 0;
              const cached = u.cacheReadTokens ?? 0;
              const total = read + write + cached;
              const sub = Boolean(model) && role.toLowerCase() !== 'claude';
              const c = agentCost(runCost, key, model ?? key);
              return (
                <div
                  key={key}
                  className="grid grid-cols-[156px_1fr_64px] items-center gap-5 border-t border-hairline py-[13px] first:border-t-0 max-rail:grid-cols-[1fr_auto]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-ink">
                      {role || key}
                      {sub && (
                        <span className="rounded-[4px] bg-raised px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.05em] text-muted">
                          subagent
                        </span>
                      )}
                    </div>
                    {model && <div className="mt-[3px] font-data text-[11.5px] text-faint">{model}</div>}
                    {/* Bar is hidden at narrow; keep the token breakdown as text. */}
                    <div className="mt-1.5 hidden flex-wrap gap-3 text-[11px] tabular-nums text-faint max-rail:flex">
                      <Swatch tone="read">{fmtK(read)}</Swatch>
                      <Swatch tone="write">{fmtK(write)}</Swatch>
                      <Swatch tone="cached">{fmtK(cached)}</Swatch>
                      <span>{fmtK(total)} tok</span>
                    </div>
                  </div>
                  <div className="max-rail:hidden">
                    <div className="flex h-[7px] gap-0.5 overflow-hidden rounded-full">
                      <span className={U.read} style={{ flex: read || 1 }} />
                      <span className={U.write} style={{ flex: write || 1 }} />
                      <span className={U.cached} style={{ flex: cached || 1 }} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-[11px] tabular-nums text-faint">
                      <Swatch tone="read">{fmtK(read)}</Swatch>
                      <Swatch tone="write">{fmtK(write)}</Swatch>
                      <Swatch tone="cached">{fmtK(cached)}</Swatch>
                      <span className="ml-auto text-faint">{fmtK(total)} tok</span>
                    </div>
                  </div>
                  <div className="text-right text-[13px] font-semibold tabular-nums text-ink">{c ?? ''}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── transcript ──────────────────────────────────────────────────────────────

function Transcript({ events, unavailable }: { events: RunLogEvent[]; unavailable: boolean }) {
  return (
    <div className="mt-[18px]">
      <div className="mb-2.5 flex items-center gap-2">
        <span className={sectionCaps}>Transcript</span>
        {events.length > 0 && (
          <span className="rounded-full bg-raised px-[7px] text-[11px] font-bold text-muted">
            {events.length} event{events.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {unavailable || events.length === 0 ? (
        <p className="rounded-lg border border-hairline bg-surface px-4 py-6 text-center text-small text-muted shadow-card">
          No session transcript recorded for this run.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-hairline bg-surface shadow-card">
          <TranscriptTimeline events={events} />
        </div>
      )}
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

function runPillState(run: Run): string {
  if (run.state === 'completed') return 'merged';
  if (run.state === 'running') return run.phase === 'landing' ? 'merging' : (run.phase ?? 'running');
  return run.state;
}

function RunHeader({ run }: { run: Run }) {
  return (
    <div className="mx-0.5 mb-2.5 mt-4 flex items-center gap-2.5">
      <span className="text-[16.5px] font-bold leading-none tracking-[-0.01em]">Run {run.attempt}</span>
      <StatePill state={runPillState(run)} />
      {run.attempt > 1 && (
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-faint">
          <Icon name="refresh" className="size-3.5" />
          continued Run {run.attempt - 1}
        </span>
      )}
    </div>
  );
}

function ChangesPane({
  task,
  runId,
  selectedFile,
  running,
}: {
  task: Task;
  runId: number | null;
  selectedFile: string;
  running: boolean;
}) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (runId == null) {
      setFiles([]);
      return;
    }
    let live = true;
    setFiles(null);
    setFailed(false);
    const load = () =>
      api.runDiffFiles(runId).then(
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
  }, [runId, running]);

  const add = (files ?? []).reduce((s, f) => s + f.additions, 0);
  const del = (files ?? []).reduce((s, f) => s + f.deletions, 0);
  const shown = selectedFile ? (files ?? []).filter((f) => f.path === selectedFile) : files ?? [];

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

// ─── page ────────────────────────────────────────────────────────────────────

export function TicketPage({
  task,
  onEdit,
  onChanged,
  onClose,
  onOpenTask,
}: {
  task: Task;
  onEdit: (task: Task) => void;
  onChanged: () => void;
  onClose: () => void;
  onOpenTask: (taskId: number) => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [budgetBase, setBudgetBase] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [selectedAttemptId, setSelectedAttemptId] = useState<number | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [events, setEvents] = useState<RunLogEvent[]>([]);
  const [logUnavailable, setLogUnavailable] = useState(false);
  const [guardrailEvents, setGuardrailEvents] = useState<GuardrailEvent[]>([]);
  const [verificationAttempts, setVerificationAttempts] = useState<VerificationAttempt[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [liveUsage, setLiveUsage] = useState<Map<number, RunUsageEvent>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  // The worktree diffstat while a run is in flight. `task.stat` is only
  // snapshotted at settle, so the rail's changed-file list would be empty for
  // the whole run; poll the live diffstat instead so files appear as the agent
  // writes them, falling back to the settled `task.stat` once it lands.
  const [liveStat, setLiveStat] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.tasks().then(({ tasks }) => live && setAllTasks(tasks), toastError);
    return () => {
      live = false;
    };
  }, [task.id]);

  useEffect(() => {
    let live = true;
    Promise.all([api.config(), api.workspaces()]).then(([config, { workspaces }]) => {
      if (!live) return;
      setMaxAttempts(workspaces.find((workspace) => workspace.id === task.workspaceId)?.maxAttempts ?? config.maxAttempts);
    }, toastError);
    return () => {
      live = false;
    };
  }, [task.workspaceId]);

  useEffect(() => {
    let live = true;
    const load = () =>
      api.taskAttempts(task.id).then(({ attempts: next, budgetBase: base }) => {
        if (!live) return;
        setAttempts(next);
        setBudgetBase(base);
      }, toastError);
    load();
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'attempt_timeline_changed' && msg.taskId === task.id) {
        setAttempts(msg.attempts);
        setBudgetBase(msg.budgetBase);
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [task.id]);

  useEffect(() => {
    let live = true;
    api.taskRuns(task.id).then(({ runs }) => {
      if (!live) return;
      setRuns(runs);
      setSelectedRunId((current) => current ?? runs[runs.length - 1]?.id ?? null);
    });
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'run_changed' && msg.run.taskId === task.id) {
        setRuns((current) => {
          const rest = current.filter((r) => r.id !== msg.run.id);
          return [...rest, msg.run].sort((a, b) => a.attempt - b.attempt);
        });
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [task.id]);

  // Live token/cost deltas for the in-flight Run (the `run_usage` firehose, ~1s)
  // — `run_changed` only lands at phase edges, so without this the metric row
  // holds the stale settled figures while the Run is executing.
  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.type !== 'run_usage') return;
        setLiveUsage((prev) => new Map(prev).set(msg.runId, msg));
      }),
    [],
  );

  // Tick a 1s clock only while a Run is live, so Elapsed advances in real time
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
  const latestRunId = runs[runs.length - 1]?.id ?? null;
  useEffect(() => {
    if (!anyRunning || latestRunId === null) {
      setLiveStat(null);
      return;
    }
    let live = true;
    const load = () =>
      api
        .runDiff(latestRunId)
        .then((d) => live && setLiveStat(d.stat))
        .catch(() => {});
    load();
    const timer = window.setInterval(load, 2_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [anyRunning, latestRunId]);

  useEffect(() => {
    if (selectedRunId === null) return;
    let live = true;
    let hydrated = false;
    const pending: RunLogEvent[] = [];
    let cursor = 0;
    setEvents([]);
    setLogUnavailable(false);
    // Subscribe before hydrating but deliberately skip the existing replay:
    // the REST snapshot already contains it, in a different id space. Events
    // arriving during hydration are buffered and cut over at its live cursor.
    const unsubscribe = subscribeRunLog({ runId: selectedRunId, after: () => cursor, onEvent: (event) => {
      cursor = Math.max(cursor, event.seq);
      if (!hydrated) {
        pending.push(event);
        return;
      }
      setEvents((current) => appendRunLogEvents({ current, additions: [event] }));
    } });
    api.runLog(selectedRunId).then(
      (log) => {
        if (!live) return;
        setLogUnavailable(log.status === 'unavailable');
        const hydratedEvents = appendRunLogEvents({
          current: log.status === 'available' ? log.events : [],
          additions: log.status === 'available' ? eventsAfterLiveCursor({ events: pending, liveCursor: log.liveCursor }) : pending,
        });
        cursor = Math.max(log.liveCursor, runLogCursor({ events: pending }));
        setEvents(hydratedEvents);
        hydrated = true;
      },
      (error: unknown) => {
        if (!live) return;
        const hydratedEvents = appendRunLogEvents({ current: [], additions: pending });
        cursor = runLogCursor({ events: pending });
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
      api.runGuardrailEvents(selectedRunId).then(({ guardrailEvents }) => live && setGuardrailEvents(guardrailEvents));
    load();
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'run_changed' && msg.run.id === selectedRunId) load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (selectedRunId === null) {
      setVerificationAttempts([]);
      return;
    }
    let live = true;
    const load = () =>
      api
        .runVerificationAttempts(selectedRunId)
        .then(({ verificationAttempts }) => live && setVerificationAttempts(verificationAttempts));
    load();
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'run_changed' && msg.run.id === selectedRunId) load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [selectedRunId]);

  const selectedRun = runs.find((run) => run.id === selectedRunId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events]);

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const latestRun = runs[runs.length - 1];
  // Escalation is the timeline's own entry (its attempt carries the trigger and
  // the actions); only a plain failure still needs this banner.
  const failure = task.state !== 'escalated' && latestRun?.state === 'failed' && latestRun.reason ? latestRun.reason : null;
  const skipHolderId = parseSkipReasonTaskRef(task.skipReason);
  const gateModel = gateForRun({ task, runs, selectedRunId });
  const selectedTask = attempts.flatMap((attempt) => attempt.tasks).find((row) => row.id === selectedTaskId) ?? null;
  const selectRun = (runId: number | null) => {
    setSelectedFile(null);
    setSelectedAttemptId(null);
    setSelectedTaskId(null);
    setSelectedRunId(runId);
  };
  const selectAttempt = (attempt: Attempt) => {
    selectRun(runForAttempt(runs, attempt)?.id ?? selectedRunId);
    setSelectedAttemptId(attempt.id);
  };
  const timelineProps = {
    attempts,
    runs,
    task,
    maxAttempts,
    now,
    selectedRunId,
    selectedAttemptId,
    selectedTaskId,
    selectedFile,
    onChanged,
    onSelectAttempt: selectAttempt,
    onSelectTask: (attempt: Attempt, row: AttemptTask) => {
      selectAttempt(attempt);
      setSelectedTaskId(row.id);
    },
  };

  return (
    <div className="flex h-full flex-col">
      <CrumbBar
        crumbs={[
          { node: <span className="font-semibold text-ink">harmonic</span>, onClick: onClose },
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

      {/* two-pane shell */}
      <div className="flex min-h-0 flex-1 overflow-hidden max-rail:flex-col max-rail:overflow-visible">
        <div
          id="main-content"
          ref={scrollRef}
          tabIndex={-1}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="min-w-0 flex-1 overflow-y-auto pb-10 focus:outline-none max-rail:overflow-visible"
        >
          <div className="px-[30px]">
            <div className="flex items-start gap-4 pb-1 pt-7">
              <h1 className="max-w-[680px] text-[26px] font-extrabold leading-[1.15] tracking-[-0.03em]">
                {cardTitle(task.prompt)}
              </h1>
              <span className="mt-2.5">
                <StatePill state={task.state} />
              </span>
            </div>

            <Description task={task} />
            <Metrics task={task} runs={runs} live={liveUsage} now={now} />
            <MetaLine task={task} allTasks={allTasks} />

            <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-hairline py-3 text-small text-muted">
              <span><span className="font-semibold text-ink">Ticket flow</span> · {humanState(task.state)}</span>
              <MetaSep />
              {/* Position within the current budget: history numbering keeps counting across a Reject, the cap restarts. */}
              <span>Attempt {Math.max(0, (attempts.at(-1)?.number ?? 0) - budgetBase)} / {maxAttempts ?? '—'}</span>
              {verifiedSha(attempts) && <><MetaSep /><span>verified <span className="font-data text-ink">{verifiedSha(attempts)}</span></span></>}
            </div>

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
                <span className="font-semibold text-fail">Run failed</span>
                <div className="mt-0.5 whitespace-pre-wrap break-words text-ink">{failure}</div>
              </div>
            )}

            {/* Narrow: the rail stacks below the fold, so a sticky strip keeps
                attempt-switching reachable at the tool's core side-monitor width. */}
            <div className="sticky top-0 z-20 -mx-[30px] mb-1 border-y border-hairline bg-canvas px-[30px] py-2.5 rail:hidden">
              <AttemptTimeline {...timelineProps} layout="strip" />
            </div>

            {/* main pane: Run OR Changes, driven by the rail */}
            <div className="min-w-0 border-t border-hairline">
              {selectedFile !== null ? (
                <ChangesPane task={task} runId={selectedRunId} selectedFile={selectedFile} running={anyRunning} />
              ) : selectedRun ? (
                <>
                  <RunHeader run={selectedRun} />
                  {selectedTask && <TaskLog key={selectedTask.id} task={selectedTask} />}
                  <Verification attempts={verificationAttempts} run={selectedRun} />
                  <GuardrailAlert events={guardrailEvents} />
                  <SessionAgents run={selectedRun} snapshot={liveUsage.get(selectedRun.id)} />
                  <Transcript events={events} unavailable={logUnavailable} />
                  {selectedRun.state === 'running' && <SteerBox taskId={selectedRun.taskId} />}
                </>
              ) : (
                <NoRunsYet />
              )}
            </div>
          </div>
        </div>

        {/* right rail */}
        <aside className="flex w-[326px] shrink-0 flex-col border-l border-hairline bg-surface max-rail:w-auto max-rail:border-l-0 max-rail:border-t">
          <div className="min-h-0 flex-1 overflow-y-auto max-rail:overflow-visible">
            {/* At narrow widths the sticky strip in the main pane owns attempt-switching. */}
            <div className="max-rail:hidden">
              <AttemptTimeline {...timelineProps} />
            </div>
            <RunRail
              worktree={{
                branch: task.branch,
                baseBranch: task.baseBranch,
                isolationMode: task.isolationMode,
                stat: liveStat ?? task.stat,
              }}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
              onSelectChanges={() => setSelectedFile('')}
            />
          </div>
          {/* An escalated ticket has exactly the three actions on its timeline
              entry (ADR-0041); the gate would only duplicate and cover them. */}
          {task.state !== 'escalated' && (
            <Gate
              model={gateModel}
              task={task}
              verificationAttempts={verificationAttempts}
              onEdit={(t) => {
                onClose();
                onEdit(t);
              }}
              onChanged={onChanged}
              onGoToCurrent={selectRun}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
