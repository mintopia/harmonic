import { useState } from 'react';
import { api } from '../api';
import type { Task } from '../types';
import { btnAccept, btnQuiet as quiet, btnReject, card } from '../ui';
import { RejectDialog } from './RejectDialog';

/** One truncating Data-role line: id, harness · model, then only the
 * facts that deviate from defaults (isolation, deps, cost). Metadata is
 * plain mono text, never chip slabs. */
function metaLine(task: Task): string {
  const bits = [`#${task.id}`, `${task.harness} · ${task.model}`];
  if (task.isolationMode !== 'direct') bits.push(task.isolationMode);
  if (task.dependsOn.length > 0) bits.push(`⇠ ${task.dependsOn.length} dep${task.dependsOn.length > 1 ? 's' : ''}`);
  if (task.cost?.totalUsd != null) bits.push(`${task.cost.incomplete ? '≥' : ''}$${task.cost.totalUsd.toFixed(2)}`);
  return bits.join('  ');
}

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
  const [rejecting, setRejecting] = useState(false);

  const act = (fn: () => Promise<unknown>) => () => fn().then(onChanged, (e) => alert(e.message));

  return (
    <article className={`${card} p-3.5 transition-shadow duration-150 hover:ring-1 hover:ring-edge`}>
      <button
        type="button"
        className="mb-2 line-clamp-3 w-full cursor-pointer whitespace-pre-wrap text-left text-ink"
        onClick={() => onOpen(task)}
      >
        {task.prompt}
      </button>
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 truncate font-data text-data text-muted">{metaLine(task)}</span>
        {/* Priority is typographic, not chromatic (DESIGN.md § Colors);
            normal is the default and says nothing. */}
        {task.priority !== 'normal' && (
          <span
            className={`shrink-0 text-label uppercase tracking-wide ${task.priority === 'high' ? 'font-semibold text-ink' : 'font-medium text-muted'}`}
          >
            {task.priority}
          </span>
        )}
        {task.blockedOnFailed && (
          <span className="shrink-0 text-label font-semibold uppercase tracking-wide text-fail">on failed</span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2.5">
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
            <button className={btnAccept} onClick={act(() => api.acceptTask(task.id))}>
              Accept
            </button>
            <button className={btnReject} onClick={() => setRejecting(true)}>
              Reject
            </button>
          </>
        )}
        {cancellable && (
          <button className="font-medium text-muted transition-colors duration-150 hover:text-fail" onClick={act(() => api.cancelTask(task.id))}>
            Cancel
          </button>
        )}
      </div>
      {rejecting && (
        <RejectDialog
          taskId={task.id}
          onClose={() => setRejecting(false)}
          onDone={() => {
            setRejecting(false);
            onChanged();
          }}
        />
      )}
    </article>
  );
}
