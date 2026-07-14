import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Run, RunEvent, Task } from '../types';
import { EventStream } from './EventStream';

const RUN_STATE_STYLES: Record<Run['state'], string> = {
  running: 'bg-amber-900/70 text-amber-300',
  completed: 'bg-emerald-900/70 text-emerald-300',
  failed: 'bg-red-900/70 text-red-300',
  cancelled: 'bg-zinc-800 text-zinc-400',
};

export function TaskDetail({ task, onClose }: { task: Task; onClose: () => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);

  useEffect(() => {
    let live = true;
    const load = () =>
      api.taskRuns(task.id).then(({ runs }) => {
        if (!live) return;
        setRuns(runs);
        setSelectedRunId((current) => current ?? runs[runs.length - 1]?.id ?? null);
      });
    load();
    const timer = setInterval(load, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [task.id]);

  useEffect(() => {
    if (selectedRunId === null) return;
    let live = true;
    const load = () => api.runEvents(selectedRunId).then(({ events }) => live && setEvents(events));
    load();
    const timer = setInterval(load, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selectedRunId]);

  const selectedRun = runs.find((r) => r.id === selectedRunId);

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
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          <EventStream events={events} />
        </div>
      </div>
    </div>
  );
}
