import { api } from '../api';
import type { Task } from '../types';
import { btnQuiet as quiet, chip } from '../ui';

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
    <article className="rounded-md border border-hairline bg-surface p-3 transition-colors duration-150 hover:bg-raised">
      <button
        type="button"
        className="mb-2 line-clamp-3 w-full cursor-pointer whitespace-pre-wrap text-left text-ink"
        onClick={() => onOpen(task)}
      >
        {task.prompt}
      </button>
      <div className="mb-2 flex flex-wrap items-center gap-1">
        <span className={`${chip} bg-raised font-data tracking-normal text-muted`}>
          {task.harness} · {task.model}
        </span>
        {/* Priority is typographic, not chromatic (DESIGN.md § Colors). */}
        <span className={`text-label uppercase tracking-wider ${task.priority === 'high' ? 'font-semibold text-ink' : 'text-muted'}`}>
          {task.priority}
        </span>
        <span className={`${chip} bg-raised text-muted`}>{task.isolationMode}</span>
        {task.dependsOn.length > 0 && (
          <span className={`${chip} bg-raised text-muted`}>⇠ {task.dependsOn.length} dep{task.dependsOn.length > 1 ? 's' : ''}</span>
        )}
        {task.blockedOnFailed && (
          <span className={`${chip} bg-fail/15 font-medium uppercase text-fail`}>blocked on failed</span>
        )}
      </div>
      <div className="flex gap-2">
        <span className="font-data text-muted">#{task.id}</span>
        <div className="flex-1" />
        {editable && (
          <button className={quiet} onClick={() => onEdit(task)}>
            Edit
          </button>
        )}
        {task.state === 'draft' && (
          <button className={quiet} onClick={act(() => api.promoteTask(task.id))}>
            Ready
          </button>
        )}
        {task.state === 'ready' && (
          <button className={quiet} onClick={act(() => api.runTask(task.id))}>
            Run now
          </button>
        )}
        {task.state === 'failed' && (
          <button
            className={quiet}
            onClick={act(() => api.requeueTask(task.id, window.prompt('Feedback for the retry (optional):') ?? undefined))}
          >
            Re-queue
          </button>
        )}
        {task.state === 'awaiting-review' && (
          <>
            <button
              className="font-semibold text-accept hover:text-ink"
              onClick={act(() => api.acceptTask(task.id))}
            >
              Accept
            </button>
            <button
              className="font-semibold text-fail hover:text-ink"
              onClick={act(() => api.rejectTask(task.id, window.prompt('Rejection feedback:') ?? undefined))}
            >
              Reject
            </button>
          </>
        )}
        {cancellable && (
          <button className="text-muted hover:text-fail" onClick={act(() => api.cancelTask(task.id))}>
            Cancel
          </button>
        )}
      </div>
    </article>
  );
}
