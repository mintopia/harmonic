import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../api';
import { nextTabIndex } from '../tablist-model';
import { formatCost, formatCostByModel } from '../cost';
import type { GuardrailEvent, Run, RunEvent, Task, VerificationAttempt } from '../types';
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

type Tab = 'output' | 'changes' | 'prompt' | 'details';
const TAB_LABEL: Record<Tab, string> = { output: 'Output', changes: 'Changes', prompt: 'Prompt', details: 'Details' };

/** The Changes tab's diff fetch, as a state machine so a swallowed error
 * or the in-flight window is never mistaken for "no changes". */
type DiffState =
  | { status: 'idle' } // no branch, or the run is still running
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; stat: string | null };

/** Shared by OutputTab/PromptTab/ChangesTab: same copy, same placement, for
 * the one case they all share — no run selected yet. */
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
          // Two-step inline confirm — never a native confirm() (DESIGN.md
          // § Toasts): this cascades a cancel across dependents, so it asks
          // once, in the interface's own voice, before acting.
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

/** The selected run's result facts as labelled Data rows. */
function RunMeta({ run }: { run: Run }) {
  const totals = run.usage?.totals as any;
  const rows: Array<[string, ReactNode]> = [];
  if (run.reason) rows.push(['reason', <span className="text-fail">{run.reason}</span>]);
  if (run.stopReason) rows.push(['stop', run.stopReason]);
  rows.push(['started', new Date(run.startedAt).toLocaleTimeString()]);
  if (run.finishedAt) rows.push(['finished', new Date(run.finishedAt).toLocaleTimeString()]);
  if (run.sessionId) {
    rows.push([
      'session',
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
      <span title={formatCostByModel(run.cost)}>
        {formatCost(run.cost)}
        {Object.keys(run.cost.byModel).length > 1 ? ` (${formatCostByModel(run.cost)})` : ''}
      </span>,
    ]);
  }
  if (typeof totals?.aiUnits === 'number') {
    rows.push([
      'AI units',
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

/** The selected run's Guardrail-trip log (issue #171), rendered distinctly
 * from the run's other facts — each trip is a fail-tinted panel naming the
 * dimension and the limit-vs-observed evidence, mirroring the escalation
 * banner's fail vocabulary (`bg-fail-tint`/`text-fail`/`font-semibold`) so a
 * Guardrail trip reads with the same weight as a failed run. */
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

function OutputTab({ run, events }: { run: Run | undefined; events: RunEvent[] }) {
  if (!run) return <NoRunsYet />;
  return (
    <div>
      <EventStream events={events} />
      {run.state === 'running' && <SteerBox taskId={run.taskId} />}
    </div>
  );
}

/** Steer a running run: queue an operator message that is delivered as a fresh
 * turn at the next turn boundary (never mid-turn). For an agent that has gone
 * off-track, or one that ended its turn and parked waiting for a prompt. */
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
      <div className={`${labelType} mb-1 text-muted`}>Steer this run</div>
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          // Enter sends; Shift+Enter for a newline — the chat-input convention.
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
        {/* Ghost, not a cobalt fill: steering a running run is a secondary
            move, and the page keeps its one cobalt primary for the review
            gate's Accept (the One Cobalt Rule; issue #94). */}
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

/** The exact prompt sent to the agent for the selected Run — persisted at run
 * time (native = the filled Task Prompt template + any feedback; mirrored =
 * the filled Drive Prompt), so it reflects what actually went out even if the
 * template has since changed. */
function PromptTab({ run }: { run: Run | undefined }) {
  if (!run) return <NoRunsYet />;
  if (!run.prompt) {
    return (
      <p className="text-muted">
        {run.state === 'running' ? 'Prompt is sent as the run starts…' : 'No prompt recorded for this run.'}
      </p>
    );
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-field p-3 font-data text-data text-ink">
      {run.prompt}
    </pre>
  );
}

/** The tail of the agent's own message text for the selected Run — a quick
 * read of how the run ended without opening the full Output stream. Thoughts
 * and tool calls are dropped; only assistant prose survives, last three folded
 * utterances shown newest-last. */
function OutputSummary({ events }: { events: RunEvent[] }) {
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

function ChangesTab({ run, diff }: { run: Run | undefined; diff: DiffState }) {
  if (!run) return <NoRunsYet />;
  if (!run.branch) return <p className="text-muted">Ran in direct mode — no branch or diff.</p>;
  return (
    <div className="space-y-2">
      {/* Branch refs and the diff are code (mono); the status sentences are
          prose (sans) — the Mono Is Code Rule. */}
      <div className="font-data text-data text-tool">
        {run.branch} ← {run.baseBranch}
      </div>
      {run.state === 'running' ? (
        <p className="text-muted">Diff available once the run finishes.</p>
      ) : diff.status === 'error' ? (
        <p className="text-fail">Couldn’t load the diff for this run.</p>
      ) : diff.status === 'ready' ? (
        diff.stat ? (
          <pre className="overflow-x-auto rounded-md bg-field p-2 font-data text-data text-muted">{diff.stat}</pre>
        ) : (
          <p className="text-muted">No changes on this branch.</p>
        )
      ) : (
        <p className="text-muted">Loading diff…</p>
      )}
    </div>
  );
}

/** The re-attempt/review context and the editable Dependencies/Notify blocks
 * — everything DetailsTab held that isn't now permanently visible in the
 * Ticket page's side aside (RunMeta and VerificationCard moved there, so this
 * tab no longer repeats them — issue #183). */
function DetailsTab({ task, run, events }: { task: Task; run: Run | undefined; events: RunEvent[] }) {
  return (
    <div className="flex flex-col">
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

/** A compact `key value` fact for the task-meta line (prototype `.mfact`). */
function MetaFact({ k, children }: { k?: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {k && <span className="text-faint">{k}</span>}
      {children}
    </span>
  );
}

/** The `·` divider between task-meta facts (prototype `.dotsep`). */
function MetaSep() {
  return <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-edge" />;
}

/** The header meta line's "depends on" fact: each dependency id, checked off
 * once its own Task has landed. Read-only and compact — the full editable
 * add/remove list stays in the Details tab's `Dependencies` (unchanged);
 * this fetches the same `api.tasks()` list `Dependencies` does, purely to
 * resolve each dependency's own state for the checkmark (issue #183). */
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
              <span key={depId} className={`inline-flex items-center gap-1 ${satisfied ? 'text-accept' : ''}`}>
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

/** The header meta line's "notify" fact: the channels this Task routes to, or
 * "channel defaults" when none are pinned — read-only, same data
 * `NotifyOverrides` (Details tab) edits. Renders nothing when the Workspace
 * has no channels configured at all, mirroring `NotifyOverrides`'s own gate. */
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

/** The task-level Brief card (prototype `.brief`): the same prompt render
 * `DescriptionTab` used inside the old modal's Description tab, now surfaced
 * directly under the header instead of behind a tab — the header IS the
 * Ticket page's front matter (issue #183). */
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

/** A rejected/failed selected Run's banner (prototype `.runbanner`), carrying
 * feedback forward into the next Run on the same Task when one exists — an
 * auto-retry after a validation failure, the one same-Task case a "next Run"
 * genuinely applies (a *reviewed* rejection spawns a new linked Task instead,
 * surfaced by the Brief's re-attempt lineage line, not a Run in this list). */
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

/**
 * The full-width Ticket page (issue #183, part of #179 — the Deck redesign):
 * TaskDetail's modal, adapted into its own route. Every hook/effect/state
 * below is carried over verbatim from the modal (the run list + selected-run
 * state, the WS `run_changed` sync, the event-stream replay + live
 * `run_event`, the guardrail/verification-attempt polls, the diff fetch) —
 * only the *rendering* changes: a crumb bar replaces the Modal's dialog
 * chrome, the run switcher becomes the `RunRail`, the always-current
 * `TaskActions` footer becomes the run-aware `Gate`, and RunMeta/
 * VerificationCard move out of the tabbed Details into an always-visible side
 * column (matching the prototype's `.t-side`).
 */
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
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [guardrailEvents, setGuardrailEvents] = useState<GuardrailEvent[]>([]);
  const [verificationAttempts, setVerificationAttempts] = useState<VerificationAttempt[]>([]);
  const [diff, setDiff] = useState<DiffState>({ status: 'idle' });
  const [tab, setTab] = useState<Tab>('output');

  useEffect(() => {
    let live = true;
    api.taskRuns(task.id).then(({ runs }) => {
      if (!live) return;
      setRuns(runs);
      setSelectedRunId((current) => current ?? runs[runs.length - 1]?.id ?? null);
    });
    // New runs and state changes arrive over the socket.
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
    // Clear the previous run's stream before replaying this one, so a run
    // switch never shows (or interleaves live events into) the old output.
    setEvents([]);
    // Replay: load the persisted stream, then append live events as they
    // arrive — one representation for both.
    api.runEvents(selectedRunId).then(({ events }) => live && setEvents(events));
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'run_event' && msg.event.runId === selectedRunId) {
        setEvents((current) =>
          current.some((e) => e.id === msg.event.id) ? current : [...current, msg.event],
        );
      }
    });
    return () => {
      live = false;
      unsubscribe();
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

  // Verification-attempt log for the selected run (issue #169, part of #109):
  // REST replay, then a WS-triggered refetch (no per-attempt firehose event,
  // unlike run_event) — `run_changed` for this run is the signal something on
  // it may have changed. Mirrors the guardrailEvents effect above exactly.
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
  const phaseSteps = selectedRun ? phaseTimelineFromEvents(events, selectedRun.phase, selectedRun.state) : null;

  // Keep the Output panel pinned to the newest event as it streams — but only
  // while the operator is already at the bottom, so we never yank them up
  // mid-read. `stickToBottom` is tracked by the page's own scroll region
  // below (unlike the old modal, the whole page scrolls as one — there's no
  // separate fixed-height tab-panel viewport any more).
  const scrollRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (tab !== 'output' || !el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events, tab]);

  useEffect(() => {
    if (selectedRunId === null || !selectedRun?.branch || selectedRun.state === 'running') {
      setDiff({ status: 'idle' });
      return;
    }
    let live = true;
    setDiff({ status: 'loading' });
    // Guard against a slow response for a previously-selected run landing
    // after the user has switched runs.
    api.runDiff(selectedRunId).then(
      ({ stat }) => live && setDiff({ status: 'ready', stat }),
      () => live && setDiff({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [selectedRunId, selectedRun?.branch, selectedRun?.state]);

  // Escape → back to the Deck, same parity the old Modal gave for free via
  // the native <dialog> element.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const tabs: Tab[] = ['output', 'changes', 'prompt', 'details'];

  // WAI-ARIA tablist keyboard nav: Tab reaches the tablist as one stop (roving
  // tabindex below), then Left/Right/Home/End move between tabs. Selection
  // follows focus (automatic activation) — switching a tab only toggles a
  // `hidden` panel, so there's no cost that would justify manual activation.
  const onTablistKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = nextTabIndex(e.key, tabs.indexOf(tab), tabs.length);
    if (next === null) return;
    const target = tabs[next];
    if (target === undefined) return;
    e.preventDefault();
    setTab(target);
    tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  // Surface why a Task failed or Escalated up top — the reason lives on the
  // latest Run (task-level: independent of whichever Run the operator has
  // currently selected below).
  const latestRun = runs[runs.length - 1];
  const alert =
    (task.escalated || latestRun?.state === 'failed') && latestRun?.reason
      ? { escalated: task.escalated, text: latestRun.reason.replace(/^escalated to human:\s*/i, '') }
      : null;

  // Link the lease skip-reason to its holder (issue #176): the server string
  // names the Task holding the Work Context but gave the operator nothing to
  // click. `null` when the string doesn't contain a `task <id>` to link.
  const skipHolderId = parseSkipReasonTaskRef(task.skipReason);

  // The one-time progress-nudge and the run-level next-attempt lookup are
  // both scoped to the *selected* run, so they render alongside it (phases/
  // runbanner), not in the task-level header above.
  const progressNudge = events.find((e) => e.payload?.event === 'progress-nudge') ?? null;
  const progressNudgePattern = progressNudge?.payload?.pattern as string | undefined;
  const nextRun = selectedRun ? runs.find((r) => r.attempt === selectedRun.attempt + 1) : undefined;

  // The bottom bar (issue #183): whether the selected run gets the live gate
  // or a read-only historical result. The accept-anyway arming on a block/
  // escalate verdict (issue #174) lives inside TaskActions, which the live
  // variant embeds — not re-decided here.
  const gateModel = gateForRun({ task, runs, selectedRunId });

  return (
    <div className="flex h-full flex-col">
      {/* Crumb bar: the page's back-to-Deck affordance, replacing the Modal's
          dialog chrome (issue #183). */}
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
          <b className="font-medium text-muted">Deck</b> / {ticketIdentity(task.id, task.trackerRef)}
        </span>
      </div>

      {/* The scrolling middle region — the whole page's content, including
          the sticky crumb's sibling below-the-fold content. Carries the skip
          link's target (issue #183: the same `id="main-content"` App.tsx's
          own `<main>` uses when no Ticket is open). */}
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
          {/* TASK LEVEL */}
          <div className="pb-1 pt-[22px]">
            <div className="flex items-start gap-3">
              <h1 className={`${displayTitle} line-clamp-2 max-w-[28ch]`}>{task.prompt}</h1>
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
            <Brief task={task} />
            {/* Informational, not alarming (issue #171): a ready Task not
                running yet because its Work Context lease is held elsewhere —
                subtle so it never competes with the failed/escalated alert. */}
            {task.skipReason && (
              <div className="mt-2 text-small text-muted">
                <span className={labelType}>Skipped</span> —{' '}
                {/* Link the holder ref to its Task (the lease owner). Split on the
                    literal `task <id>` the model already parsed, so the `task …`
                    format lives in exactly one place (skip-reason-model). */}
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

          {/* RUN RAIL */}
          <RunRail runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />

          {/* PER-RUN DETAIL */}
          <div className="mt-5">
            {selectedRun && <RunBanner run={selectedRun} nextRun={nextRun} />}
            {selectedRun && progressNudge && (
              <div className="mb-[18px] rounded-md bg-accent-tint px-2 py-1 text-small text-ink">
                <span className={`${labelType} mr-2 text-accent`}>progress nudge</span>
                <span>
                  Redirected before a guardrail trip
                  {progressNudgePattern ? ` — ${progressNudgePattern}` : ''}
                </span>
              </div>
            )}
            {selectedRun && <GuardrailTrips events={guardrailEvents} />}
            {phaseSteps && (
              <div className={`${card} mb-[18px] flex items-center px-[18px] py-[15px]`}>
                <PhaseTimeline steps={phaseSteps} />
              </div>
            )}

            <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-[22px] pb-10">
              <div className="min-w-0">
                <div
                  ref={tablistRef}
                  role="tablist"
                  aria-label="Run detail"
                  onKeyDown={onTablistKeyDown}
                  className="mb-2 flex gap-1 border-b border-hairline"
                >
                  {tabs.map((t) => {
                    // Flag when Details holds review context (why a prior run
                    // was rejected, or the feedback seeding this re-attempt) —
                    // Verification's own verdict now lives in the always-open
                    // side card, so it no longer needs to flag this tab too.
                    const flag = t === 'details' && Boolean(task.feedback || selectedRun?.reviewFeedback);
                    return (
                      <button
                        key={t}
                        role="tab"
                        id={`ticket-tab-${t}`}
                        aria-selected={tab === t}
                        aria-controls={`ticket-panel-${t}`}
                        tabIndex={tab === t ? 0 : -1}
                        aria-label={flag ? `${t} (has review feedback)` : undefined}
                        onClick={() => setTab(t)}
                        className={`-mb-px border-b-2 px-3 py-2 text-title font-medium transition-colors duration-150 ${
                          tab === t ? 'border-accent font-semibold text-ink' : 'border-transparent text-faint hover:text-ink'
                        }`}
                      >
                        {TAB_LABEL[t]}
                        {flag && (
                          <span className="ml-1 inline-block size-1.5 rounded-full bg-accent align-middle" aria-hidden />
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Panels stay mounted (toggled with `hidden`) so switching
                    tabs never discards in-progress state — notably a
                    dependency edit held in the Dependencies component. */}
                <div role="tabpanel" id="ticket-panel-output" aria-labelledby="ticket-tab-output" hidden={tab !== 'output'}>
                  <OutputTab run={selectedRun} events={events} />
                </div>
                <div role="tabpanel" id="ticket-panel-changes" aria-labelledby="ticket-tab-changes" hidden={tab !== 'changes'}>
                  <ChangesTab run={selectedRun} diff={diff} />
                </div>
                <div role="tabpanel" id="ticket-panel-prompt" aria-labelledby="ticket-tab-prompt" hidden={tab !== 'prompt'}>
                  <PromptTab run={selectedRun} />
                </div>
                <div role="tabpanel" id="ticket-panel-details" aria-labelledby="ticket-tab-details" hidden={tab !== 'details'}>
                  <DetailsTab task={task} run={selectedRun} events={events} />
                </div>
              </div>

              <aside className="flex flex-col gap-4">
                {selectedRun && (
                  <div className={`${card} p-3.5`}>
                    <VerificationCard attempts={verificationAttempts} />
                  </div>
                )}
                {selectedRun && (
                  <div className={`${card} p-3.5`}>
                    <div className={`${sectionLabel} mb-1.5`}>This run</div>
                    <RunMeta run={selectedRun} />
                  </div>
                )}
              </aside>
            </div>
          </div>
        </div>
      </div>

      {/* GATE */}
      <Gate
        model={gateModel}
        task={task}
        runs={runs}
        verificationAttempts={verificationAttempts}
        onEdit={(t) => {
          onClose();
          onEdit(t);
        }}
        onChanged={onChanged}
        onGoToCurrent={setSelectedRunId}
      />
    </div>
  );
}
