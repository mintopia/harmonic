import type { Task, TaskState } from '../types';
import { TASK_STATES } from '../types';
import { TaskCard } from './TaskCard';

const COLUMN_LABELS: Record<TaskState, string> = {
  draft: 'Draft',
  blocked: 'Blocked',
  ready: 'Ready',
  running: 'Running',
  'awaiting-review': 'Awaiting Review',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function Board({
  tasks,
  onEdit,
  onChanged,
}: {
  tasks: Task[];
  onEdit: (task: Task) => void;
  onChanged: () => void;
}) {
  return (
    <div className="grid auto-cols-[minmax(220px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-4">
      {TASK_STATES.map((state) => {
        const column = tasks
          .filter((t) => t.state === state)
          .sort((a, b) => b.createdAt - a.createdAt);
        return (
          <section key={state} className="rounded-lg bg-zinc-900/60 p-2">
            <h2 className="mb-2 flex items-baseline justify-between px-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {COLUMN_LABELS[state]}
              <span className="text-zinc-600">{column.length}</span>
            </h2>
            <div className="flex flex-col gap-2">
              {column.map((task) => (
                <TaskCard key={task.id} task={task} onEdit={onEdit} onChanged={onChanged} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
