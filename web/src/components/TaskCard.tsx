import type { Task } from '../types';
import { card } from '../ui';
import { TaskActions } from './TaskActions';

/** One truncating metadata line: id, harness · model, then only the facts
 * that deviate from defaults (isolation, deps, cost). Sans, not mono — these
 * are names and figures, not code (the Mono Is Code Rule); never chip slabs. */
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
        <span className="min-w-0 truncate text-small text-muted">{metaLine(task)}</span>
        {/* Priority is typographic, not chromatic (DESIGN.md § Colors);
            normal is the default and says nothing. */}
        {task.priority !== 'normal' && (
          <span
            className={`shrink-0 text-label uppercase ${task.priority === 'high' ? 'font-semibold text-ink' : 'font-medium text-muted'}`}
          >
            {task.priority}
          </span>
        )}
        {task.blockedOnFailed && (
          <span className="shrink-0 text-label font-semibold uppercase text-fail">on failed</span>
        )}
      </div>
      <TaskActions task={task} variant="card" onEdit={onEdit} onChanged={onChanged} />
    </article>
  );
}
