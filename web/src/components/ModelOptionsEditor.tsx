import { useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import type { AppConfig, ModelOption, ModelOptionOverlayEntry } from '../types';
import { btnPrimary, btnQuiet, chip, field } from '../ui';
import { DiscoveryModelPicker } from './DiscoveryModelPicker';
import { Precedence, RemoveButton, RoutingListFrame, RoutingRowShell } from './RoutingLabelsEditor';
import { FieldError, fieldLabel } from './SettingsSection';
import { Switch } from './Switch';
import { formatModelLabel, providerLabel } from './TaskIdentity';
import {
  DESCRIPTION_LIMIT,
  blankModelOption,
  firstServerMessage,
  serverRowErrors,
  validateModelOption,
  modelOptionRows,
  rowsToOverlay,
  type ModelOptionErrors,
  type ModelOptionRow,
} from './model-option-model';

const NOUN = 'Model Option';
const globalChip = `${chip} bg-raised text-muted`;
const workspaceChip = `${chip} bg-accent-tint text-accent`;
const selectClass =
  'hm-select min-h-11 w-full rounded-md border border-edge bg-field px-2.5 py-1.5 text-ink focus:border-accent focus:outline-none';
const errorField = 'border-fail focus:border-fail';
const editButton = 'rounded-md px-1 text-small font-semibold text-accent hover:text-accent-hot';

function ModelOptionForm({
  initial,
  taken,
  config,
  serverErrors,
  onSave,
  onCancel,
}: {
  initial: ModelOption;
  taken: readonly string[];
  config: AppConfig;
  serverErrors?: ModelOptionErrors;
  onSave: (option: ModelOption) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [resetFrom, setResetFrom] = useState<string | null>(null);
  const [errors, setErrors] = useState<ModelOptionErrors>({});
  const shown = { ...serverErrors, ...errors };
  const harnesses = Object.keys(config.harnesses);

  const changeHarness = (harness: string) => {
    setResetFrom(draft.harness);
    setDraft({ ...draft, harness, model: config.harnesses[harness]?.defaultModel ?? '' });
  };
  const save = () => {
    const next = { ...draft, id: draft.id.trim(), model: draft.model.trim(), description: draft.description.trim() };
    const found = validateModelOption(next, taken, config);
    setErrors(found);
    if (Object.keys(found).length === 0) onSave(next);
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-surface p-4 shadow-card">
      <div>
        <label className={fieldLabel} htmlFor="model-option-code">Code</label>
        <input
          id="model-option-code"
          aria-invalid={shown.id !== undefined}
          className={`${field} min-h-11 font-data text-data ${shown.id ? errorField : ''}`}
          value={draft.id}
          onChange={(e) => setDraft({ ...draft, id: e.target.value })}
        />
        <FieldError message={shown.id} />
        <p className="mt-1 text-small text-faint">
          Lowercase letters, digits and hyphens, starting with a letter or digit (<code>opus-deep</code>, <code>codex-bulk</code>). Task Execution Workflow YAML refers to this Model Option by code, so changing it breaks those references.
        </p>
      </div>
      <div>
        <label className={fieldLabel} htmlFor="model-option-harness">Harness</label>
        <select id="model-option-harness" className={selectClass} value={draft.harness} onChange={(e) => changeHarness(e.target.value)}>
          {harnesses.map((h) => (
            <option key={h} value={h}>{providerLabel(h)}</option>
          ))}
          {!config.harnesses[draft.harness] && <option value={draft.harness}>{providerLabel(draft.harness)} (not configured)</option>}
        </select>
        {resetFrom !== null && (
          <span className="mt-1 inline-block rounded-sm bg-raised px-1.5 py-0.5 text-label text-muted">
            Harness changed from {providerLabel(resetFrom)}: Model reset to {providerLabel(draft.harness)} default {config.harnesses[draft.harness]?.defaultModel ?? 'none'}
          </span>
        )}
        <FieldError message={shown.harness} />
      </div>
      <div>
        <span className={fieldLabel}>Model</span>
        <DiscoveryModelPicker
          id="model-option-model"
          ariaLabel="Model"
          harness={draft.harness}
          value={draft.model}
          options={(config.harnesses[draft.harness]?.models ?? []).map((m) => m.id)}
          onChange={(model) => setDraft({ ...draft, model })}
        />
        <FieldError message={shown.model} />
      </div>
      <div>
        <label className={fieldLabel} htmlFor="model-option-description">Description: when it fits</label>
        <textarea
          id="model-option-description"
          aria-invalid={shown.description !== undefined}
          rows={3}
          maxLength={DESCRIPTION_LIMIT}
          className={`${field} ${shown.description ? errorField : ''}`}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <span className="text-label text-faint">{draft.description.length} / {DESCRIPTION_LIMIT}</span>
        <FieldError message={shown.description} />
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className={btnPrimary} onClick={save}>Save Model Option</button>
        <button type="button" className={btnQuiet} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const box = 'inline-flex min-h-9 items-center rounded-md border border-edge bg-field px-2.5 py-1 text-ink';

function LocalSummary({ option }: { option: ModelOption }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <code className={`${box} w-[180px] font-data text-data`}>{option.id}</code>
        <span className={`${box} w-[150px]`}>{providerLabel(option.harness)}</span>
        <span className={`${box} w-[190px] font-data text-data`} title={option.model}>{formatModelLabel(option.model)}</span>
      </div>
      <p className={`${box} mt-1.5 w-full text-small`}>{option.description}</p>
    </div>
  );
}

function GlobalSummary({ option, enabled }: { option: ModelOption; enabled: boolean }) {
  const off = enabled ? '' : 'opacity-55 line-through';
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5">
        <code className={`min-w-[140px] font-data text-data text-ink ${off}`}>{option.id}</code>
        <span className={`text-ink ${off}`}>{providerLabel(option.harness)}</span>
        <span className={`font-data text-data text-ink ${off}`} title={option.model}>{formatModelLabel(option.model)}</span>
      </div>
      <p className="text-small text-muted">{option.description}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center">
      <div className="font-semibold text-ink">No Model Options yet</div>
      <div className="text-small text-muted">Without Model Options the Route Classifier abstains on every Ticket and the Workspace default applies.</div>
    </div>
  );
}

type Editing = { index: number; isNew: boolean } | null;

/** The closed list the Route Classifier picks from. Given `overlay` (Workspace surface), Global rows can be reordered and turned off, and local rows edited. */
export function ModelOptionsEditor(
  props: { config: AppConfig; errors: Record<string, string> } & (
    | { workspace?: false; items: readonly ModelOption[]; onChange: (items: ModelOption[]) => void }
    | { workspace: true; overlay: ModelOptionOverlayEntry[] | null; onChange: (overlay: ModelOptionOverlayEntry[]) => void }
  ),
) {
  const { config, errors } = props;
  const [editing, setEditing] = useState<Editing>(null);
  const workspace = props.workspace === true;
  const rows: ModelOptionRow[] = props.workspace
    ? modelOptionRows(props.overlay, config.modelOptions)
    : props.items.map((option) => ({ kind: 'local', enabled: true, option }));
  const rowErrors = serverRowErrors(errors);
  const takenFor = (skip: number) => rows.filter((_, i) => i !== skip).map((r) => r.option.id);
  const commit = (next: ModelOptionRow[]) => {
    if (props.workspace) props.onChange(rowsToOverlay(next));
    else props.onChange(next.map((r) => r.option));
  };
  const close = () => setEditing(null);
  const replace = (index: number, next: ModelOptionRow) => {
    commit(index >= rows.length ? [...rows, next] : rows.map((r, i) => (i === index ? next : r)));
    close();
  };

  return (
    <div>
      <Precedence highlight="route-classifier" />
      <RoutingListFrame
        heading="Model Options"
        addLabel="+ Add Model Option"
        count={rows.length}
        onMove={(from, to) => {
          commit(arrayMove([...rows], from, to));
          close();
        }}
        onAdd={() => setEditing({ index: rows.length, isNew: true })}
        onRemove={(index) => {
          commit(rows.filter((_, i) => i !== index));
          close();
        }}
        emptyText={<EmptyState />}
        renderRow={({ id, index, remove }) => {
          const row = rows[index];
          if (!row) return null;
          const n = index + 1;
          if (row.kind === 'global') {
            return (
              <RoutingRowShell id={id} index={index} noun={NOUN} stacked locked>
                <GlobalSummary option={row.option} enabled={row.enabled} />
                <span className="flex items-center gap-3 self-center">
                  <span className={globalChip}>Global</span>
                  <Switch checked={row.enabled} label={`Toggle ${NOUN} ${n}`} onChange={(enabled) => replace(index, { ...row, enabled })} />
                </span>
              </RoutingRowShell>
            );
          }
          if (editing && !editing.isNew && editing.index === index) {
            return (
              <ModelOptionForm
                initial={row.option}
                taken={takenFor(index)}
                config={config}
                serverErrors={rowErrors.get(index)}
                onSave={(option) => replace(index, { ...row, option })}
                onCancel={close}
              />
            );
          }
          return (
            <RoutingRowShell id={id} index={index} noun={NOUN} stacked accent={workspace} error={firstServerMessage(rowErrors.get(index))}>
              <LocalSummary option={row.option} />
              <span className="flex items-center gap-3 self-center">
                {workspace && <span className={workspaceChip}>Workspace</span>}
                <button type="button" aria-label={`Edit ${NOUN} ${n}`} className={editButton} onClick={() => setEditing({ index, isNew: false })}>
                  Edit
                </button>
                <RemoveButton index={index} noun={NOUN} inline onRemove={remove} />
              </span>
            </RoutingRowShell>
          );
        }}
      />
      {editing?.isNew && (
        <div className="mt-2">
          <ModelOptionForm
            initial={blankModelOption(config)}
            taken={takenFor(-1)}
            config={config}
            serverErrors={rowErrors.get(editing.index)}
            onSave={(option) => replace(editing.index, { kind: 'local', enabled: true, option })}
            onCancel={close}
          />
        </div>
      )}
      <p className="mt-2 text-small text-faint">
        Epics are not classified, and Critics are never classified. The Route Classifier runs at the start of every Attempt on a Native Task; an Attempt already in flight is never re-routed.
      </p>
    </div>
  );
}
