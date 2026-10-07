import { arrayMove } from '@dnd-kit/sortable';
import type { AppConfig, RoutingLabelOverlayEntry } from '../types';
import { chip } from '../ui';
import {
  Precedence,
  RemoveButton,
  RouteCells,
  RoutingListFrame,
  RoutingNote,
  RoutingRowShell,
  arrowCell,
  defaultRoute,
} from './RoutingLabelsEditor';
import { newLocalEntry, type RoutingOverlayError, overlayRows, routingLabelKey, routingOverlayErrors } from './routing-label-overlay-model';
import { Switch } from './Switch';
import { providerLabel } from './TaskIdentity';

const globalChip = `${chip} bg-raised text-muted`;

function ErrorText({ error }: { error: RoutingOverlayError }) {
  const [before, ref, after] = error.message.split('`');
  if (error.globalRef === undefined || ref === undefined) return <>{error.message}</>;
  return (
    <>
      {before}
      <code className="font-data">{ref}</code>
      {after}
    </>
  );
}

/**
 * The Workspace-scope, additive Routing Label editor (ADR-0049): the global
 * labels render locked, reorderable and switchable, interleaved with the
 * Workspace's own editable labels in overlay order. A `ref` whose global no
 * longer exists renders as a muted, droppable "Removed" row.
 */
export function RoutingLabelOverlayEditor({
  overlay,
  config,
  onChange,
}: {
  overlay: RoutingLabelOverlayEntry[] | null;
  config: AppConfig;
  onChange: (overlay: RoutingLabelOverlayEntry[]) => void;
}) {
  const globals = config.routingLabels;
  const globalByRef = new Map(globals.map((g) => [routingLabelKey(g.label), g]));
  const rows = overlayRows(overlay, globals);
  const errors = routingOverlayErrors(rows, globals);
  const set = (index: number, next: RoutingLabelOverlayEntry) => onChange(rows.map((row, i) => (i === index ? next : row)));

  return (
    <div>
      <Precedence />
      <RoutingListFrame
        count={rows.length}
        onMove={(from, to) => onChange(arrayMove(rows, from, to))}
        onAdd={() => {
          const { harness, model } = defaultRoute(config);
          onChange([...rows, newLocalEntry(harness, model)]);
        }}
        onRemove={(index) => onChange(rows.filter((_, i) => i !== index))}
        emptyText="No Routing Labels. Issues use the Workspace or Global default Harness and Model."
        renderRow={({ id, index, touched, touch, remove }) => {
          const entry = rows[index]!;
          const n = index + 1;
          if (entry.kind === 'local') {
            const error = errors[index];
            const visible = error && (error.message !== 'Enter a label.' || touched) ? error : null;
            return (
              <RoutingRowShell
                id={id}
                index={index}
                error={visible && <ErrorText error={visible} />}
              >
                <RouteCells
                  id={id}
                  index={index}
                  item={entry.routingLabel}
                  config={config}
                  invalid={visible !== null}
                  onChange={(routingLabel) => set(index, { ...entry, routingLabel })}
                  onTouched={touch}
                />
                <RemoveButton index={index} onRemove={remove} />
              </RoutingRowShell>
            );
          }
          const global = globalByRef.get(entry.ref);
          const dim = entry.enabled ? '' : 'opacity-55 line-through';
          return (
            <RoutingRowShell id={id} index={index} locked>
              <span className={`min-w-0 truncate font-data text-data ${global ? 'text-ink' : 'italic text-faint line-through'} ${dim}`}>
                {global ? global.label : entry.ref}
              </span>
              {arrowCell}
              {global ? (
                <>
                  <span className={`text-ink ${dim}`}>{providerLabel(global.harness)}</span>
                  <span className={`min-w-0 truncate font-data text-data text-ink ${dim}`}>{global.model}</span>
                </>
              ) : (
                <span className="col-span-2 text-small italic text-faint">Removed: this global label no longer exists.</span>
              )}
              <span className="flex items-center justify-end gap-2">
                {global ? (
                  <>
                    <span className={globalChip}>Global</span>
                    <Switch
                      checked={entry.enabled}
                      onChange={(enabled) => set(index, { ...entry, enabled })}
                      label={entry.enabled ? `Disable routing label ${n}` : `Enable routing label ${n}`}
                    />
                  </>
                ) : (
                  <RemoveButton index={index} onRemove={remove} />
                )}
              </span>
            </RoutingRowShell>
          );
        }}
      />
      <RoutingNote />
    </div>
  );
}
