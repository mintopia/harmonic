import { useState } from 'react';
import type { Task, TaskState } from '../types';
import { boardColumns } from '../board-model';
import { TaskCard } from './TaskCard';
import { labelType } from '../ui';

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
  // Terminal columns the operator has peeked open; everything else keeps
  // the hybrid default so the board's geometry never reflows under load.
  const [peeked, setPeeked] = useState<ReadonlySet<TaskState>>(new Set());

  if (loading) return <p className="mt-24 text-center text-muted">Loading…</p>;

  if (tasks.length === 0) {
    return (
      <div className="mx-auto mt-24 max-w-md text-center text-muted">
        <p className="mb-2 text-title font-semibold text-ink">No tasks yet</p>
        <p>
          Create your first task with <span className="font-semibold text-ink">New Task</span>. Drafts wait on the
          board; ready tasks start when you run them or the Auto-Runner picks them up.
        </p>
      </div>
    );
  }

  const togglePeek = (state: TaskState) =>
    setPeeked((current) => {
      const next = new Set(current);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });

  return (
    <div className="flex gap-2 overflow-x-auto pb-4">
      {boardColumns(tasks).map(({ state, terminal, tasks: column }) => {
        if (terminal && !peeked.has(state)) {
          return (
            <button
              key={state}
              aria-expanded={false}
              aria-label={`Expand ${COLUMN_LABELS[state]} column (${column.length} tasks)`}
              className="flex w-9 shrink-0 justify-center rounded-md border border-hairline bg-surface py-2.5 transition-colors duration-150 hover:bg-raised"
              onClick={() => togglePeek(state)}
            >
              <span className={`${labelType} text-muted`} style={{ writingMode: 'vertical-rl' }}>
                {COLUMN_LABELS[state]}
                <span className={`mt-2 font-normal ${state === 'failed' && column.length > 0 ? 'text-fail' : ''}`}>
                  {column.length}
                </span>
              </span>
            </button>
          );
        }
        return (
          <section key={state} className="min-w-[200px] flex-1 rounded-md bg-surface p-2">
            <h2 className={`mb-2 flex items-baseline gap-2 px-1 ${labelType} text-muted`}>
              {COLUMN_LABELS[state]}
              <span className="font-normal">{column.length}</span>
              {terminal && (
                <button
                  aria-expanded={true}
                  aria-label={`Collapse ${COLUMN_LABELS[state]} column`}
                  className="ml-auto font-normal normal-case tracking-normal text-muted hover:text-ink"
                  onClick={() => togglePeek(state)}
                >
                  Collapse
                </button>
              )}
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
