import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatCost } from '../cost';
import type { Task } from '../types';
import { TASK_STATES } from '../types';
import type { Epic, EpicLandOutcome } from '../epic-model';
import { FORCE_LAND_CONSEQUENCE, epicByTaskId } from '../epic-model';
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
import { toastError, toastLandOutcome } from '../toast';
import { fetchTasks, filterBySearch, paginate, TABLE_PAGE_SIZE } from '../table-model';
import { taskKey } from '../id-format.js';
import { EmptyState } from './EmptyState';
import { ArmedButton } from './ArmedButton';
import { Icon } from './Icon';

/** The Deck-language column grid (DESIGN.md § 6): the header and every row —
 * flat, banded or ungrouped — share one template so they line up. It sheds
 * low-priority columns below the tablet tier instead of horizontal-scrolling
 * like a phone (issue #226): base keeps #/Prompt/State, `md:` (≥768px) adds
 * Priority/Cost/Created, `lg:` (≥1024px) restores the full 8 with Harness/Model.
 * The dropped header + row cells hide together (`hidden md:*`/`hidden lg:*`) so
 * the DOM cell count always matches the active track count and the ARIA grid
 * stays valid at every width. Created (a wide timestamp) rides the `lg:` tier
 * with Harness/Model so the Prompt column keeps real width at tablet. */
const GRID =
  'grid grid-cols-[3rem_minmax(0,1fr)_8rem] md:grid-cols-[3rem_minmax(0,1fr)_8rem_5rem_5.5rem] lg:grid-cols-[3rem_minmax(0,1fr)_8rem_6rem_9rem_5rem_5.5rem_12rem] items-center gap-x-3 px-4';

/** One band header + its member rows (issue #167, ADR-0026): title, #ref,
 * fold progress, an armed force-land control, and an expand/collapse
 * disclosure — collapse state is local, not persisted (a glance affordance,
 * not routed state like the Board's peeked terminal columns). Styled as the
 * quiet ActivityView-style strip (`bg-raised/40`), not a full-bleed band. */
function EpicBandHeader({
  epic,
  collapsed,
  onToggle,
  onForceLandEpic,
}: {
  epic: Epic;
  collapsed: boolean;
  onToggle: () => void;
  onForceLandEpic?: (epicRef: number) => Promise<EpicLandOutcome>;
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
        {epic.foldedCount}/{epic.memberCount} folded
      </span>
      <div className="flex-1" />
      {onForceLandEpic && (
        <div className="flex shrink-0 flex-col items-end gap-1">
          <ArmedButton
            label="Force-land"
            armedLabel="Confirm force-land"
            ariaLabel={`Force-land Epic #${epic.ref}`}
            className={btnQuietDestructive}
            onConfirm={() => {
              onForceLandEpic(epic.ref).then(toastLandOutcome, toastError);
            }}
          />
          <p className="max-w-[220px] text-right text-label text-faint">{FORCE_LAND_CONSEQUENCE}.</p>
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
  onForceLandEpic,
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
  onForceLandEpic?: (epicRef: number) => Promise<EpicLandOutcome>;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [collapsedBands, setCollapsedBands] = useState<ReadonlySet<number>>(new Set());
  const { state, harness, priority, search, sortBy, order } = filters;

  useEffect(() => {
    if (workspaceId === null) return;
    setLoading(true);
    fetchTasks({ workspaceId, state, harness, priority, sortBy, order })
      .then(setTasks)
      .catch(toastError)
      .finally(() => setLoading(false));
    // Refetch when the filter/sort selection changes. The destructured filter
    // fields (from route.table, issue #103) are stable primitives, so this
    // fires only on a real filter change — not on every re-render. `search`
    // is deliberately excluded (issue #104): it filters the already-fetched
    // list client-side, so typing in the box never triggers a refetch.
  }, [workspaceId, state, harness, priority, sortBy, order]);

  const filtered = filterBySearch(tasks, search);
  const { items: pageTasks, page: currentPage, pageCount, total } = paginate(filtered, page);

  // Reset to page 1 whenever the result set's inputs change, so narrowing the
  // list never leaves the operator staring at a now-out-of-range page. The
  // paginate() clamp is the safety net; this is the intent.
  useEffect(() => {
    setPage(1);
  }, [workspaceId, state, harness, priority, sortBy, order, search]);

  // The badge links to the original, which the current filter may hide, so
  // fall back to fetching it by id.
  const openOriginal = (id: number) => {
    const found = tasks.find((t) => t.id === id);
    if (found) return onOpen(found);
    api.task(id).then(onOpen, toastError);
  };

  // Group-by-Epic bands (issue #167, ADR-0026): one band per Epic that has at
  // least one member on the current page, in `epics`' own order; the rest of
  // the page's rows fall to a flat "Ungrouped" tail — a Task page can straddle
  // an Epic's full membership, so a band only ever reflects what's visible now.
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

  // Sortable headers hide below their column's tier in lockstep with the row
  // cells (see GRID): Priority/Cost appear at `md:`, Created only at `lg:`.
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

  // The existing flat row, reused for both an Epic band's members and the
  // ungrouped tail — group-by-Epic (issue #167) changes only what wraps the
  // rows, never the row itself. `indent` pushes an Epic member's row in from
  // the band header (DESIGN.md § 6 — the same pl-7 the Deck's own bands use).
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
        {task.reattemptOf !== null && (
          <button
            type="button"
            title={`Open the original, task ${task.reattemptOf}`}
            className="mb-1 inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-label font-semibold uppercase text-muted transition-colors duration-150 hover:text-ink"
            onClick={(e) => {
              e.stopPropagation();
              openOriginal(task.reattemptOf!);
            }}
          >
            {/* Secondary affordance: it stacks above the Prompt link inside a
                dense two-line cell, so a 44px hit box can't fit without stealing
                the neighbour's clicks — the row itself (min-h-11) carries the
                floor for the primary open action (issue #226). */}
            ↻ re-attempt of <span className="tabular-nums normal-case">{taskKey(task.reattemptOf)}</span>
          </button>
        )}
        <button
          type="button"
          title={task.prompt}
          className="block w-full cursor-pointer truncate text-left text-ink"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(task);
          }}
        >
          {task.prompt}
        </button>
      </div>
      <div role="cell">
        <span className={stateChip(task.state)}>{task.state}</span>
      </div>
      <div role="cell" className="hidden text-muted lg:block">
        {task.harness}
      </div>
      <div role="cell" className="hidden text-muted lg:block">
        {task.model}
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
        {/* The view's anchor figure: how many tasks the filters (including
            search, issue #104) select. */}
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

        {/* Stale rows stay visible and fully legible while a refetch is in
            flight — the top-edge progress bar and aria-busy carry the loading
            signal instead of dimming the whole table below AA. Sparse hairline
            dividers (`divide-y divide-hairline`) separate rows, never a ruled
            wall of per-row borders. */}
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
                  onForceLandEpic={onForceLandEpic}
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

        {!loading && filtered.length === 0 && (
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

      {/* Pagination (issue #104): only shown once there's more than a page to
          page through, so the single-page (common) case stays uncluttered. */}
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
