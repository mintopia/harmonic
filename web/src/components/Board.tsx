import { useEffect, useRef, useState } from 'react';
import type { Task, TaskState } from '../types';
import { boardColumns, canDrag, dropAction, type DropAction } from '../board-model';
import { api } from '../api';
import { toastError } from '../toast';
import { TaskCard } from './TaskCard';
import { Icon } from './Icon';
import { btnPrimary, btnQuiet, displayTitle, laneBorder, laneDot, stateCountPill } from '../ui';

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
        <div key={i} className="w-[262px] shrink-0">
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

// The active pipeline, in flow order — the same lanes a populated board shows,
// so the empty board already teaches its own shape (DESIGN.md § The Board).
const ACTIVE_LANES: TaskState[] = ['draft', 'blocked', 'ready', 'running', 'awaiting-review'];

// The three beats of the first run. Each carries the lane colour of the state
// the task reaches at that beat (ready green → running amber → awaiting cobalt),
// so the guide below speaks the same signal language as the empty lanes above —
// and beat two names the one cold-start cliff (a ready task waits for you while
// the auto-runner is off) before the operator can trip over it.
const FIRST_RUN_STEPS: { state: TaskState; title: string; body: string }[] = [
  { state: 'ready', title: 'Create a task', body: 'Describe the work and point it at a repo on this machine.' },
  { state: 'running', title: 'Start it', body: 'Press Run now on the card, or turn the auto-runner on to start ready tasks for you.' },
  {
    state: 'awaiting-review',
    title: 'Review the result',
    body: "The agent's steps stream live; read the diff and accept to merge.",
  },
];

/** The first-run board: the real (empty) pipeline lanes so the operator learns
 * the board's shape, with one quiet guide and a single primary action driving
 * to the first agent run — no tour, no overlay, the console teaches itself. */
function FirstRunBoard({ onNewTask }: { onNewTask: () => void }) {
  return (
    <div>
      <div aria-hidden="true" className="flex gap-4 overflow-x-auto pb-1 opacity-70">
        {ACTIVE_LANES.map((state) => (
          <div key={state} className="w-[262px] shrink-0">
            <h2 className={`flex items-center gap-2 border-b-2 ${laneBorder(state)} px-0.5 pb-2`}>
              <span className={`size-2 shrink-0 rounded-full ${laneDot(state)}`} />
              <span className="font-semibold text-ink">{COLUMN_LABELS[state]}</span>
              <span className={stateCountPill(state, 0)}>0</span>
            </h2>
          </div>
        ))}
      </div>

      <div className="mx-auto mt-12 max-w-xl text-center">
        <h2 className={displayTitle}>Run your first agent</h2>
        <p className="mx-auto mt-2 max-w-md text-muted">
          Harmonic queues a task, runs an agent on it unattended, and holds the result at a review
          gate until you accept the merge.
        </p>
        <ol className="mx-auto mt-7 flex max-w-md flex-col gap-3.5 text-left">
          {FIRST_RUN_STEPS.map((step) => (
            <li key={step.title} className="flex gap-3">
              <span
                aria-hidden="true"
                className={`mt-2 size-2 shrink-0 rounded-full ${laneDot(step.state)}`}
              />
              <span>
                <span className="font-semibold text-ink">{step.title}</span>{' '}
                <span className="text-muted">— {step.body}</span>
              </span>
            </li>
          ))}
        </ol>
        <button className={`${btnPrimary} mt-8`} onClick={onNewTask}>
          Create your first task
        </button>
      </div>
    </div>
  );
}

export function Board({
  tasks,
  loading,
  onEdit,
  onOpen,
  onChanged,
  onNewTask,
  peeked,
  onTogglePeek,
}: {
  tasks: Task[];
  loading: boolean;
  onEdit: (task: Task) => void;
  onOpen: (task: Task) => void;
  onChanged: () => void;
  onNewTask: () => void;
  /** Terminal columns the operator has peeked open (lives in the URL — issue
   * #103); everything else keeps to the finished panel so the board's
   * geometry never reflows under load. */
  peeked: ReadonlySet<TaskState>;
  onTogglePeek: (state: TaskState) => void;
}) {
  // The card currently being dragged (issue #58). Its source state decides
  // which columns are valid drops; we don't move optimistically, so an invalid
  // drop is simply a no-op and the card snaps back on its own.
  const [dragging, setDragging] = useState<{ id: number; state: TaskState } | null>(null);

  const runDrop = (action: DropAction, id: number) => {
    const call: Record<DropAction, (id: number) => Promise<unknown>> = {
      promote: api.promoteTask,
      requeue: api.requeueTask,
      uncancel: api.uncancelTask,
      cancel: api.cancelTask,
    };
    call[action](id).then(onChanged, toastError);
  };

  // Drop-target wiring for a column. Only preventDefault (which arms the drop)
  // when the drag maps to a real action, so the browser shows a no-drop cursor
  // over invalid columns and nothing happens if the operator releases there.
  const dropProps = (to: TaskState) => {
    const action = dragging ? dropAction(dragging.state, to) : null;
    if (!action) return { valid: false, handlers: {} };
    return {
      valid: true,
      handlers: {
        onDragOver: (e: React.DragEvent) => e.preventDefault(),
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          runDrop(action, dragging!.id);
          setDragging(null);
        },
      },
    };
  };

  const cardDragProps = (task: Task) =>
    canDrag(task.state)
      ? {
          draggable: true,
          dragging: dragging?.id === task.id,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.effectAllowed = 'move';
            // Firefox won't start a drag unless dragstart sets some data.
            e.dataTransfer.setData('text/plain', String(task.id));
            setDragging({ id: task.id, state: task.state });
          },
          onDragEnd: () => setDragging(null),
        }
      : {};

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

  if (tasks.length === 0) return <FirstRunBoard onNewTask={onNewTask} />;

  const togglePeek = (state: TaskState) => {
    focusTarget.current = peeked.has(state)
      ? { kind: 'row', state }
      : { kind: 'collapse', state };
    onTogglePeek(state);
  };

  const columns = boardColumns(tasks);
  const collapsedTerminal = columns.filter(({ state, terminal }) => terminal && !peeked.has(state));

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map(({ state, terminal, tasks: column }) => {
        if (terminal && !peeked.has(state)) return null;
        const drop = dropProps(state);
        return (
          // Fixed width + shrink-0 so peeking a terminal column appends and
          // scrolls the row (board container is overflow-x-auto) instead of
          // shrinking the pipeline columns. Load-independent geometry: the
          // operator's glance targets never move (DESIGN.md § The Board).
          <section
            key={state}
            {...drop.handlers}
            className={`w-[262px] shrink-0 rounded-lg transition-colors duration-150 motion-reduce:transition-none ${
              drop.valid ? 'bg-accent-tint ring-2 ring-accent' : ''
            }`}
          >
            {/* Lane colour lives on the header (Aurora's signal layer): a
                state-coloured underline + dot, so the board reads with colour
                while the task cards below stay calm. */}
            <h2 className={`mb-3 flex items-center gap-2 border-b-2 ${laneBorder(state)} px-0.5 pb-2`}>
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${laneDot(state)}`} />
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
                <TaskCard
                  key={task.id}
                  task={task}
                  onEdit={onEdit}
                  onOpen={onOpen}
                  onChanged={onChanged}
                  {...cardDragProps(task)}
                />
              ))}
            </div>
          </section>
        );
      })}

      {/* Finished work lives in one quiet inset panel: counts at a glance,
          click a row to expand that column in place. The full terminal
          history lives in the Table view. */}
      {collapsedTerminal.length > 0 && (
        /* relative: sr-only below is position:absolute, and an abspos element is
           only clipped by a *positioned* ancestor. Without a containing block here
           it escapes the board's overflow-x-auto, anchors to the document, and
           stretches the page's scroll width — a horizontal scrollbar into empty
           space whenever the board overflows. */
        <aside aria-label="Finished tasks" className="relative w-36 shrink-0 rounded-lg bg-raised p-2.5">
          <h2 className="sr-only">Finished</h2>
          <div className="flex flex-col">
            {collapsedTerminal.map(({ state, tasks: column }) => {
              const drop = dropProps(state);
              return (
                <button
                  key={state}
                  ref={(el) => {
                    panelRowRefs.current.set(state, el);
                  }}
                  {...drop.handlers}
                  aria-expanded={false}
                  aria-label={`Expand ${COLUMN_LABELS[state]} column (${column.length} tasks)`}
                  className={`group flex items-center gap-2 rounded-md px-1.5 py-1.5 text-muted transition-colors duration-150 hover:bg-surface hover:text-ink motion-reduce:transition-none ${
                    drop.valid ? 'bg-accent-tint text-ink ring-2 ring-accent' : ''
                  }`}
                  onClick={() => togglePeek(state)}
                >
                  <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${laneDot(state)}`} />
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
              );
            })}
          </div>
        </aside>
      )}
    </div>
  );
}
