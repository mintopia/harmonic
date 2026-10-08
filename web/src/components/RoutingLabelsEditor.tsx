import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { routingLabelIssues } from '../../../src/domain/setting-override.js';
import type { AppConfig } from '../types';
import { field } from '../ui';
import { DiscoveryModelPicker } from './DiscoveryModelPicker';
import { fieldLabel } from './SettingsSection';
import { firstIssueMessage, isIssueVisible, issuesByIndex, routingIssueMessage } from './routing-label-overlay-model';
import { providerLabel } from './TaskIdentity';

type RoutingLabel = AppConfig['routingLabels'][number];

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

const compactSelect =
  'hm-select min-h-9 w-full rounded-md border border-edge bg-field px-2.5 py-1 text-ink focus:border-accent focus:outline-none';
const compactField = `${field} min-h-9 py-1 font-data text-data`;

export function firstRoutingLabelError(labels: readonly RoutingLabel[]): string | null {
  return firstIssueMessage(routingLabelIssues(labels), (index) => labels[index]?.label ?? '');
}

const cellsGrid =
  'grid grid-cols-[16px_24px_minmax(120px,1.1fr)_20px_minmax(110px,0.8fr)_minmax(170px,1.3fr)_auto] items-center gap-2.5 px-3 py-2.5';

/** One sortable Routing Label row: grip, priority, then the caller's cells and an optional inline error. */
export function RoutingRowShell({
  id,
  index,
  locked,
  error,
  children,
}: {
  id: string;
  index: number;
  locked?: boolean;
  error?: ReactNode;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  const n = index + 1;
  return (
    <div
      ref={setNodeRef}
      data-routing-row={index}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative rounded-lg bg-surface ${isDragging ? 'z-10 shadow-float ring-1 ring-accent/40' : 'shadow-card'} ${locked ? 'opacity-85' : ''}`}
    >
      <div className={cellsGrid}>
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Reorder Routing Label ${n}`}
          className="flex h-6 w-4 shrink-0 cursor-grab touch-none items-center justify-center text-faint hover:text-muted focus:text-accent focus:outline-none"
          {...attributes}
          {...listeners}
        >
          {GRIP}
        </button>
        <span className="text-center text-label font-bold text-faint" aria-hidden="true">
          {n}
        </span>
        {children}
      </div>
      {error && (
        <div className="pb-2.5 pl-[62px] pr-3">
          <p role="alert" className="text-label normal-case tracking-normal text-fail">
            {error}
          </p>
        </div>
      )}
    </div>
  );
}

export const arrowCell = (
  <span className="text-center text-faint" aria-hidden="true">
    →
  </span>
);

/** The editable label, Harness and Model cells of a row. */
export function RouteCells({
  id,
  index,
  item,
  config,
  invalid,
  onChange,
  onTouched,
}: {
  id: string;
  index: number;
  item: RoutingLabel;
  config: AppConfig;
  invalid: boolean;
  onChange: (item: RoutingLabel) => void;
  onTouched: () => void;
}) {
  const n = index + 1;
  const harnesses = Object.keys(config.harnesses);
  return (
    <>
      <input
        aria-label={`Routing Label ${n}`}
        aria-invalid={invalid}
        className={`${compactField} ${invalid ? 'border-fail focus:border-fail' : ''}`}
        value={item.label}
        onChange={(e) => onChange({ ...item, label: e.target.value })}
        onBlur={onTouched}
      />
      {arrowCell}
      <select
        aria-label={`Harness for Routing Label ${n}`}
        className={compactSelect}
        value={item.harness}
        onChange={(e) => {
          const harness = e.target.value;
          onChange({ ...item, harness, model: config.harnesses[harness]?.defaultModel ?? '' });
        }}
      >
        {harnesses.map((h) => (
          <option key={h} value={h}>
            {providerLabel(h)}
          </option>
        ))}
        {!config.harnesses[item.harness] && <option value={item.harness}>{item.harness} (not configured)</option>}
      </select>
      <div className="min-w-0">
        <DiscoveryModelPicker
          id={`routing-model-${id}`}
          ariaLabel={`Model for Routing Label ${n}`}
          compact
          harness={item.harness}
          value={item.model}
          options={(config.harnesses[item.harness]?.models ?? []).map((m) => m.id)}
          onChange={(model) => onChange({ ...item, model })}
        />
      </div>
    </>
  );
}

export function RemoveButton({ index, onRemove }: { index: number; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove Routing Label ${index + 1}`}
      className="shrink-0 text-small text-faint hover:text-fail"
      onClick={onRemove}
    >
      Remove
    </button>
  );
}

export function Precedence() {
  const step = 'font-semibold text-ink';
  const arrow = (
    <span className="text-faint" aria-hidden="true">
      →
    </span>
  );
  return (
    <div className="mb-3.5 flex flex-wrap items-center gap-1.5 rounded-sm border border-hairline bg-sunken px-3 py-2 text-small text-muted">
      <span className="mr-1 text-label font-semibold uppercase text-faint">Precedence</span>
      <b className={step}>Operator setting on the Ticket</b>
      {arrow}
      <b className="font-semibold text-accent">Routing Label</b>
      {arrow}
      <b className={step}>Workspace default</b>
      {arrow}
      <b className={step}>Global default</b>
    </div>
  );
}

/** Sortable tray with an add link: owns stable row ids and the touched set; callers own the data. */
export function RoutingListFrame({
  count,
  onMove,
  onAdd,
  onRemove,
  renderRow,
  emptyText,
}: {
  count: number;
  onMove: (from: number, to: number) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  renderRow: (row: { id: string; index: number; touched: boolean; touch: () => void; remove: () => void }) => ReactNode;
  emptyText: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Stable per-row ids so @dnd-kit tracks a row across a reorder; kept in lockstep with the data.
  const seq = useRef(count);
  const [ids, setIds] = useState<string[]>(() => Array.from({ length: count }, (_, i) => `route-${i}`));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  useEffect(() => {
    setIds((prev) => (prev.length === count ? prev : Array.from({ length: count }, (_, i) => prev[i] ?? `route-${seq.current++}`)));
  }, [count]);
  const rowIds = Array.from({ length: count }, (_, i) => ids[i] ?? `pending-${i}`);

  const onDragEnd = (e: DragEndEvent) => {
    const from = rowIds.indexOf(String(e.active.id));
    const to = e.over ? rowIds.indexOf(String(e.over.id)) : from;
    if (from === -1 || to === -1 || from === to) return;
    onMove(from, to);
    setIds((prev) => arrayMove(prev, from, to));
  };
  const add = () => {
    setIds((prev) => [...prev, `route-${seq.current++}`]);
    onAdd();
  };
  const remove = (index: number) => {
    onRemove(index);
    setIds((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <>
      <div className="mb-1.5 flex items-center justify-between">
        <span className={fieldLabel}>Routing Labels</span>
        <button type="button" className="text-small font-semibold text-accent hover:text-accent-hot" onClick={add}>
          + Add Routing Label
        </button>
      </div>
      {count === 0 ? (
        <p className="rounded-md border border-dashed border-hairline bg-sunken px-3.5 py-3 text-small text-faint">{emptyText}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={rowIds} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1.5 rounded-xl border border-hairline bg-sunken p-1.5">
              {rowIds.map((id, index) => (
                <Fragment key={id}>
                  {renderRow({
                    id,
                    index,
                    touched: touched.has(id),
                    touch: () => setTouched((prev) => new Set(prev).add(id)),
                    remove: () => remove(index),
                  })}
                </Fragment>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </>
  );
}

export function defaultRoute(config: AppConfig): RoutingLabel {
  const harness = config.defaults.harness in config.harnesses ? config.defaults.harness : (Object.keys(config.harnesses)[0] ?? '');
  return { label: '', harness, model: config.harnesses[harness]?.defaultModel ?? '' };
}

/** Ordered tracker-label → Harness/Model rows; first match wins, so order is priority. */
export function RoutingLabelsEditor({
  items,
  config,
  onChange,
}: {
  items: AppConfig['routingLabels'];
  config: AppConfig;
  onChange: (items: AppConfig['routingLabels']) => void;
}) {
  const issues = issuesByIndex(routingLabelIssues(items));
  return (
    <div>
      <Precedence />
      <RoutingListFrame
        count={items.length}
        onMove={(from, to) => onChange(arrayMove(items, from, to))}
        onAdd={() => onChange([...items, defaultRoute(config)])}
        onRemove={(index) => onChange(items.filter((_, i) => i !== index))}
        emptyText="No Routing Labels. Issues use the Workspace or Global default Harness and Model."
        renderRow={({ id, index, touched, touch, remove }) => {
          const item = items[index];
          if (!item) return null;
          const issue = issues.get(index);
          const visibleIssue = isIssueVisible(issue, touched) ? issue : null;
          return (
            <RoutingRowShell id={id} index={index} error={visibleIssue && routingIssueMessage(visibleIssue, item.label)}>
              <RouteCells
                id={id}
                index={index}
                item={item}
                config={config}
                invalid={visibleIssue !== null}
                onChange={(next) => onChange(items.map((current, i) => (i === index ? next : current)))}
                onTouched={touch}
              />
              <RemoveButton index={index} onRemove={remove} />
            </RoutingRowShell>
          );
        }}
      />
      <RoutingNote />
    </div>
  );
}

export function RoutingNote() {
  return (
    <p className="mt-2 text-small text-faint">
      The Model picker is the same combobox as the Task form: type to filter that Harness&apos;s catalog, or enter a custom id. Changing the Harness resets the Model to that Harness&apos;s default. Labels are free text and matched case-insensitively.
    </p>
  );
}
