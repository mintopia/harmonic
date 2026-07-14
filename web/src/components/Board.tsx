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
  loading,
  onEdit,
  onOpen,
  onChanged,
}: {
  tasks: Task[];
  loading: boolean;
  onEdit: (task: Task) => void;
  onOpen: (task: Task) => void;
  onChanged: () => void;
}) {
  if (loading) return <p className="mt-24 text-center text-sm text-zinc-400">Loading…</p>;

  if (tasks.length === 0) {
    return (
      <div className="mx-auto mt-24 max-w-md text-center text-sm text-zinc-400">
        <p className="mb-2 text-base font-medium text-zinc-200">No tasks yet</p>
        <p>
          Create your first task with <span className="font-medium text-amber-400">New Task</span>. Drafts wait on the
          board; ready tasks start when you run them or the Auto-Runner picks them up.
        </p>
      </div>
    );
  }

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
              <span className="font-normal tabular-nums text-zinc-400">{column.length}</span>
            </h2>
            <div className="flex flex-col gap-2">
              {column.map((task) => (
                <TaskCard key={task.id} task={task} onEdit={onEdit} onOpen={onOpen} onChanged={onChanged} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
