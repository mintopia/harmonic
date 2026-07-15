import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { formatCost, formatCostByModel } from '../cost';
import type { Cost, Run, RunEvent, Task } from '../types';
import { taskActions } from '../task-actions-model';
import { EventStream } from './EventStream';
import { Modal } from './Modal';
import { RejectDialog } from './RejectDialog';
import { ReattemptDialog } from './ReattemptDialog';
import { subscribe } from '../ws';
import { btnAccept, btnGhost, btnQuiet, btnReject, chip, labelType, stateChip } from '../ui';

const metaChip = `${chip} bg-raised text-muted`;
const inlineSelect =
  'rounded-md border border-edge bg-field px-1 py-0.5 text-ink focus:border-accent focus:outline-none';

type Tab = 'output' | 'changes' | 'details';

/** The Changes tab's diff fetch, as a state machine so a swallowed error
 * or the in-flight window is never mistaken for "no changes". */
type DiffState =
  | { status: 'idle' } // no branch, or the run is still running
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; stat: string | null };

function Dependencies({ task }: { task: Task }) {
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [current, setCurrent] = useState<Task>(task);
  const [pick, setPick] = useState('');
  const editable = ['draft', 'ready', 'blocked'].includes(current.state);

  useEffect(() => {
    api.tasks().then(({ tasks }) => setAllTasks(tasks));
  }, [task.id]);

  const candidates = allTasks.filter(
    (t) => t.id !== task.id && !current.dependsOn.includes(t.id) && !['cancelled'].includes(t.state),
  );

  const act = (fn: () => Promise<Task>) => fn().then(setCurrent, (e) => alert(e.message));

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${labelType} text-muted`}>Depends on</span>
        {current.dependsOn.length === 0 && <span className="text-muted">nothing</span>}
        {current.dependsOn.map((depId) => (
          <span key={depId} className={`flex items-center gap-1 ${metaChip} font-data`}>
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
            className={inlineSelect}
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
          <span key={id} className={`${metaChip} font-data`}>
            #{id}
          </span>
        ))}
        {current.dependents.length > 0 && current.state !== 'completed' && (
          <button
            className="text-muted hover:text-fail"
            onClick={() =>
              confirm('Cancel this task and everything that depends on it?') &&
              act(() => api.cancelTask(task.id, true))
            }
          >
            Cancel with dependents
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
          className={inlineSelect}
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
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-data text-data">
      {rows.map(([label, value], i) => (
        <Fragment key={i}>
          <dt className={`${labelType} text-muted`}>{label}</dt>
          <dd className="min-w-0 text-ink">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function OutputTab({ run, events }: { run: Run | undefined; events: RunEvent[] }) {
  if (!run) return <p className="text-muted">No runs yet.</p>;
  return <EventStream events={events} />;
}

function ChangesTab({ run, diff }: { run: Run | undefined; diff: DiffState }) {
  if (!run) return <p className="text-muted">No runs yet.</p>;
  if (!run.branch) return <p className="text-muted">Ran in direct mode — no branch or diff.</p>;
  return (
    <div className="space-y-2 font-data text-data">
      <div className="text-tool">
        {run.branch} ← {run.baseBranch}
      </div>
      {run.state === 'running' ? (
        <p className="text-muted">Diff available once the run finishes.</p>
      ) : diff.status === 'error' ? (
        <p className="text-fail">Couldn’t load the diff for this run.</p>
      ) : diff.status === 'ready' ? (
        diff.stat ? (
          <pre className="overflow-x-auto rounded-md bg-field p-2 text-muted">{diff.stat}</pre>
        ) : (
          <p className="text-muted">No changes on this branch.</p>
        )
      ) : (
        <p className="text-muted">Loading diff…</p>
      )}
    </div>
  );
}

function DetailsTab({ task, run }: { task: Task; run: Run | undefined }) {
  return (
    <div className="divide-y divide-hairline">
      {run && (
        <div className="py-3 first:pt-0">
          <RunMeta run={run} />
        </div>
      )}
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

/** State-aware action bar — the same actions the card offers, driven by
 * the shared taskActions() map so the two surfaces never drift. Hidden
 * entirely for terminal states (no actions). */
function ActionBar({
  task,
  onEdit,
  onClose,
  onReject,
  onReattempt,
}: {
  task: Task;
  onEdit: (task: Task) => void;
  onClose: () => void;
  onReject: () => void;
  onReattempt: () => void;
}) {
  const actions = taskActions(task.state);
  if (actions.length === 0) return null;

  const run = (fn: () => Promise<unknown>) => () => fn().catch((e) => alert(e instanceof Error ? e.message : String(e)));
  const cancelBtn = 'font-medium text-muted transition-colors duration-150 hover:text-fail';

  return (
    <footer className="flex flex-wrap items-center justify-end gap-2.5 border-t border-hairline px-4 py-3">
      {actions.map((action) => {
        switch (action) {
          case 'accept':
            return (
              <button key={action} className={btnAccept} onClick={run(() => api.acceptTask(task.id))}>
                Accept
              </button>
            );
          case 'reject':
            return (
              <button key={action} className={btnReject} onClick={onReject}>
                Reject
              </button>
            );
          case 'reattempt':
            return (
              <button key={action} className={btnGhost} onClick={onReattempt}>
                Re-attempt
              </button>
            );
          case 'run':
            return (
              <button key={action} className={btnGhost} onClick={run(() => api.runTask(task.id))}>
                Run now
              </button>
            );
          case 'ready':
            return (
              <button key={action} className={btnGhost} onClick={run(() => api.promoteTask(task.id))}>
                Ready
              </button>
            );
          case 'edit':
            return (
              <button
                key={action}
                className={btnQuiet}
                onClick={() => {
                  onEdit(task);
                  onClose();
                }}
              >
                Edit
              </button>
            );
          case 'cancel':
            return (
              <button key={action} className={cancelBtn} onClick={run(() => api.cancelTask(task.id))}>
                Cancel
              </button>
            );
        }
      })}
    </footer>
  );
}

export function TaskDetail({
  task,
  onEdit,
  onClose,
}: {
  task: Task;
  onEdit: (task: Task) => void;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [diff, setDiff] = useState<DiffState>({ status: 'idle' });
  const [tab, setTab] = useState<Tab>('output');
  const [taskCost, setTaskCost] = useState<Cost | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reattempting, setReattempting] = useState(false);

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

  const tabs: Tab[] = ['output', 'changes', 'details'];

  return (
    <Modal label={`Task #${task.id}`} onClose={onClose} className="max-w-3xl">
      <div className="flex max-h-[85vh] flex-col">
        <header className="border-b border-hairline p-4">
          <div className="mb-1 flex items-center gap-2 text-muted">
            <span className="font-data">Task #{task.id}</span>
            <span className={stateChip(task.state)}>{task.state}</span>
            <span className="font-data">
              {task.harness} · {task.model} · {task.isolationMode}
            </span>
            {formatCost(taskCost) && (
              <span className="font-data" title="Total cost across all runs, retries included">
                Cost {formatCost(taskCost)}
              </span>
            )}
            <div className="flex-1" />
            <button aria-label="Close" onClick={onClose} className={btnQuiet}>
              ✕
            </button>
          </div>
          <p className="line-clamp-4 whitespace-pre-wrap text-ink">{task.prompt}</p>
          {(task.reattemptOf !== null || task.reattempts.length > 0) && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-data text-muted">
              {task.reattemptOf !== null && <span>↻ re-attempt of #{task.reattemptOf}</span>}
              {task.reattempts.length > 0 && (
                <span>re-attempted as {task.reattempts.map((id) => `#${id}`).join(', ')}</span>
              )}
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
              className={`rounded-md px-2 py-1 transition-colors duration-150 ${
                run.id === selectedRunId
                  ? 'bg-accent-tint font-semibold text-accent'
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
                aria-selected={tab === t}
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
        <div className="flex-1 overflow-y-auto p-4">
          <div hidden={tab !== 'output'}>
            <OutputTab run={selectedRun} events={events} />
          </div>
          <div hidden={tab !== 'changes'}>
            <ChangesTab run={selectedRun} diff={diff} />
          </div>
          <div hidden={tab !== 'details'}>
            <DetailsTab task={task} run={selectedRun} />
          </div>
        </div>

        <ActionBar
          task={task}
          onEdit={onEdit}
          onClose={onClose}
          onReject={() => setRejecting(true)}
          onReattempt={() => setReattempting(true)}
        />
      </div>

      {rejecting && (
        <RejectDialog taskId={task.id} onClose={() => setRejecting(false)} onDone={() => setRejecting(false)} />
      )}
      {reattempting && (
        <ReattemptDialog
          taskId={task.id}
          onClose={() => setReattempting(false)}
          onDone={() => setReattempting(false)}
        />
      )}
    </Modal>
  );
}
