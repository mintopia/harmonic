import { useEffect, useRef, useState } from 'react';
import type { Task, TaskState } from '../types';
import { boardColumns } from '../board-model';
import { TaskCard } from './TaskCard';
import { Icon } from './Icon';
import { btnQuiet, stateCountPill } from '../ui';

const COLUMN_LABELS: Record<TaskState, string> = {
  draft: 'Draft',
  blocked: 'Blocked',
  ready: 'Ready',
  running: 'Running',
  'awaiting-review': 'Awaiting review',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Placeholder columns while the first load is in flight — skeletons,
 * not a spinner, so the board's geometry is stable from the first paint. */
function BoardSkeleton() {
  return (
    <div aria-hidden="true" className="flex animate-pulse gap-4 overflow-hidden pb-4 motion-reduce:animate-none">
      {[3, 2, 1, 2, 1].map((cards, i) => (
        <div key={i} className="w-60 shrink-0">
          <div className="mb-3 h-5 w-24 rounded-full bg-raised" />
          <div className="flex flex-col gap-3">
            {Array.from({ length: cards }, (_, j) => (
              <div key={j} className="h-24 rounded-lg bg-raised" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

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
  // to the finished panel so the board's geometry never reflows under load.
  const [peeked, setPeeked] = useState<ReadonlySet<TaskState>>(new Set());

  // Disclosure focus loop: toggling a terminal column moves or unmounts the
  // button that was clicked (expanding the last one removes the whole finished
  // panel), so we hand focus to the control that now reflects the new state —
  // expand → the column's Collapse button (also scrolls it into view when the
  // board has scrolled), collapse → its row back in the finished panel. Keeps
  // a full keyboard path through the board (PRODUCT.md a11y contract).
  const collapseBtnRefs = useRef(new Map<TaskState, HTMLButtonElement | null>());
  const panelRowRefs = useRef(new Map<TaskState, HTMLButtonElement | null>());
  const focusTarget = useRef<{ kind: 'collapse' | 'row'; state: TaskState } | null>(null);

  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    focusTarget.current = null;
    const refs = target.kind === 'collapse' ? collapseBtnRefs : panelRowRefs;
    refs.current.get(target.state)?.focus();
  }, [peeked]);

  if (loading) return <BoardSkeleton />;

  if (tasks.length === 0) {
    return (
      <div className="mx-auto mt-24 max-w-md text-center text-muted">
        <p className="mb-2 text-title font-semibold text-ink">No tasks yet</p>
        <p>
          Create your first task with <span className="font-semibold text-ink">New task</span>. Drafts wait on the
          board; ready tasks start when you run them or the auto-runner picks them up.
        </p>
      </div>
    );
  }

  const togglePeek = (state: TaskState) =>
    setPeeked((current) => {
      const next = new Set(current);
      if (next.has(state)) {
        next.delete(state);
        focusTarget.current = { kind: 'row', state };
      } else {
        next.add(state);
        focusTarget.current = { kind: 'collapse', state };
      }
      return next;
    });

  const columns = boardColumns(tasks);
  const collapsedTerminal = columns.filter(({ state, terminal }) => terminal && !peeked.has(state));

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map(({ state, terminal, tasks: column }) => {
        if (terminal && !peeked.has(state)) return null;
        return (
          // Fixed width + shrink-0 so peeking a terminal column appends and
          // scrolls the row (board container is overflow-x-auto) instead of
          // shrinking the pipeline columns. Load-independent geometry: the
          // operator's glance targets never move (DESIGN.md § The Board).
          <section key={state} className="w-60 shrink-0">
            <h2 className="mb-3 flex items-baseline gap-2 px-0.5">
              <span className="font-semibold text-ink">{COLUMN_LABELS[state]}</span>
              <span className={stateCountPill(state, column.length)}>{column.length}</span>
              {terminal && (
                <button
                  ref={(el) => {
                    collapseBtnRefs.current.set(state, el);
                  }}
                  aria-expanded={true}
                  aria-label={`Collapse ${COLUMN_LABELS[state]} column`}
                  className={`ml-auto ${btnQuiet}`}
                  onClick={() => togglePeek(state)}
                >
                  Collapse
                </button>
              )}
            </h2>
            <div className="flex flex-col gap-3">
              {column.map((task) => (
                <TaskCard key={task.id} task={task} onEdit={onEdit} onOpen={onOpen} onChanged={onChanged} />
              ))}
            </div>
          </section>
        );
      })}

      {/* Finished work lives in one quiet inset panel: counts at a glance,
          click a row to expand that column in place. The full terminal
          history lives in the Table view. */}
      {collapsedTerminal.length > 0 && (
        <aside aria-label="Finished tasks" className="w-36 shrink-0 rounded-lg bg-raised p-2.5">
          <h2 className="sr-only">Finished</h2>
          <div className="flex flex-col">
            {collapsedTerminal.map(({ state, tasks: column }) => (
              <button
                key={state}
                ref={(el) => {
                  panelRowRefs.current.set(state, el);
                }}
                aria-expanded={false}
                aria-label={`Expand ${COLUMN_LABELS[state]} column (${column.length} tasks)`}
                className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 text-muted transition-colors duration-150 hover:bg-surface hover:text-ink"
                onClick={() => togglePeek(state)}
              >
                {COLUMN_LABELS[state]}
                <span
                  className={`ml-auto font-semibold ${
                    state === 'failed' && column.length > 0
                      ? 'text-fail'
                      : column.length > 0
                        ? 'text-ink'
                        : 'text-faint'
                  }`}
                >
                  {column.length}
                </span>
                {/* Persistent disclosure caret so the row reads as expandable
                    at rest, not only on hover (points right = closed). */}
                <Icon name="chevron-down" className="size-3.5 -rotate-90 text-faint group-hover:text-muted" />
              </button>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
