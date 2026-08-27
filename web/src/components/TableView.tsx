import { useEffect, useMemo, useState } from 'react';
import { formatCost } from '../cost';
import type { Task } from '../types';
import { TASK_STATES } from '../types';
import type { Epic, EpicIntegrateOutcome } from '../epic-model';
import { FORCE_INTEGRATE_CONSEQUENCE, epicByTaskId } from '../epic-model';
import { TABLE_HARNESSES, TABLE_PRIORITIES, type TableFilters, type SortKey } from '../router-model';
import {
  btnGhost,
  btnQuiet,
  btnQuietDestructive,
  displayTitle,
  labelType,
  panel,
  searchField,
  selectField,
  stateChip,
  stateDot,
  tableHead,
  toolChip,
  touchOverlay,
  touchTargetInline,
} from '../ui';
import { toastError, toastIntegrateOutcome } from '../toast';
import { fetchTasks, TABLE_PAGE_SIZE } from '../table-model';
import { taskKey } from '../id-format.js';
import { EmptyState } from './EmptyState';
import { ArmedButton } from './ArmedButton';
import { Icon } from './Icon';
import { ModelLabel, ProviderChip, TaskIdentity } from './TaskIdentity';

/** The dropped header + row cells hide together (`hidden md:*`/`hidden lg:*`) so
 * the DOM cell count always matches the active track count and the ARIA grid
 * stays valid at every width. */
const GRID =
  'grid grid-cols-[3rem_minmax(0,1fr)_8rem] md:grid-cols-[3rem_minmax(0,1fr)_8rem_5rem_5.5rem] lg:grid-cols-[3rem_minmax(0,1fr)_8rem_6rem_9rem_5rem_5.5rem_12rem] items-center gap-x-3 px-4';

function EpicBandHeader({
  epic,
  collapsed,
  onToggle,
  onForceIntegrateEpic,
}: {
  epic: Epic;
  collapsed: boolean;
  onToggle: () => void;
  onForceIntegrateEpic?: (epicRef: number) => Promise<EpicIntegrateOutcome>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 bg-raised/40 px-4 py-1.5">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} Epic #${epic.ref}`}
        className={`${touchTargetInline} shrink-0 text-faint transition-colors duration-150 hover:text-ink`}
        onClick={onToggle}
      >
        <Icon name="chevron-down" className={collapsed ? '-rotate-90' : ''} />
      </button>
      <span className={toolChip}>{epic.kind}</span>
      <span className="truncate font-semibold text-ink">{epic.title}</span>
      <span className="font-data text-small text-faint">epic/{epic.ref}</span>
      <span className="text-small tabular-nums text-muted">
        {epic.foldedCount}/{epic.memberCount} merged
      </span>
      <div className="flex-1" />
      {onForceIntegrateEpic && (
        <div className="flex shrink-0 flex-col items-end gap-1">
          <ArmedButton
            label="Force-merge"
            armedLabel="Confirm force-merge"
            ariaLabel={`Force-merge Epic #${epic.ref}`}
            className={btnQuietDestructive}
            onConfirm={() => {
              onForceIntegrateEpic(epic.ref).then(toastIntegrateOutcome, toastError);
            }}
          />
          <p className="max-w-[220px] text-right text-label text-faint">{FORCE_INTEGRATE_CONSEQUENCE}.</p>
        </div>
      )}
    </div>
  );
}

export function TableView({
  workspaceId,
  onOpen,
  filters,
  onFiltersChange,
  epics = [],
  onForceIntegrateEpic,
}: {
  /** Scopes the table to the active Workspace (ADR-0008); no fetch until resolved. */
  workspaceId: number | null;
  onOpen: (task: Task) => void;
  /** Filter/sort selection — lives in the URL (issue #103), owned by App. */
  filters: TableFilters;
  onFiltersChange: (next: TableFilters) => void;
  /** The active Workspace's Epics (issue #167, ADR-0026): groups member rows
   * into collapsible bands; empty means the table stays a flat list. */
  epics?: Epic[];
  onForceIntegrateEpic?: (epicRef: number) => Promise<EpicIntegrateOutcome>;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [collapsedBands, setCollapsedBands] = useState<ReadonlySet<number>>(new Set());
  const { state, harness, priority, search, sortBy, order } = filters;

  // Search is server-side now (ADR-0045): debounce the box so a keystroke burst
  // folds to a single request instead of a fetch per character.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset to page 1 whenever the query (filters, search, or sort) changes, so
  // narrowing the list never strands the operator on a page past the new end.
  useEffect(() => {
    setPage(1);
  }, [workspaceId, state, harness, priority, sortBy, order, debouncedSearch]);

  useEffect(() => {
    if (workspaceId === null) return;
    setLoading(true);
    // Filter/search/sort/paginate are all server-side now (ADR-0045).
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
  }, [workspaceId, state, harness, priority, debouncedSearch, sortBy, order, page]);

  const pageCount = Math.max(1, Math.ceil(total / TABLE_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageTasks = tasks;

  // Pull the requested page back in range when a smaller `total` shrinks the
  // page count (a deletion, say), so the offset the next fetch sends can never
  // strand the operator on a blank page past the end.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const epicLookup = useMemo(() => epicByTaskId(epics), [epics]);
  const bands = epics
    .map((epic) => ({ epic, members: pageTasks.filter((t) => epicLookup.get(t.id) === epic) }))
    .filter((band) => band.members.length > 0);
  const ungrouped = pageTasks.filter((t) => !epicLookup.has(t.id));

  const toggleBand = (epicRef: number) => {
    setCollapsedBands((current) => {
      const next = new Set(current);
      if (next.has(epicRef)) next.delete(epicRef);
      else next.add(epicRef);
      return next;
    });
  };

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

  const renderRow = (task: Task, indent = false) => (
    <div
      key={task.id}
      role="row"
      className={`${GRID} min-h-11 cursor-pointer py-2 transition-colors duration-150 hover:bg-raised/50 ${indent ? 'pl-7' : ''}`}
      onClick={() => onOpen(task)}
    >
      <div role="cell" className="flex items-center justify-end gap-1.5 tabular-nums text-muted">
        <span aria-hidden="true" className={stateDot(task.state)} />
        <span className="sr-only">Id: </span>
        {taskKey(task.id)}
      </div>
      <div role="cell" className="min-w-0 pr-2">
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
      <div role="cell">
        <span className={stateChip(task.state)}>{task.state}</span>
      </div>
      <div role="cell" className="hidden lg:block">
        <ProviderChip harness={task.harness} />
      </div>
      <div role="cell" className="hidden lg:block">
        <ModelLabel model={task.model} className="text-muted" />
      </div>
      <div
        role="cell"
        className={`hidden md:block ${task.priority === 'high' ? 'font-semibold text-ink' : 'text-muted'}`}
      >
        {task.priority}
      </div>
      <div role="cell" className="hidden text-right tabular-nums text-muted md:block">
        <span className="sr-only">Cost: </span>
        {formatCost(task.cost) ?? '—'}
      </div>
      <div role="cell" className="hidden text-right tabular-nums text-muted lg:block">
        <span className="sr-only">Created: </span>
        {new Date(task.createdAt).toLocaleString()}
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
        <select
          aria-label="Filter by state"
          className={selectField}
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
          className={selectField}
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
          className={selectField}
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

      <div className={`${panel} relative overflow-x-auto`} aria-busy={loading} role="table" aria-label="Tasks">
        {loading && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-t-xl"
          >
            <div className="progress-indeterminate h-full w-1/3 bg-muted" />
          </div>
        )}

        <div role="rowgroup">
          <div role="row" className={`${GRID} ${tableHead} py-2.5`}>
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
          </div>
        </div>

        {bands.length === 0 ? (
          <div role="rowgroup" className="divide-y divide-hairline">
            {pageTasks.map((t) => renderRow(t))}
          </div>
        ) : (
          <div className="divide-y divide-hairline">
            {bands.map(({ epic, members }) => (
              <div key={`band-${epic.ref}`} role="rowgroup">
                <EpicBandHeader
                  epic={epic}
                  collapsed={collapsedBands.has(epic.ref)}
                  onToggle={() => toggleBand(epic.ref)}
                  onForceIntegrateEpic={onForceIntegrateEpic}
                />
                {!collapsedBands.has(epic.ref) && (
                  <div className="divide-y divide-hairline border-t border-hairline">
                    {members.map((t) => renderRow(t, true))}
                  </div>
                )}
              </div>
            ))}
            {ungrouped.length > 0 && (
              <div role="rowgroup">
                <div className={`${labelType} px-4 pb-1 pt-3 text-faint`}>Ungrouped</div>
                <div className="divide-y divide-hairline border-t border-hairline">
                  {ungrouped.map((t) => renderRow(t))}
                </div>
              </div>
            )}
          </div>
        )}

        {!loading && total === 0 && (
          <div className="px-4">
            {state || harness || priority || search ? (
              <EmptyState
                title="No matches"
                className="my-8"
                action={
                  <button
                    className={btnQuiet}
                    onClick={() =>
                      onFiltersChange({ ...filters, state: '', harness: '', priority: '', search: '' })
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
