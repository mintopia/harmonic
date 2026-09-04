import { useEffect, useState } from 'react';
import { formatCost } from '../cost';
import type { Task } from '../types';
import { TASK_STATES } from '../types';
import { TABLE_HARNESSES, TABLE_PRIORITIES, type TableFilters, type SortKey } from '../router-model';
import {
  btnGhost,
  btnQuiet,
  chip,
  displayTitle,
  labelType,
  searchField,
  stateChip,
  stateDot,
  tableHeadRow,
  tableShell,
  touchOverlay,
} from '../ui';
import { toastError } from '../toast';
import { fetchTasks, TABLE_PAGE_SIZE } from '../table-model';
import { issueRef, ticketRowId } from '../id-format.js';
import { EmptyState } from './EmptyState';
import { FilterSelect } from './FilterSelect';
import { ModelLabel, ProviderChip, TaskIdentity } from './TaskIdentity';

/** The dropped header + row cells hide together (`hidden md:*`/`hidden lg:*`) so
 * the DOM cell count always matches the active track count and the ARIA grid
 * stays valid at every width. */
const GRID =
  'grid grid-cols-[7.5rem_minmax(0,1fr)_8rem] md:grid-cols-[7.5rem_minmax(0,1fr)_8rem_5rem_5.5rem] lg:grid-cols-[7.5rem_minmax(0,1fr)_8rem_6rem_9rem_5rem_5.5rem_8rem_8rem] items-center gap-x-3 px-4';

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function TableView({
  workspaceId,
  onOpen,
  onOpenEpic,
  filters,
  onFiltersChange,
}: {
  /** Scopes the table to the active Workspace; no fetch until resolved. */
  workspaceId: number | null;
  onOpen: (task: Task) => void;
  /** Opens the Board focused on an epic's summary panel, keyed by tracker ref. */
  onOpenEpic: (ref: number) => void;
  /** Filter/sort selection — lives in the URL, owned by App. */
  filters: TableFilters;
  onFiltersChange: (next: TableFilters) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const { state, harness, priority, search, sortBy, order } = filters;
  const stateKey = state.join(',');
  const harnessKey = harness.join(',');
  const priorityKey = priority.join(',');

  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [workspaceId, stateKey, harnessKey, priorityKey, sortBy, order, debouncedSearch]);

  useEffect(() => {
    if (workspaceId === null) return;
    setLoading(true);
    fetchTasks({
      workspaceId,
      state,
      harness,
      priority,
      q: debouncedSearch,
      sortBy,
      order,
      limit: TABLE_PAGE_SIZE,
      offset: (page - 1) * TABLE_PAGE_SIZE,
    })
      .then(({ tasks, total }) => {
        setTasks(tasks);
        setTotal(total);
      })
      .catch(toastError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filter arrays are tracked via their joined keys so a new reference alone can't refetch
  }, [workspaceId, stateKey, harnessKey, priorityKey, debouncedSearch, sortBy, order, page]);

  const pageCount = Math.max(1, Math.ceil(total / TABLE_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageTasks = tasks;

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const sortHeader = (key: SortKey, label: string, opts?: { align?: 'right'; tier?: 'md' | 'lg' }) => (
    <span
      role="columnheader"
      aria-sort={sortBy === key ? (order === 'asc' ? 'ascending' : 'descending') : undefined}
      className={`hidden ${opts?.tier === 'lg' ? 'lg:block' : 'md:block'} ${opts?.align === 'right' ? 'text-right' : ''}`}
    >
      {/* Buttons don't inherit text-transform, so restate the Label casing. */}
      <button
        type="button"
        className="relative inline-flex cursor-pointer select-none items-center gap-0.5 uppercase hover:text-ink"
        onClick={() => {
          if (sortBy === key) onFiltersChange({ ...filters, order: order === 'asc' ? 'desc' : 'asc' });
          else onFiltersChange({ ...filters, sortBy: key, order: 'asc' });
        }}
      >
        {label} {sortBy === key ? (order === 'asc' ? '↑' : '↓') : ''}
        <span aria-hidden="true" className={touchOverlay} />
      </button>
    </span>
  );

  const renderRow = (task: Task) => (
    <div
      key={task.id}
      role="row"
      className={`${GRID} min-h-11 cursor-pointer py-2 transition-colors duration-150 hover:bg-raised/50`}
      onClick={() => onOpen(task)}
    >
      <div role="cell" className="flex items-center justify-end gap-1.5 whitespace-nowrap tabular-nums text-muted">
        <span aria-hidden="true" className={stateDot(task.state)} />
        <span className="sr-only">Id: </span>
        {ticketRowId(task.id, task.trackerRef)}
      </div>
      <div role="cell" className="flex min-w-0 items-center gap-2 pr-2">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            title={task.summary}
            className="block w-full cursor-pointer truncate text-left text-ink"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(task);
            }}
          >
            {task.summary}
          </button>
          <div className="mt-1 lg:hidden">
            <TaskIdentity harness={task.harness} model={task.model} compact className="text-small" />
          </div>
        </div>
      </div>
      <div role="cell">
        <span className={`${stateChip(task.state)} capitalize`}>{task.state}</span>
      </div>
      <div role="cell" className="hidden lg:block">
        <ProviderChip harness={task.harness} />
      </div>
      <div role="cell" className="hidden lg:block">
        <ModelLabel model={task.model} className="text-muted" />
      </div>
      <div
        role="cell"
        className={`hidden capitalize md:block ${task.priority === 'high' ? 'font-semibold text-ink' : 'text-muted'}`}
      >
        {task.priority}
      </div>
      <div role="cell" className="hidden text-right tabular-nums text-muted md:block">
        <span className="sr-only">Cost: </span>
        {formatCost(task.cost) ?? '—'}
      </div>
      <div role="cell" className="hidden text-right tabular-nums text-faint lg:block">
        <span className="sr-only">Created: </span>
        {fmtTime(task.createdAt)}
      </div>
      <div role="cell" className="hidden text-right tabular-nums text-faint lg:block">
        <span className="sr-only">Updated: </span>
        {fmtTime(task.updatedAt)}
      </div>
    </div>
  );

  const renderEpicRow = (task: Task) => (
    <div
      key={`epic-${task.trackerRef ?? task.id}`}
      role="row"
      className={`${GRID} min-h-11 cursor-pointer py-2 transition-colors duration-150 hover:bg-raised/50`}
      onClick={() => onOpenEpic(task.trackerRef ?? task.id)}
    >
      <div role="cell" className="flex items-center justify-end gap-1.5 whitespace-nowrap tabular-nums text-muted">
        <span className="sr-only">Issue: </span>
        {issueRef(task.trackerRef ?? task.id)}
      </div>
      <div role="cell" className="flex min-w-0 items-center gap-2 pr-2">
        <span className={`${chip} shrink-0 bg-accent-tint text-accent`}>
          <span className="sr-only">Epic: </span>epic
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            title={task.summary}
            className="block w-full cursor-pointer truncate text-left text-ink"
            onClick={(e) => {
              e.stopPropagation();
              onOpenEpic(task.trackerRef ?? task.id);
            }}
          >
            {task.summary}
          </button>
        </div>
      </div>
      <div role="cell" className="text-muted">
        —
      </div>
      <div role="cell" className="hidden text-muted lg:block">
        —
      </div>
      <div role="cell" className="hidden text-muted lg:block">
        —
      </div>
      <div role="cell" className="hidden text-muted md:block">
        —
      </div>
      <div role="cell" className="hidden text-right tabular-nums text-muted md:block">
        <span className="sr-only">Cost: </span>—
      </div>
      <div role="cell" className="hidden text-right tabular-nums text-faint lg:block">
        <span className="sr-only">Created: </span>
        {fmtTime(task.createdAt)}
      </div>
      <div role="cell" className="hidden text-right tabular-nums text-faint lg:block">
        <span className="sr-only">Updated: </span>
        {fmtTime(task.updatedAt)}
      </div>
    </div>
  );

  return (
    <div>
      <h1 className="sr-only">Tasks</h1>
      <div className="mb-4 flex flex-wrap items-baseline gap-2">
        <span className="flex items-baseline gap-1.5">
          <span className={`${displayTitle} tabular-nums ${total > 0 || loading ? '' : 'text-faint'}`}>
            {loading ? '…' : total}
          </span>
          <span className={`${labelType} text-muted`}>tasks</span>
        </span>
        <div className="flex-1" />
        <input
          type="search"
          aria-label="Search prompts"
          placeholder="Search prompts"
          className={`${searchField} w-full sm:w-56`}
          value={search}
          onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
        />
        <FilterSelect
          label="State"
          allLabel="All states"
          options={TASK_STATES}
          selected={state}
          onChange={(next) => onFiltersChange({ ...filters, state: next })}
          capitalize
        />
        <FilterSelect
          label="Harness"
          allLabel="All harnesses"
          options={TABLE_HARNESSES}
          selected={harness}
          onChange={(next) => onFiltersChange({ ...filters, harness: next })}
        />
        <FilterSelect
          label="Priority"
          allLabel="All priorities"
          options={TABLE_PRIORITIES}
          selected={priority}
          onChange={(next) => onFiltersChange({ ...filters, priority: next })}
          capitalize
        />
      </div>

      <div className={`${tableShell} relative`} aria-busy={loading} role="table" aria-label="Tasks">
        {loading && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-t-xl"
          >
            <div className="progress-indeterminate h-full w-1/3 bg-muted" />
          </div>
        )}

        <div role="rowgroup">
          <div role="row" className={`${GRID} ${tableHeadRow}`}>
            <span role="columnheader" className="text-right">
              #
            </span>
            <span role="columnheader">Prompt</span>
            <span role="columnheader">State</span>
            <span role="columnheader" className="hidden lg:block">
              Harness
            </span>
            <span role="columnheader" className="hidden lg:block">
              Model
            </span>
            {sortHeader('priority', 'Priority')}
            {sortHeader('cost', 'Cost', { align: 'right' })}
            {sortHeader('createdAt', 'Created', { align: 'right', tier: 'lg' })}
            {sortHeader('updatedAt', 'Updated', { align: 'right', tier: 'lg' })}
          </div>
        </div>

        <div role="rowgroup" className="divide-y divide-hairline">
          {pageTasks.map((t) => (t.isEpic ? renderEpicRow(t) : renderRow(t)))}
        </div>

        {!loading && total === 0 && (
          <div className="px-4">
            {state.length || harness.length || priority.length || search ? (
              <EmptyState
                title="No matches"
                className="my-8"
                action={
                  <button
                    className={btnQuiet}
                    onClick={() =>
                      onFiltersChange({ ...filters, state: [], harness: [], priority: [], search: '' })
                    }
                  >
                    Clear filters
                  </button>
                }
              >
                No tasks match these filters.
              </EmptyState>
            ) : (
              <EmptyState title="No tasks yet" className="my-8">
                Create one on the Board to get started.
              </EmptyState>
            )}
          </div>
        )}
      </div>

      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-small tabular-nums text-muted">
            {total === 0 ? 0 : (currentPage - 1) * TABLE_PAGE_SIZE + 1}–
            {(currentPage - 1) * TABLE_PAGE_SIZE + pageTasks.length} of {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={btnGhost}
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
            >
              Prev
            </button>
            <span className="text-small tabular-nums text-muted">
              Page {currentPage} of {pageCount}
            </span>
            <button
              type="button"
              className={btnGhost}
              disabled={currentPage >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
