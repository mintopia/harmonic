import { api } from '../api';
import type { Task } from '../types';

const PRIORITY_STYLES: Record<Task['priority'], string> = {
  high: 'bg-red-900/60 text-red-300',
  normal: 'bg-zinc-800 text-zinc-400',
  low: 'bg-sky-900/60 text-sky-300',
};

export function TaskCard({
  task,
  onEdit,
  onOpen,
  onChanged,
}: {
  task: Task;
  onEdit: (task: Task) => void;
  onOpen: (task: Task) => void;
  onChanged: () => void;
}) {
  const editable = task.state === 'draft' || task.state === 'ready';
  const cancellable = !['completed', 'cancelled'].includes(task.state);

  const act = (fn: () => Promise<unknown>) => () => fn().then(onChanged, (e) => alert(e.message));

  return (
    <article className="rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm shadow">
      <p
        className="mb-2 line-clamp-3 cursor-pointer whitespace-pre-wrap text-zinc-200 hover:text-white"
        onClick={() => onOpen(task)}
      >
        {task.prompt}
      </p>
      <div className="mb-2 flex flex-wrap gap-1 text-[11px]">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
          {task.harness} · {task.model}
        </span>
        <span className={`rounded px-1.5 py-0.5 ${PRIORITY_STYLES[task.priority]}`}>{task.priority}</span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">{task.isolationMode}</span>
      </div>
      <div className="flex gap-2 text-xs">
        <span className="text-zinc-600">#{task.id}</span>
        <div className="flex-1" />
        {editable && (
          <button className="text-zinc-400 hover:text-zinc-100" onClick={() => onEdit(task)}>
            Edit
          </button>
        )}
        {task.state === 'draft' && (
          <button
            className="text-amber-400 hover:text-amber-300"
            onClick={act(() => api.promoteTask(task.id))}
          >
            Ready
          </button>
        )}
        {task.state === 'ready' && (
          <button
            className="text-emerald-400 hover:text-emerald-300"
            onClick={act(() => api.runTask(task.id))}
          >
            Run now
          </button>
        )}
        {task.state === 'failed' && (
          <button
            className="text-amber-400 hover:text-amber-300"
            onClick={act(() => api.requeueTask(task.id))}
          >
            Re-queue
          </button>
        )}
        {cancellable && (
          <button
            className="text-zinc-500 hover:text-red-400"
            onClick={act(() => api.cancelTask(task.id))}
          >
            Cancel
          </button>
        )}
      </div>
    </article>
  );
}
