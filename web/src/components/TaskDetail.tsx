import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatCost, formatCostByModel } from '../cost';
import type { Cost, Run, RunEvent, Task } from '../types';
import { EventStream } from './EventStream';
import { Modal } from './Modal';
import { subscribe } from '../ws';
import { btnQuiet, chip, labelType, stateChip } from '../ui';

const metaChip = `${chip} bg-raised text-muted`;
const inlineSelect =
  'rounded-md border border-edge bg-field px-1 py-0.5 text-ink focus:border-accent focus:outline-none';

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
    <div className="border-b border-hairline px-4 py-2">
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
    <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2">
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

export function TaskDetail({ task, onClose }: { task: Task; onClose: () => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [diffStat, setDiffStat] = useState<string | null>(null);
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
    setDiffStat(null);
    if (selectedRunId === null || !selectedRun?.branch || selectedRun.state === 'running') return;
    api.runDiff(selectedRunId).then(({ stat }) => setDiffStat(stat)).catch(() => {});
  }, [selectedRunId, selectedRun?.branch, selectedRun?.state]);

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

        {/* The reviewer feedback that seeded this re-attempt, shown in full. */}
        {task.feedback && (
          <div className="border-b border-hairline px-4 py-2">
            <div className={`${labelType} mb-1 text-muted`}>Feedback carried into this re-attempt</div>
            <p className="whitespace-pre-wrap text-ink">{task.feedback}</p>
          </div>
        )}

        <Dependencies task={task} />
        <NotifyOverrides taskId={task.id} />

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

        {selectedRun && (
          <div className="px-4 py-2 font-data text-data text-muted">
            {selectedRun.reason && <span className="text-fail">reason: {selectedRun.reason} · </span>}
            {selectedRun.stopReason && <span>stop: {selectedRun.stopReason} · </span>}
            started {new Date(selectedRun.startedAt).toLocaleTimeString()}
            {selectedRun.finishedAt && <> · finished {new Date(selectedRun.finishedAt).toLocaleTimeString()}</>}
            {selectedRun.usage?.totals && (
              <>
                {' · '}
                {(selectedRun.usage.totals as any).inputTokens?.toLocaleString()} in /{' '}
                {(selectedRun.usage.totals as any).outputTokens?.toLocaleString()} out tokens
              </>
            )}
            {selectedRun.cost && formatCost(selectedRun.cost) && (
              <>
                {' · '}
                <span title={formatCostByModel(selectedRun.cost)}>
                  {formatCost(selectedRun.cost)}
                  {Object.keys(selectedRun.cost.byModel).length > 1 && (
                    <> ({formatCostByModel(selectedRun.cost)})</>
                  )}
                </span>
              </>
            )}
            {typeof selectedRun.usage?.totals?.aiUnits === 'number' && (
              <>
                {' · '}
                <span title="Copilot AI Units — actual spend (separate from Cost)">
                  {selectedRun.usage.totals.aiUnits.toFixed(2)} AIU
                </span>
              </>
            )}
            {selectedRun.branch && (
              <>
                {' · '}
                <span className="text-tool">
                  {selectedRun.branch} ← {selectedRun.baseBranch}
                </span>
              </>
            )}
          </div>
        )}
        {selectedRun?.reviewFeedback && (
          <div className="mx-4 mb-2 rounded-md bg-raised px-3 py-1.5 text-ink">
            {selectedRun.review === 'rejected' && <span className="text-fail">Rejection feedback: </span>}
            {selectedRun.reviewFeedback}
          </div>
        )}
        {diffStat && (
          <pre className="mx-4 mb-2 overflow-x-auto rounded-md bg-field p-2 font-data text-data text-muted">{diffStat}</pre>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          <EventStream events={events} />
        </div>
      </div>
    </Modal>
  );
}
