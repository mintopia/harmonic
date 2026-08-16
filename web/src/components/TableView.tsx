import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatCost } from '../cost';
import type { Task } from '../types';
import { TASK_STATES } from '../types';
import { TABLE_HARNESSES, TABLE_PRIORITIES, type TableFilters, type SortKey } from '../router-model';
import { btnQuiet, card, displayTitle, labelType, stateChip, tableHead } from '../ui';
import { toastError } from '../toast';

const select =
  'rounded-md border border-edge bg-field px-2 py-1 text-ink focus:border-accent focus:outline-none';

export function TableView({
  workspaceId,
  onOpen,
  filters,
  onFiltersChange,
}: {
  /** Scopes the table to the active Workspace (ADR-0008); no fetch until resolved. */
  workspaceId: number | null;
  onOpen: (task: Task) => void;
  /** Filter/sort selection — lives in the URL (issue #103), owned by App. */
  filters: TableFilters;
  onFiltersChange: (next: TableFilters) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const { state, harness, priority, sortBy, order } = filters;

  useEffect(() => {
    if (workspaceId === null) return;
    const params = new URLSearchParams();
    params.set('workspaceId', String(workspaceId));
    if (state) params.set('state', state);
    if (harness) params.set('harness', harness);
    if (priority) params.set('priority', priority);
    params.set('sortBy', sortBy);
    params.set('order', order);
    setLoading(true);
    fetch(`/api/tasks?${params}`)
      .then((r) => r.json())
      .then((body: { tasks: Task[] }) => {
        setTasks(body.tasks);
        setLoading(false);
      });
    // Refetch when the filter/sort selection changes. App holds `filters`
    // (route.table) in state and preserves its reference across unrelated
    // navigations and the board poll, so this fires only on a real filter
    // change — not on every re-render.
  }, [workspaceId, filters]);

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
          if (sortBy === key) onFiltersChange({ ...filters, order: order === 'asc' ? 'desc' : 'asc' });
          else onFiltersChange({ ...filters, sortBy: key, order: 'asc' });
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
        <select
          aria-label="Filter by state"
          className={select}
          value={state}
          onChange={(e) => onFiltersChange({ ...filters, state: e.target.value })}
        >
          <option value="">All states</option>
          {TASK_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by harness"
          className={select}
          value={harness}
          onChange={(e) => onFiltersChange({ ...filters, harness: e.target.value })}
        >
          <option value="">All harnesses</option>
          {TABLE_HARNESSES.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by priority"
          className={select}
          value={priority}
          onChange={(e) => onFiltersChange({ ...filters, priority: e.target.value })}
        >
          <option value="">All priorities</option>
          {TABLE_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <div className={`${card} overflow-x-auto px-4 py-1`}>
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
          {/* Stale rows stay visible while a refetch is in flight, dimmed so the
              "Loading…" count isn't the only signal. */}
          <tbody className={loading ? 'opacity-60' : ''}>
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
                        onClick={() => onFiltersChange({ ...filters, state: '', harness: '', priority: '' })}
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
