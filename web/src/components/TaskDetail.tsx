import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Run, RunEvent, Task } from '../types';
import { EventStream } from './EventStream';
import { subscribe } from '../ws';

const RUN_STATE_STYLES: Record<Run['state'], string> = {
  running: 'bg-amber-900/70 text-amber-300',
  completed: 'bg-emerald-900/70 text-emerald-300',
  failed: 'bg-red-900/70 text-red-300',
  cancelled: 'bg-zinc-800 text-zinc-400',
};

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
    <div className="border-b border-zinc-800 px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold uppercase tracking-wider text-zinc-500">Depends on</span>
        {current.dependsOn.length === 0 && <span className="text-zinc-600">nothing</span>}
        {current.dependsOn.map((depId) => (
          <span key={depId} className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
            #{depId}
            {editable && (
              <button
                className="text-zinc-500 hover:text-red-400"
                onClick={() => act(() => api.removeDependency(task.id, depId))}
              >
                ✕
              </button>
            )}
          </span>
        ))}
        {editable && candidates.length > 0 && (
          <select
            className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-zinc-300"
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
        <span className="font-semibold uppercase tracking-wider text-zinc-500">Blocks</span>
        {current.dependents.length === 0 && <span className="text-zinc-600">nothing</span>}
        {current.dependents.map((id) => (
          <span key={id} className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
            #{id}
          </span>
        ))}
        {current.dependents.length > 0 && current.state !== 'completed' && (
          <button
            className="text-zinc-500 hover:text-red-400"
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
    <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs">
      <span className="font-semibold uppercase tracking-wider text-zinc-500">Notify</span>
      {attached.map((id) => (
        <span key={id} className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
          {channels.find((c) => c.id === id)?.name ?? `#${id}`}
          <button
            className="text-zinc-500 hover:text-red-400"
            onClick={() =>
              fetch(`/api/tasks/${taskId}/channels/${id}`, { method: 'DELETE' }).then(load)
            }
          >
            ✕
          </button>
        </span>
      ))}
      {attached.length === 0 && <span className="text-zinc-600">channel defaults</span>}
      {candidates.length > 0 && (
        <select
          className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-zinc-300"
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
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl"
      >
        <header className="border-b border-zinc-800 p-4">
          <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500">
            <span>Task #{task.id}</span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5">{task.state}</span>
            <span>
              {task.harness} · {task.model} · {task.isolationMode}
            </span>
            <div className="flex-1" />
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100">
              ✕
            </button>
          </div>
          <p className="line-clamp-4 whitespace-pre-wrap text-sm text-zinc-200">{task.prompt}</p>
        </header>

        <Dependencies task={task} />
        <NotifyOverrides taskId={task.id} />

        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2">
          {runs.length === 0 && <span className="text-xs text-zinc-500">No runs yet.</span>}
          {runs.map((run) => (
            <button
              key={run.id}
              onClick={() => setSelectedRunId(run.id)}
              className={`rounded-md border px-2 py-1 text-xs ${
                run.id === selectedRunId ? 'border-amber-500 text-amber-300' : 'border-zinc-700 text-zinc-400'
              }`}
            >
              Run {run.attempt}
              <span className={`ml-2 rounded px-1 py-0.5 text-[10px] ${RUN_STATE_STYLES[run.state]}`}>
                {run.state}
              </span>
            </button>
          ))}
        </div>

        {selectedRun && (
          <div className="px-4 py-2 text-xs text-zinc-500">
            {selectedRun.reason && <span className="text-red-400">reason: {selectedRun.reason} · </span>}
            {selectedRun.stopReason && <span>stop: {selectedRun.stopReason} · </span>}
            started {new Date(selectedRun.startedAt).toLocaleTimeString()}
            {selectedRun.finishedAt && <> · finished {new Date(selectedRun.finishedAt).toLocaleTimeString()}</>}
            {selectedRun.usage?.totals && (
              <>
                {' · '}
                <span className="text-emerald-400/80">
                  {(selectedRun.usage.totals as any).inputTokens?.toLocaleString()} in /{' '}
                  {(selectedRun.usage.totals as any).outputTokens?.toLocaleString()} out tokens
                </span>
              </>
            )}
            {selectedRun.branch && (
              <>
                {' · '}
                <span className="text-indigo-300">
                  {selectedRun.branch} ← {selectedRun.baseBranch}
                </span>
              </>
            )}
          </div>
        )}
        {selectedRun?.reviewFeedback && (
          <div className="mx-4 mb-2 rounded border border-amber-900 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-200">
            {selectedRun.review === 'rejected' ? 'Rejection feedback: ' : ''}
            {selectedRun.reviewFeedback}
          </div>
        )}
        {diffStat && (
          <pre className="mx-4 mb-2 overflow-x-auto rounded bg-zinc-950 p-2 text-[11px] text-zinc-400">{diffStat}</pre>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          <EventStream events={events} />
        </div>
      </div>
    </div>
  );
}
