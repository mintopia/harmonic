import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { formatCost, formatCostByModel } from '../cost';
import type { Cost, Run, RunEvent, Task } from '../types';
import { EmptyState } from './EmptyState';
import { EventStream } from './EventStream';
import { coalesceEvents } from '../event-stream-model';
import { Markdown } from './Markdown';
import { Modal } from './Modal';
import { TaskActions } from './TaskActions';
import { subscribe } from '../ws';
import { btnGhost, chip, labelType, selectField, stateChip } from '../ui';
import { toastError } from '../toast';

const metaChip = `${chip} bg-raised text-muted`;

type Tab = 'description' | 'prompt' | 'output' | 'changes' | 'details';

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
            #{depId}
            {editable && (
              <button
                aria-label={`Remove dependency #${depId}`}
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
                #{t.id} {t.prompt.slice(0, 40)}
              </option>
            ))}
          </select>
        )}
        <div className="flex-1" />
        <span className={`${labelType} text-muted`}>Blocks</span>
        {current.dependents.length === 0 && <span className="text-muted">nothing</span>}
        {current.dependents.map((id) => (
          <span key={id} className={`${metaChip} tabular-nums`}>
            #{id}
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

/** The task's description, on its own tab so the Output tab keeps the full
 * panel height (issue #34 follow-up). Mirrored prompts render as Markdown;
 * native prompts stay plain. */
function DescriptionTab({ task }: { task: Task }) {
  return (
    <div>
      {task.origin === 'mirrored' ? (
        <Markdown source={task.prompt} className="text-ink" />
      ) : (
        <p className="whitespace-pre-wrap text-ink">{task.prompt}</p>
      )}
      {(task.reattemptOf !== null || task.reattempts.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-small tabular-nums text-muted">
          {task.reattemptOf !== null && <span>↻ re-attempt of #{task.reattemptOf}</span>}
          {task.reattempts.length > 0 && (
            <span>re-attempted as {task.reattempts.map((id) => `#${id}`).join(', ')}</span>
          )}
        </div>
      )}
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
            move, and the modal keeps its one cobalt primary for the review
            gate's Accept (the One Cobalt Rule; issue #94). */}
        <button
          onClick={() => void send()}
          disabled={sending || text.trim().length === 0}
          className={btnGhost}
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

function DetailsTab({ task, run, events }: { task: Task; run: Run | undefined; events: RunEvent[] }) {
  return (
    <div className="flex flex-col">
      {run && (
        <div className="py-3 first:pt-0">
          <RunMeta run={run} />
        </div>
      )}
      <OutputSummary events={events} />
      {run?.reviewFeedback && (
        <div className="py-3">
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

export function TaskDetail({
  task,
  onEdit,
  onChanged,
  onClose,
}: {
  task: Task;
  onEdit: (task: Task) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [diff, setDiff] = useState<DiffState>({ status: 'idle' });
  const [tab, setTab] = useState<Tab>('description');
  const [taskCost, setTaskCost] = useState<Cost | null>(null);

  useEffect(() => {
    let live = true;
    const loadCost = () => api.taskUsage(task.id).then((usage) => live && setTaskCost(usage.cost));
    api.taskRuns(task.id).then(({ runs }) => {
      if (!live) return;
      setRuns(runs);
      setSelectedRunId((current) => current ?? runs[runs.length - 1]?.id ?? null);
    });
    loadCost();
    // New runs and state changes arrive over the socket.
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'run_changed' && msg.run.taskId === task.id) {
        setRuns((current) => {
          const rest = current.filter((r) => r.id !== msg.run.id);
          return [...rest, msg.run].sort((a, b) => a.attempt - b.attempt);
        });
        loadCost();
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

  const selectedRun = runs.find((r) => r.id === selectedRunId);

  // Keep the Output panel pinned to the newest event as it streams — but only
  // while the operator is already at the bottom, so we never yank them up
  // mid-read. `stickToBottom` is tracked by the container's onScroll below.
  const scrollRef = useRef<HTMLDivElement>(null);
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

  const tabs: Tab[] = ['description', 'prompt', 'output', 'changes', 'details'];

  // Surface why a Task failed or Escalated up top — the reason lives on the
  // latest Run and was otherwise buried in the Details tab's meta line, so an
  // escalated Task (back in ready) gave the operator nothing to act on.
  const latestRun = runs[runs.length - 1];
  const alert =
    (task.escalated || latestRun?.state === 'failed') && latestRun?.reason
      ? { escalated: task.escalated, text: latestRun.reason.replace(/^escalated to human:\s*/i, '') }
      : null;

  return (
    <Modal label={`Task #${task.id}`} onClose={onClose} className="max-w-3xl">
      {/* Fixed height (not max-h): the modal stays one size across tabs, so
          switching between a short Description and a long Output never resizes
          it — each panel scrolls within this frame instead. */}
      <div className="flex h-[85vh] flex-col">
        <header className="border-b border-hairline p-4">
          <div className="mb-1 flex items-center gap-2 text-small text-muted">
            <span>Task #{task.id}</span>
            <span className={stateChip(task.state)}>{task.state}</span>
            <span>
              {task.harness} · {task.model} · {task.isolationMode}
            </span>
            {formatCost(taskCost) && (
              <span title="Total cost across all runs, retries included">Cost {formatCost(taskCost)}</span>
            )}
            {/* Modal owns the close X; the right padding keeps this line clear
                of the corner it sits in. */}
            <div className="flex-1" />
          </div>
          {/* The description moved to its own tab (below) so the Output tab
              keeps the full panel height — a header-mounted prompt starved it. */}
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
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2">
          {runs.length === 0 && <span className="text-muted">No runs yet.</span>}
          {runs.map((run) => (
            <button
              key={run.id}
              aria-pressed={run.id === selectedRunId}
              onClick={() => setSelectedRunId(run.id)}
              // Selected run reads as selected by weight + a neutral raised
              // ground, not cobalt: the modal reserves the accent for the
              // review gate's Accept so it stays unambiguously the primary
              // (issue #94).
              className={`rounded-md px-2 py-1 transition-colors duration-150 ${
                run.id === selectedRunId
                  ? 'bg-raised font-semibold text-ink'
                  : 'font-medium text-muted hover:bg-raised hover:text-ink'
              }`}
            >
              Run {run.attempt}
              <span className={`ml-2 ${stateChip(run.state)}`}>{run.state}</span>
            </button>
          ))}
        </div>

        <div role="tablist" className="flex gap-1 border-b border-hairline px-4">
          {tabs.map((t) => {
            // Flag when Details holds review context (why a prior run was
            // rejected, or the feedback seeding this re-attempt) so a
            // reviewer sees there is something to read before acting.
            const flag = t === 'details' && Boolean(task.feedback || selectedRun?.reviewFeedback);
            return (
              <button
                key={t}
                role="tab"
                id={`task-tab-${t}`}
                aria-selected={tab === t}
                aria-controls={`task-panel-${t}`}
                tabIndex={tab === t ? 0 : -1}
                aria-label={flag ? 'details (has review feedback)' : undefined}
                onClick={() => setTab(t)}
                className={`-mb-px border-b-2 px-2 py-2 ${labelType} transition-colors duration-150 ${
                  tab === t ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                {t}
                {flag && (
                  <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" aria-hidden />
                )}
              </button>
            );
          })}
        </div>

        {/* Panels stay mounted (toggled with `hidden`) so switching tabs
            never discards in-progress state — notably a dependency edit
            held in the Dependencies component. */}
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="flex-1 overflow-y-auto p-4"
        >
          <div role="tabpanel" id="task-panel-description" aria-labelledby="task-tab-description" hidden={tab !== 'description'}>
            <DescriptionTab task={task} />
          </div>
          <div role="tabpanel" id="task-panel-prompt" aria-labelledby="task-tab-prompt" hidden={tab !== 'prompt'}>
            <PromptTab run={selectedRun} />
          </div>
          <div role="tabpanel" id="task-panel-output" aria-labelledby="task-tab-output" hidden={tab !== 'output'}>
            <OutputTab run={selectedRun} events={events} />
          </div>
          <div role="tabpanel" id="task-panel-changes" aria-labelledby="task-tab-changes" hidden={tab !== 'changes'}>
            <ChangesTab run={selectedRun} diff={diff} />
          </div>
          <div role="tabpanel" id="task-panel-details" aria-labelledby="task-tab-details" hidden={tab !== 'details'}>
            <DetailsTab task={task} run={selectedRun} events={events} />
          </div>
        </div>

        {/* Editing opens the task form; close the detail modal first so the
            two don't stack. */}
        <TaskActions
          task={task}
          variant="footer"
          onEdit={(t) => {
            onClose();
            onEdit(t);
          }}
          onChanged={onChanged}
        />
      </div>
    </Modal>
  );
}
