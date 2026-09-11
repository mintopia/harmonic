import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { fieldLabel } from './SettingsSection';

const GRIP = (
  <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
    <g fill="currentColor">
      <circle cx="2.5" cy="3" r="1.3" />
      <circle cx="7.5" cy="3" r="1.3" />
      <circle cx="2.5" cy="8" r="1.3" />
      <circle cx="7.5" cy="8" r="1.3" />
      <circle cx="2.5" cy="13" r="1.3" />
      <circle cx="7.5" cy="13" r="1.3" />
    </g>
  </svg>
);

const CARET = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path
      d="M4 2l4 4-4 4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

type EntryListProps<T> = {
  items: T[];
  onChange: (items: T[]) => void;
  /** Section heading above the list ("Critics", "Commands"). */
  groupLabel: string;
  /** Add-button copy ("+ Add critic"). */
  addLabel: string;
  /** Shown in place of the list when it is empty. */
  emptyText: string;
  /** Seed a freshly added item; it opens for editing. */
  makeItem: () => T;
  /** The row's title (collapsed and open). */
  renderTitle: (item: T, index: number) => ReactNode;
  /** Optional right-aligned meta on the collapsed/open row (a run-target chip, a timeout). */
  renderMeta?: (item: T, index: number) => ReactNode;
  /** The editor revealed when the row is open. `set` replaces this item. */
  renderBody: (item: T, index: number, set: (item: T) => void) => ReactNode;
  /** Accessible verb for the reorder grip, e.g. "critic" → "Reorder critic 2". */
  itemNoun: string;
};

type HeaderProps = {
  index: number;
  open: boolean;
  title: ReactNode;
  meta?: ReactNode;
  itemNoun: string;
  onToggle: () => void;
  onRemove: () => void;
  gripRef?: (el: HTMLElement | null) => void;
  gripProps?: Record<string, unknown>;
  /** The floating drag preview: no toggle/remove, no interaction. */
  overlay?: boolean;
};

/** The collapsed row header — the drag handle, caret, title, meta and remove.
 * Shared by the live sortable row and the floating {@link DragOverlay} preview so
 * the thing under the cursor is pixel-identical to the row it left. */
function RowHeader({
  index,
  open,
  title,
  meta,
  itemNoun,
  onToggle,
  onRemove,
  gripRef,
  gripProps,
  overlay,
}: HeaderProps) {
  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-2.5 ${
        overlay ? 'cursor-grabbing' : 'cursor-pointer hover:bg-raised/40'
      } ${open && !overlay ? 'border-b border-hairline' : ''}`}
      onClick={
        overlay
          ? undefined
          : (e) => {
              if ((e.target as HTMLElement).closest('[data-noexpand]')) return;
              onToggle();
            }
      }
    >
      <button
        type="button"
        data-noexpand
        ref={gripRef}
        aria-label={`Reorder ${itemNoun} ${index + 1}`}
        className={`flex h-6 w-4 shrink-0 touch-none items-center justify-center text-faint hover:text-muted focus:text-accent focus:outline-none ${
          overlay ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        {...gripProps}
      >
        {GRIP}
      </button>
      <span
        className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
        aria-hidden="true"
      >
        {CARET}
      </span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {meta && <span className="flex shrink-0 items-center gap-2.5 text-small text-faint">{meta}</span>}
      {!overlay && (
        <button
          type="button"
          data-noexpand
          className="shrink-0 text-small text-faint hover:text-fail"
          onClick={onRemove}
        >
          Remove
        </button>
      )}
    </div>
  );
}

function SortableRow<T>({
  id,
  index,
  item,
  open,
  props,
  onToggle,
  onRemove,
  setItem,
}: {
  id: string;
  index: number;
  item: T;
  open: boolean;
  props: EntryListProps<T>;
  onToggle: () => void;
  onRemove: () => void;
  setItem: (item: T) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`overflow-hidden rounded-lg bg-surface shadow-card ${isDragging ? 'opacity-40' : ''}`}
    >
      <RowHeader
        index={index}
        open={open}
        title={props.renderTitle(item, index)}
        meta={props.renderMeta?.(item, index)}
        itemNoun={props.itemNoun}
        onToggle={onToggle}
        onRemove={onRemove}
        gripRef={setActivatorNodeRef}
        gripProps={{ ...attributes, ...listeners }}
      />
      {open && (
        <div className="flex flex-col gap-4 p-3.5">{props.renderBody(item, index, setItem)}</div>
      )}
    </div>
  );
}

/**
 * An ordered list of collapsible entries: click a row to edit it in place, drag
 * the grip (or focus it and use the keyboard) to reorder. Row order is the
 * item's run order. One row is open at a time (accordion); adding opens the new
 * row. Reordering is handled by @dnd-kit — the grip is the only drag handle, a
 * {@link DragOverlay} carries a copy of the row under the cursor, and the
 * keyboard sensor gives a full non-pointer path. Shared by the critic and
 * command editors so the two can't drift.
 */
export function EntryList<T>(props: EntryListProps<T>) {
  const { items, onChange, groupLabel, addLabel, emptyText, makeItem, itemNoun } = props;
  const [open, setOpen] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Stable per-row ids so @dnd-kit tracks an item across a reorder (positional
  // ids animate the drop to the wrong slot). Reorder/add/remove keep `ids` in
  // lockstep with `items`; an external length change (e.g. an inherit toggle
  // swapping the whole array) is reconciled by position.
  const seq = useRef(items.length);
  const [ids, setIds] = useState<string[]>(() => items.map((_, i) => `row-${i}`));
  useEffect(() => {
    setIds((prev) =>
      prev.length === items.length ? prev : items.map((_, i) => prev[i] ?? `row-${seq.current++}`),
    );
  }, [items]);
  const rowIds = items.map((_, i) => ids[i] ?? `pending-${i}`);
  const activeIndex = activeId === null ? -1 : rowIds.indexOf(activeId);
  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const from = rowIds.indexOf(String(e.active.id));
    const to = e.over ? rowIds.indexOf(String(e.over.id)) : from;
    if (from === -1 || to === -1 || from === to) return;
    onChange(arrayMove(items, from, to));
    setIds((prev) => arrayMove(prev, from, to));
    setOpen((o) =>
      o === null ? o : o === from ? to : o === to ? o + (from < to ? -1 : 1) : o,
    );
  };

  const setItem = (index: number, item: T) =>
    onChange(items.map((current, i) => (i === index ? item : current)));
  const remove = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
    setIds((prev) => prev.filter((_, i) => i !== index));
    setOpen((o) => (o === null ? o : o === index ? null : o > index ? o - 1 : o));
  };
  const add = () => {
    onChange([...items, makeItem()]);
    setIds((prev) => [...prev, `row-${seq.current++}`]);
    setOpen(items.length);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className={fieldLabel}>{groupLabel}</span>
        <button
          type="button"
          className="text-small font-semibold text-accent hover:text-accent-hot"
          onClick={add}
        >
          {addLabel}
        </button>
      </div>
      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-hairline bg-sunken px-3.5 py-3 text-small text-faint">
          {emptyText}
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <SortableContext items={rowIds} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1.5 rounded-xl border border-hairline bg-sunken p-1.5">
              {items.map((item, index) => {
                const id = rowIds[index] ?? `pending-${index}`;
                return (
                  <SortableRow
                    key={id}
                    id={id}
                    index={index}
                    item={item}
                    open={open === index}
                    props={props}
                    onToggle={() => setOpen(open === index ? null : index)}
                    onRemove={() => remove(index)}
                    setItem={(next) => setItem(index, next)}
                  />
                );
              })}
            </div>
          </SortableContext>
          <DragOverlay>
            {activeItem !== undefined && (
              <div className="overflow-hidden rounded-lg bg-surface shadow-float ring-1 ring-accent/40">
                <RowHeader
                  index={activeIndex}
                  open={false}
                  title={props.renderTitle(activeItem, activeIndex)}
                  meta={props.renderMeta?.(activeItem, activeIndex)}
                  itemNoun={itemNoun}
                  onToggle={() => {}}
                  onRemove={() => {}}
                  overlay
                />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
