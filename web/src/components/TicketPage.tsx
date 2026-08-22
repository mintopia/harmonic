import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { formatCost, formatCostByModel } from '../cost';
import type { GuardrailEvent, Run, RunLogEvent, Task, VerificationAttempt } from '../types';
import { EmptyState } from './EmptyState';
import { EventStream } from './EventStream';
import { coalesceEvents } from '../event-stream-model';
import { phaseTimelineFromEvents } from '../phase-timeline-model';
import { PhaseTimeline } from './PhaseTimeline';
import { describeGuardrailTrip } from '../guardrail-trip-model';
import { parseSkipReasonTaskRef } from '../skip-reason-model';
import { VerificationCard } from './VerificationCard';
import { Markdown } from './Markdown';
import { Icon } from './Icon';
import { subscribe } from '../ws';
import { gateForRun } from '../ticket-gate-model';
import { RunRail } from './ticket/RunRail';
import { Gate } from './ticket/Gate';
import { card, chip, displayTitle, labelType, sectionLabel, selectField, stateChip, touchTargetInline } from '../ui';
import { toastError } from '../toast';
import { taskKey, ticketIdentity } from '../id-format.js';

const metaChip = `${chip} bg-raised text-muted`;

function NoRunsYet() {
  return (
    <EmptyState title="No runs yet" className="py-8">
      This task hasn't run yet.
    </EmptyState>
  );
}

function Dependencies({ task }: { task: Task }) {
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [current, setCurrent] = useState<Task>(task);
  const [pick, setPick] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const editable = ['draft', 'ready', 'blocked'].includes(current.state);

  useEffect(() => {
    api.tasks().then(({ tasks }) => setAllTasks(tasks));
  }, [task.id]);

  const candidates = allTasks.filter(
    (t) => t.id !== task.id && !current.dependsOn.includes(t.id) && !['cancelled'].includes(t.state),
  );

  const act = (fn: () => Promise<Task>) => fn().then(setCurrent, toastError);

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${labelType} text-muted`}>Depends on</span>
        {current.dependsOn.length === 0 && <span className="text-muted">nothing</span>}
        {current.dependsOn.map((depId) => (
          <span key={depId} className={`flex items-center gap-1 ${metaChip} tabular-nums`}>
            {taskKey(depId)}
            {editable && (
              <button
                aria-label={`Remove dependency ${taskKey(depId)}`}
                className="text-muted hover:text-fail"
                onClick={() => act(() => api.removeDependency(task.id, depId))}
              >
                ✕
              </button>
            )}
          </span>
        ))}
        {editable && candidates.length > 0 && (
          <select
            aria-label="Add dependency"
            className={selectField}
            value={pick}
            onChange={(e) => {
              const id = Number(e.target.value);
              setPick('');
              if (id) act(() => api.addDependency(task.id, id));
            }}
          >
            <option value="">+ add…</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {taskKey(t.id)} {t.prompt.slice(0, 40)}
              </option>
            ))}
          </select>
        )}
        <div className="flex-1" />
        <span className={`${labelType} text-muted`}>Blocks</span>
        {current.dependents.length === 0 && <span className="text-muted">nothing</span>}
        {current.dependents.map((id) => (
          <span key={id} className={`${metaChip} tabular-nums`}>
            {taskKey(id)}
          </span>
        ))}
        {current.dependents.length > 0 && current.state !== 'completed' && (
          <button
            className={`rounded-md px-1.5 py-0.5 ${confirmCancel ? 'font-semibold text-fail' : 'text-muted hover:text-fail'}`}
            onClick={() => {
              if (confirmCancel) {
                setConfirmCancel(false);
                act(() => api.cancelTask(task.id, true));
              } else {
                setConfirmCancel(true);
              }
            }}
          >
            {confirmCancel ? 'Confirm — cancel with dependents' : 'Cancel with dependents'}
          </button>
        )}
      </div>
    </div>
  );
}

function NotifyOverrides({ taskId }: { taskId: number }) {
  const [channels, setChannels] = useState<{ id: number; name: string }[]>([]);
  const [attached, setAttached] = useState<number[]>([]);

  const load = () =>
    Promise.all([
      fetch('/api/channels').then((r) => r.json()) as Promise<{ channels: { id: number; name: string }[] }>,
      fetch(`/api/tasks/${taskId}/channels`).then((r) => r.json()) as Promise<{ channelIds: number[] }>,
    ]).then(([c, t]) => {
      setChannels(c.channels);
      setAttached(t.channelIds);
    });
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when taskId changes; `load` closes over taskId
  }, [taskId]);

  if (channels.length === 0) return null;
  const candidates = channels.filter((c) => !attached.includes(c.id));

  return (
    <div className="flex flex-wrap items-center gap-2 py-3">
      <span className={`${labelType} text-muted`}>Notify</span>
      {attached.map((id) => (
        <span key={id} className={`flex items-center gap-1 ${metaChip}`}>
          {channels.find((c) => c.id === id)?.name ?? `#${id}`}
          <button
            aria-label={`Stop routing to ${channels.find((c) => c.id === id)?.name ?? `channel #${id}`}`}
            className="text-muted hover:text-fail"
            onClick={() =>
              fetch(`/api/tasks/${taskId}/channels/${id}`, { method: 'DELETE' }).then(load)
            }
          >
            ✕
          </button>
        </span>
      ))}
      {attached.length === 0 && <span className="text-muted">channel defaults</span>}
      {candidates.length > 0 && (
        <select
          aria-label="Route notifications to channel"
          className={selectField}
          value=""
          onChange={(e) => {
            const channelId = Number(e.target.value);
            if (channelId)
              fetch(`/api/tasks/${taskId}/channels`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ channelId }),
              }).then(load);
          }}
        >
          <option value="">+ route to…</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function RunMeta({ run }: { run: Run }) {
  const totals = run.usage?.totals;
  const rows: Array<[string, ReactNode]> = [];
  // eslint-disable-next-line react/jsx-key -- rendered as a single <dd> child below, not a list item
  if (run.reason) rows.push(['reason', <span className="text-fail">{run.reason}</span>]);
  if (run.stopReason) rows.push(['stop', run.stopReason]);
  rows.push(['started', new Date(run.startedAt).toLocaleTimeString()]);
  if (run.finishedAt) rows.push(['finished', new Date(run.finishedAt).toLocaleTimeString()]);
  if (run.sessionId) {
    rows.push([
      'session',
      // eslint-disable-next-line react/jsx-key -- single <dd> child, not a list item
      <span className="font-mono text-small" title={run.sessionId}>
        {run.sessionId}
      </span>,
    ]);
  }
  if (totals) {
    rows.push([
      'tokens',
      `${totals.inputTokens?.toLocaleString() ?? '?'} in / ${totals.outputTokens?.toLocaleString() ?? '?'} out`,
    ]);
  }
  if (run.cost && formatCost(run.cost)) {
    rows.push([
      'cost',
      // eslint-disable-next-line react/jsx-key -- single <dd> child, not a list item
      <span title={formatCostByModel(run.cost)}>
        {formatCost(run.cost)}
        {Object.keys(run.cost.byModel).length > 1 ? ` (${formatCostByModel(run.cost)})` : ''}
      </span>,
    ]);
  }
  if (typeof totals?.aiUnits === 'number') {
    rows.push([
      'AI units',
      // eslint-disable-next-line react/jsx-key -- single <dd> child, not a list item
      <span title="Copilot AI Units — actual spend (separate from Cost)">{totals.aiUnits.toFixed(2)} AIU</span>,
    ]);
  }
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-small">
      {rows.map(([label, value], i) => (
        <Fragment key={i}>
          <dt className={`${labelType} text-muted`}>{label}</dt>
          <dd className="min-w-0 text-ink">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function GuardrailTrips({ events }: { events: GuardrailEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="mb-3 space-y-2">
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

function OutputTab({ run, events, unavailable }: { run: Run | undefined; events: RunLogEvent[]; unavailable: boolean }) {
  if (!run) return <NoRunsYet />;
  if (unavailable) return <p className="text-muted">Log unavailable.</p>;
  return (
    <div>
      <EventStream events={events} />
      {run.state === 'running' && <SteerBox taskId={run.taskId} />}
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
    <div className="mt-3 border-t border-hairline pt-3">
      <label htmlFor="steer-run-message" className={`${labelType} mb-1 block text-muted`}>
        Steer this run
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id="steer-run-message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="Redirect the agent — delivered at its next turn boundary…"
          className="min-w-0 flex-1 resize-none rounded-md border border-edge bg-field px-2 py-1 text-ink placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <button
          onClick={() => void send()}
          disabled={sending || text.trim().length === 0}
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-edge bg-surface px-3.5 py-2 font-medium text-ink transition-colors duration-150 hover:border-faint disabled:opacity-50"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function OutputSummary({ events }: { events: RunLogEvent[] }) {
  const messages = coalesceEvents(events)
    .filter((item): item is Extract<typeof item, { kind: 'text' }> => item.kind === 'text' && item.variant === 'message')
    .map((item) => item.text.trim())
    .filter(Boolean);
  if (messages.length === 0) return null;
  const tail = messages.slice(-3);
  return (
    <div className="py-3 first:pt-0">
      <div className={`${labelType} mb-1 text-muted`}>Latest output</div>
      <div className="space-y-2">
        {tail.map((text, i) => (
          <Markdown key={i} source={text} className="text-ink" />
        ))}
      </div>
    </div>
  );
}

function ChangesTab({ task }: { task: Task }) {
  if (!task.branch) return <p className="text-muted">This task has no worktree changes.</p>;
  return (
    <div className="space-y-2">
      <div className="font-data text-data text-tool">
        {task.branch} ← {task.baseBranch}
      </div>
      {task.stat ? (
        <pre className="overflow-x-auto rounded-md bg-field p-2 font-data text-data text-muted">{task.stat}</pre>
      ) : (
        <p className="text-muted">No changes on this branch.</p>
      )}
    </div>
  );
}

function DetailsTab({ task, run, events }: { task: Task; run: Run | undefined; events: RunLogEvent[] }) {
  return (
    <div className="flex flex-col">
      <div className="mt-6">
        <div className={`${sectionLabel} mb-2`}>Prompt sent</div>
        {run?.prompt ? (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-field p-3 text-body text-ink tabular-nums">
            {run.prompt}
          </pre>
        ) : (
          <p className="text-muted">
            {run?.state === 'running' ? 'Prompt is sent as the run starts…' : 'No prompt recorded for this run.'}
          </p>
        )}
      </div>
      <OutputSummary events={events} />
      {run?.reviewFeedback && (
        <div className="py-3 first:pt-0">
          <div className={`${labelType} mb-1 text-muted`}>
            {run.review === 'rejected' ? 'Rejection feedback' : 'Review feedback'}
          </div>
          <p className="whitespace-pre-wrap text-ink">{run.reviewFeedback}</p>
        </div>
      )}
      {task.feedback && (
        <div className="py-3">
          <div className={`${labelType} mb-1 text-muted`}>Feedback carried into this re-attempt</div>
          <p className="whitespace-pre-wrap text-ink">{task.feedback}</p>
        </div>
      )}
      <Dependencies task={task} />
      <NotifyOverrides taskId={task.id} />
    </div>
  );
}

function MetaFact({ k, children }: { k?: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {k && <span className="text-faint">{k}</span>}
      {children}
    </span>
  );
}

function MetaSep() {
  return <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-edge" />;
}

function DependsOnFact({ task }: { task: Task }) {
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  useEffect(() => {
    let live = true;
    api.tasks().then(({ tasks }) => live && setAllTasks(tasks));
    return () => {
      live = false;
    };
  }, [task.id]);
  if (task.dependsOn.length === 0) return null;
  return (
    <>
      <MetaSep />
      <MetaFact k="depends on">
        <span className="inline-flex flex-wrap items-center gap-2">
          {task.dependsOn.map((depId) => {
            const satisfied = allTasks.find((t) => t.id === depId)?.state === 'completed';
            return (
              <span key={depId} className={`inline-flex items-center gap-1 ${satisfied ? 'text-merged' : ''}`}>
                {satisfied && <Icon name="check" className="size-3" />}
                {depId}
              </span>
            );
          })}
        </span>
      </MetaFact>
    </>
  );
}

function NotifyFact({ taskId }: { taskId: number }) {
  const [channels, setChannels] = useState<{ id: number; name: string }[]>([]);
  const [attached, setAttached] = useState<number[]>([]);
  useEffect(() => {
    let live = true;
    Promise.all([api.channels(), fetch(`/api/tasks/${taskId}/channels`).then((r) => r.json()) as Promise<{ channelIds: number[] }>]).then(
      ([c, t]) => {
        if (!live) return;
        setChannels(c.channels);
        setAttached(t.channelIds);
      },
    );
    return () => {
      live = false;
    };
  }, [taskId]);
  if (channels.length === 0) return null;
  const names = attached.map((id) => channels.find((c) => c.id === id)?.name ?? `#${id}`);
  return (
    <>
      <MetaSep />
      <MetaFact k="notify">{names.length > 0 ? names.join(', ') : 'channel defaults'}</MetaFact>
    </>
  );
}

function Brief({ task }: { task: Task }) {
  return (
    <div className={`${card} mt-[15px] px-4 py-3 text-small leading-relaxed text-muted`}>
      <div className={`${labelType} mb-1.5 block text-faint`}>Brief</div>
      {task.origin === 'mirrored' ? (
        <Markdown source={task.prompt} className="text-ink" />
      ) : (
        <p className="whitespace-pre-wrap text-ink">{task.prompt}</p>
      )}
      {(task.reattemptOf !== null || task.reattempts.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-small tabular-nums text-muted">
          {task.reattemptOf !== null && <span>↻ re-attempt of {taskKey(task.reattemptOf)}</span>}
          {task.reattempts.length > 0 && (
            <span>re-attempted as {task.reattempts.map((id) => taskKey(id)).join(', ')}</span>
          )}
        </div>
      )}
    </div>
  );
}

function RunBanner({ run, nextRun }: { run: Run; nextRun: Run | undefined }) {
  if (run.review === 'rejected') {
    return (
      <div className="mb-[18px] rounded-lg bg-running-tint px-3.5 py-3 text-small text-running">
        <b className="font-bold">Rejected</b>
        {run.reviewFeedback ? <> — reviewer feedback: “{run.reviewFeedback}”</> : ' — no feedback recorded.'}
        {nextRun && run.reviewFeedback && (
          <div className="mt-0.5 text-muted">
            Feedback carried into Run {nextRun.attempt}: “{run.reviewFeedback}”
          </div>
        )}
      </div>
    );
  }
  if (run.state === 'failed') {
    return (
      <div className="mb-[18px] rounded-lg bg-fail-tint px-3.5 py-3 text-small text-fail">
        <b className="font-bold">Failed</b>
        {run.reason ? <> — {run.reason}</> : ''}
        {nextRun && <> Auto-retried as Run {nextRun.attempt}.</>}
      </div>
    );
  }
  return null;
}

function formatMetricTokens(run: Run | undefined): string {
  const totals = run?.usage?.totals;
  if (!totals) return '—';
  const total = totals.totalTokens ?? (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0);
  return total ? total.toLocaleString() : '—';
}

function FlatMetrics({ task, runs, selectedRun }: { task: Task; runs: Run[]; selectedRun: Run | undefined }) {
  const elapsed = selectedRun?.finishedAt
    ? `${Math.max(0, Math.round((selectedRun.finishedAt - selectedRun.startedAt) / 1000))}s`
    : selectedRun
      ? 'running'
      : '—';
  const metrics = [
    ['Cost', formatCost(task.cost) ?? '—'],
    ['Tokens', formatMetricTokens(selectedRun)],
    ['Elapsed', elapsed],
    ['Runs', `${runs.length}`],
    ['Diff', task.stat ? 'changed' : '—'],
  ];
  return (
    <dl className="mt-4 flex flex-wrap border-y border-hairline text-small tabular-nums">
      {metrics.map(([label, value]) => (
        <div key={label} className="min-w-24 border-r border-hairline px-3 py-2 first:pl-0 last:border-r-0">
          <dt className={labelType}>{label}</dt>
          <dd className="mt-0.5 font-medium text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AgentUsageTable({ run }: { run: Run }) {
  const agents = run.usage?.models ?? {};
  const entries = Object.entries(agents);
  if (entries.length === 0) return null;
  return (
    <section className="mt-6">
      <h2 className={`${sectionLabel} mb-2`}>Per-agent usage</h2>
      <div className="overflow-x-auto border-y border-hairline">
        <table className="w-full text-left text-small">
          <thead className="border-b border-hairline text-label font-semibold uppercase text-muted">
            <tr><th className="py-2 pr-3">Agent</th><th className="py-2 pr-3">Read</th><th className="py-2 pr-3">Write</th><th className="py-2">Cached</th></tr>
          </thead>
          <tbody>
            {entries.map(([agent, usage]) => (
              <tr key={agent} className="border-b border-hairline last:border-0">
                <th scope="row" className="py-2 pr-3 font-medium text-ink">{agent}</th>
                <td className="py-2 pr-3 tabular-nums">{(usage.inputTokens ?? 0).toLocaleString()}</td>
                <td className="py-2 pr-3 tabular-nums">{(usage.outputTokens ?? 0).toLocaleString()}</td>
                <td className="py-2 tabular-nums">{(usage.cacheReadTokens ?? 0).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

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
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [events, setEvents] = useState<RunLogEvent[]>([]);
  const [logUnavailable, setLogUnavailable] = useState(false);
  const [guardrailEvents, setGuardrailEvents] = useState<GuardrailEvent[]>([]);
  const [verificationAttempts, setVerificationAttempts] = useState<VerificationAttempt[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

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

  useEffect(() => {
    if (selectedRunId === null) return;
    let live = true;
    // The native JSONL is the output source of truth. Polling also makes a
    // live transcript advance without reading the retired run_events stream.
    setEvents([]);
    setLogUnavailable(false);
    const load = () =>
      api.runLog(selectedRunId).then((log) => {
        if (!live) return;
        setLogUnavailable(log.status === 'unavailable');
        setEvents(log.status === 'available' ? log.events : []);
      });
    load();
    const interval = window.setInterval(load, 1_000);
    return () => {
      live = false;
      window.clearInterval(interval);
    };
  }, [selectedRunId]);

  // Guardrail-trip log for the selected run (issue #171): REST replay, then a
  // WS-triggered refetch (no per-trip firehose event, unlike run_event) —
  // `run_changed` for this run is the signal something on it may have changed.
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

  const selectedRun = runs.find((r) => r.id === selectedRunId);
  const phaseSteps = selectedRun ? phaseTimelineFromEvents([], selectedRun.phase, selectedRun.state) : null;

  // Keep the Output panel pinned to the newest event as it streams — but only
  // while the operator is already at the bottom, so we never yank them up
  // mid-read. `stickToBottom` is tracked by the page's own scroll region
  // below (unlike the old modal, the whole page scrolls as one — there's no
  // separate fixed-height tab-panel viewport any more).
  //
  // Starts `false`, not `true`: because the whole page scrolls as one, pinning
  // on the very first render would slam the page from the ticket header down to
  // the tail of the output the instant a ticket opens — a jarring jump. Opening
  // should land on the header; following resumes the moment the operator scrolls
  // to the bottom themselves (the `onScroll` handler below re-arms it).
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

  // Surface why a Task failed or Escalated up top — the reason lives on the
  // latest Run (task-level: independent of whichever Run the operator has
  // currently selected below).
  const latestRun = runs[runs.length - 1];
  const alert =
    (task.escalated || latestRun?.state === 'failed') && latestRun?.reason
      ? { escalated: task.escalated, text: latestRun.reason.replace(/^escalated to human:\s*/i, '') }
      : null;

  const skipHolderId = parseSkipReasonTaskRef(task.skipReason);

  const nextRun = selectedRun ? runs.find((r) => r.attempt === selectedRun.attempt + 1) : undefined;

  const gateModel = gateForRun({ task, runs, selectedRunId });

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-[4] flex shrink-0 items-center gap-2.5 border-b border-hairline bg-shell px-6 py-2.5">
        <button
          type="button"
          onClick={onClose}
          className={`${touchTargetInline} gap-1.5 rounded-md border border-edge bg-surface px-2.5 font-medium text-muted transition-colors duration-150 hover:border-faint hover:text-ink`}
        >
          <Icon name="arrow-left" />
          Deck
        </button>
        <span className="text-small text-faint">
          <b className="font-medium text-muted">harmonic</b>
          {task.mapRef !== null && <> / Epic <span className="font-data text-data text-tool">epic/{task.mapRef}</span></>}
          {' / '}{ticketIdentity(task.id, task.trackerRef)}
        </span>
      </div>

      <div
        id="main-content"
        ref={scrollRef}
        tabIndex={-1}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto focus:outline-none focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <div className="mx-auto w-full max-w-[1120px] px-6">
          <div className="pb-1 pt-[22px]">
            <div className="flex items-start gap-3">
              <h1 className={`${displayTitle} line-clamp-2 min-w-0`}>{task.prompt}</h1>
              <span className={`${stateChip(task.state)} mt-1 shrink-0`}>{task.state}</span>
            </div>
            <div className="mt-[13px] flex flex-wrap items-center gap-2.5 text-small text-muted">
              <span>{task.origin}</span>
              <MetaSep />
              <MetaFact k="priority">{task.priority}</MetaFact>
              <MetaSep />
              <MetaFact k="isolation">{task.isolationMode}</MetaFact>
              {task.baseBranch && (
                <>
                  <MetaSep />
                  <MetaFact k="base">
                    <span className="font-data text-data text-tool">{task.baseBranch}</span>
                  </MetaFact>
                </>
              )}
              <DependsOnFact task={task} />
              <NotifyFact taskId={task.id} />
            </div>
            <FlatMetrics task={task} runs={runs} selectedRun={selectedRun} />
            <Brief task={task} />
            {task.skipReason && (
              <div className="mt-2 text-small text-muted">
                <span className={labelType}>Waiting to run</span> —{' '}
                {skipHolderId === null
                  ? task.skipReason
                  : (() => {
                      const marker = `task ${skipHolderId}`;
                      const [before, ...after] = task.skipReason.split(marker);
                      return (
                        <>
                          {before}
                          <button
                            onClick={() => onOpenTask(skipHolderId)}
                            className={`${touchTargetInline} text-accent hover:underline`}
                          >
                            {marker}
                          </button>
                          {after.join(marker)}
                        </>
                      );
                    })()}
              </div>
            )}
            {alert && (
              <div
                className={`mt-2 rounded-md px-3 py-2 text-small ${alert.escalated ? 'bg-running-tint' : 'bg-fail-tint'}`}
              >
                <span className={`font-semibold ${alert.escalated ? 'text-running' : 'text-fail'}`}>
                  {alert.escalated ? 'Escalated to you' : 'Run failed'}
                </span>
                {alert.escalated && <span className="text-muted"> — auto-drive stopped and handed this back</span>}
                <div className="mt-0.5 whitespace-pre-wrap break-words text-ink">{alert.text}</div>
              </div>
            )}
          </div>

          <div className="mt-6 grid min-h-[520px] grid-cols-[minmax(0,1fr)_300px] gap-6 pb-8 max-rail:grid-cols-1">
            <main className="min-w-0">
              {selectedFile !== null ? (
                <section aria-label="Worktree changes">
                  <h2 className={sectionLabel}>Changes{selectedFile ? ` · ${selectedFile}` : ''}</h2>
                  <div className={`${card} mt-3 p-4`}><ChangesTab task={task} /></div>
                </section>
              ) : selectedRun ? (
                <section aria-label={`Run ${selectedRun.attempt}`}>
                  <RunBanner run={selectedRun} nextRun={nextRun} />
                  <GuardrailTrips events={guardrailEvents} />
                  {phaseSteps && <div className={`${card} mb-5 flex items-center px-[18px] py-[15px]`}><PhaseTimeline steps={phaseSteps} /></div>}
                  <div className={`${card} p-4`}><VerificationCard attempts={verificationAttempts} /></div>
                  <div className="mt-6"><OutputTab run={selectedRun} events={events} unavailable={logUnavailable} /></div>
                  <AgentUsageTable run={selectedRun} />
                  <div className={`${card} mt-6 p-4`}><div className={`${sectionLabel} mb-2`}>This run</div><RunMeta run={selectedRun} /></div>
                  <DetailsTab task={task} run={selectedRun} events={events} />
                </section>
              ) : <NoRunsYet />}
            </main>
            <div className="min-h-0 border-l border-hairline pl-5 max-rail:border-l-0 max-rail:border-t max-rail:pt-5 max-rail:pl-0">
              <RunRail runs={runs} worktree={{ branch: task.branch, baseBranch: task.baseBranch, isolationMode: task.isolationMode, stat: task.stat }} selectedRunId={selectedRunId} selectedFile={selectedFile} onSelectRun={(runId) => { setSelectedFile(null); setSelectedRunId(runId); }} onSelectFile={setSelectedFile} onSelectChanges={() => setSelectedFile('')} />
              <Gate model={gateModel} task={task} runs={runs} verificationAttempts={verificationAttempts} onEdit={(t) => { onClose(); onEdit(t); }} onChanged={onChanged} onGoToCurrent={(runId) => { setSelectedFile(null); setSelectedRunId(runId); }} />
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
