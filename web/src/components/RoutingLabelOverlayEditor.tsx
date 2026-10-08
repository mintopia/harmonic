import { arrayMove } from '@dnd-kit/sortable';
import { describeRoutingLabelIssue, routingLabelOverlayIssues, routingLabelRef, type RoutingLabelIssue } from '../../../src/domain/setting-override.js';
import type { AppConfig, RoutingLabelOverlayEntry } from '../types';
import { chip, codeChip } from '../ui';
import {
  Precedence,
  RemoveButton,
  RouteCells,
  RoutingListFrame,
  RoutingEditorHelp,
  RoutingRowShell,
  arrowCell,
  defaultRoute,
  stackedCell,
  trailingCell,
} from './RoutingLabelsEditor';
import { isIssueVisible, issuesByIndex, newLocalEntry, overlayRows } from './routing-label-overlay-model';
import { Switch } from './Switch';
import { formatModelLabel, providerLabel } from './TaskIdentity';

const globalChip = `${chip} bg-raised text-muted`;

function ErrorText({ issue, label }: { issue: RoutingLabelIssue; label: string }) {
  const { before, globalRef, after } = describeRoutingLabelIssue(issue, label);
  return (
    <>
      {before}
      {globalRef !== undefined && <code className={codeChip}>{globalRef}</code>}
      {after}
    </>
  );
}

/** Workspace Routing Label overlay editor (ADR-0049). */
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
  const globalByRef = new Map(globals.map((g) => [routingLabelRef(g), g]));
  const rows = overlayRows(overlay, globals);
  const issues = issuesByIndex(routingLabelOverlayIssues(rows, globals));
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
          const entry = rows[index];
          if (!entry) return null;
          const n = index + 1;
          if (entry.kind === 'local') {
            const issue = issues.get(index);
            const visible = isIssueVisible(issue, touched) ? issue : null;
            return (
              <RoutingRowShell
                id={id}
                index={index}
                error={visible && <ErrorText issue={visible} label={entry.routingLabel.label} />}
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
              <span title={global?.label} className={`min-w-0 truncate font-data text-data ${global ? 'text-ink' : 'italic text-faint line-through'} ${dim}`}>
                {global ? global.label : entry.ref}
              </span>
              {arrowCell}
              {global ? (
                <>
                  <span className={`${stackedCell} text-ink ${dim}`}>{providerLabel(global.harness)}</span>
                  <span className={`${stackedCell} min-w-0 truncate font-data text-data text-ink ${dim}`} title={global.model}>
                    {formatModelLabel(global.model)}
                  </span>
                </>
              ) : (
                <span className="col-span-2 col-start-3 text-small italic text-faint @[44rem]:col-start-auto">Removed: this global label no longer exists.</span>
              )}
              <span className={`flex items-center justify-end gap-2 ${trailingCell}`}>
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
      <RoutingEditorHelp />
    </div>
  );
}
