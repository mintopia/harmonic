import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatCost } from '../cost';
import type { Task } from '../types';
import { TASK_STATES } from '../types';
import { btnQuiet, card, displayTitle, labelType, stateChip, tableHead } from '../ui';
import { toastError } from '../toast';
import { fetchTasks } from '../table-model';

const select =
  'rounded-md border border-edge bg-field px-2 py-1 text-ink focus:border-accent focus:outline-none';

type SortKey = 'createdAt' | 'priority' | 'cost';

export function TableView({
  workspaceId,
  onOpen,
}: {
  /** Scopes the table to the active Workspace (ADR-0008); no fetch until resolved. */
  workspaceId: number | null;
  onOpen: (task: Task) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState('');
  const [harness, setHarness] = useState('');
  const [priority, setPriority] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    if (workspaceId === null) return;
    setLoading(true);
    fetchTasks({ workspaceId, state, harness, priority, sortBy, order })
      .then(setTasks)
      .catch(toastError)
      .finally(() => setLoading(false));
  }, [workspaceId, state, harness, priority, sortBy, order]);

  // The badge links to the original, which the current filter may hide, so
  // fall back to fetching it by id.
  const openOriginal = (id: number) => {
    const found = tasks.find((t) => t.id === id);
    if (found) return onOpen(found);
    api.task(id).then(onOpen, toastError);
  };

  const sortHeader = (key: SortKey, label: string, align?: 'right', extra = '') => (
    <th
      aria-sort={sortBy === key ? (order === 'asc' ? 'ascending' : 'descending') : undefined}
      className={`py-2 ${align === 'right' ? 'text-right' : ''} ${extra}`}
    >
      {/* Buttons don't inherit text-transform, so restate the Label casing. */}
      <button
        type="button"
        className={`${labelType} cursor-pointer select-none hover:text-ink`}
        onClick={() => {
          if (sortBy === key) setOrder(order === 'asc' ? 'desc' : 'asc');
          else {
            setSortBy(key);
            setOrder('asc');
          }
        }}
      >
        {label} {sortBy === key ? (order === 'asc' ? '↑' : '↓') : ''}
      </button>
    </th>
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline gap-2">
        {/* The view's anchor figure: how many tasks the filters select. */}
        <span className="flex items-baseline gap-1.5">
          <span className={`${displayTitle} tabular-nums ${tasks.length > 0 || loading ? '' : 'text-faint'}`}>
            {loading ? '…' : tasks.length}
          </span>
          <span className={`${labelType} text-muted`}>tasks</span>
        </span>
        <div className="flex-1" />
        <select aria-label="Filter by state" className={select} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {TASK_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select aria-label="Filter by harness" className={select} value={harness} onChange={(e) => setHarness(e.target.value)}>
          <option value="">All harnesses</option>
          {['claude', 'codex', 'copilot'].map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <select aria-label="Filter by priority" className={select} value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">All priorities</option>
          {['high', 'normal', 'low'].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <div className={`${card} relative overflow-x-auto px-4 py-1`} aria-busy={loading}>
        {loading && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-t-lg"
          >
            <div className="progress-indeterminate h-full w-1/3 bg-muted" />
          </div>
        )}
        <table className="w-full text-left">
          <thead className={tableHead}>
            <tr>
              <th className="py-2.5 pr-3">#</th>
              <th>Prompt</th>
              <th>State</th>
              <th>Harness</th>
              <th>Model</th>
              {sortHeader('priority', 'Priority')}
              {sortHeader('cost', 'Cost', 'right')}
              {sortHeader('createdAt', 'Created', undefined, 'pl-4')}
            </tr>
          </thead>
          {/* Stale rows stay visible and fully legible while a refetch is in
              flight — the top-edge progress bar and aria-busy carry the loading
              signal instead of dimming the whole table below AA. */}
          <tbody>
            {tasks.map((task) => (
              <tr
                key={task.id}
                className="cursor-pointer border-t border-hairline transition-colors duration-150 hover:bg-raised"
                onClick={() => onOpen(task)}
              >
                <td className="py-2 pr-3 text-data tabular-nums text-muted">{task.id}</td>
                <td className="max-w-md pr-4">
                  {task.reattemptOf !== null && (
                    <button
                      type="button"
                      title={`Open the original, task #${task.reattemptOf}`}
                      className="mb-1 inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-label font-semibold uppercase text-muted transition-colors duration-150 hover:text-ink"
                      onClick={(e) => {
                        e.stopPropagation();
                        openOriginal(task.reattemptOf!);
                      }}
                    >
                      ↻ re-attempt of <span className="tabular-nums normal-case">#{task.reattemptOf}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="block w-full cursor-pointer truncate text-left text-ink"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(task);
                    }}
                  >
                    {task.prompt}
                  </button>
                </td>
                <td>
                  <span className={stateChip(task.state)}>{task.state}</span>
                </td>
                <td className="text-muted">{task.harness}</td>
                <td className="text-muted">{task.model}</td>
                <td className={task.priority === 'high' ? 'font-semibold text-ink' : 'text-muted'}>{task.priority}</td>
                <td className="text-right tabular-nums text-muted">{formatCost(task.cost) ?? '—'}</td>
                <td className="pl-4 text-data tabular-nums text-muted">{new Date(task.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {!loading && tasks.length === 0 && (
              <tr>
                <td colSpan={8} className="py-10 text-center">
                  {state || harness || priority ? (
                    <>
                      <p className="text-muted">No tasks match these filters.</p>
                      <button
                        className={`${btnQuiet} mt-2`}
                        onClick={() => {
                          setState('');
                          setHarness('');
                          setPriority('');
                        }}
                      >
                        Clear filters
                      </button>
                    </>
                  ) : (
                    <p className="text-muted">
                      No tasks yet. Create one on the{' '}
                      <span className="font-semibold text-ink">Board</span> — every task shows up here
                      once it exists.
                    </p>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
