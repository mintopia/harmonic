import { useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import type { AppConfig, ModelOption } from '../types';
import { btnPrimary, btnQuiet, chip, field } from '../ui';
import { DiscoveryModelPicker } from './DiscoveryModelPicker';
import { Precedence, RemoveButton, RoutingListFrame, RoutingRowShell } from './RoutingLabelsEditor';
import { FieldError, fieldLabel } from './SettingsSection';
import { formatModelLabel, providerLabel } from './TaskIdentity';
import {
  DESCRIPTION_LIMIT,
  blankModelOption,
  firstServerMessage,
  serverRowErrors,
  validateModelOption,
  type ModelOptionErrors,
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
          Lowercase letters, digits and hyphens, starting with a letter or digit (<code>^[a-z0-9][a-z0-9-]*$</code>). Task Execution Workflow YAML refers to this Model Option by code, so changing it breaks those references.
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

function ModelOptionSummary({ option }: { option: ModelOption }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <code className="font-data text-data text-ink">{option.id}</code>
        <span className="text-ink">{providerLabel(option.harness)}</span>
        <span className="font-data text-data text-ink" title={option.model}>{formatModelLabel(option.model)}</span>
      </div>
      <p className="mt-0.5 text-small text-muted">{option.description}</p>
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

/** The closed list the Route Classifier picks from. Given `globals` (Workspace surface), those render first and locked; `items` are the editable rows behind them. */
export function ModelOptionsEditor({
  items,
  globals = [],
  workspace = false,
  config,
  errors,
  onChange,
}: {
  items: readonly ModelOption[];
  globals?: readonly ModelOption[];
  workspace?: boolean;
  config: AppConfig;
  errors: Record<string, string>;
  onChange: (items: ModelOption[]) => void;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const offset = globals.length;
  const rowErrors = serverRowErrors(errors);
  const takenFor = (skip: number) => [...globals.map((g) => g.id), ...items.filter((_, i) => i !== skip).map((o) => o.id)];
  const close = () => setEditing(null);
  const commit = (index: number, option: ModelOption) => {
    onChange(index >= items.length ? [...items, option] : items.map((o, i) => (i === index ? option : o)));
    close();
  };

  return (
    <div>
      <Precedence highlight="route-classifier" />
      <RoutingListFrame
        heading="Model Options"
        addLabel="+ Add Model Option"
        count={offset + items.length}
        onMove={(from, to) => {
          if (from < offset || to < offset) return;
          onChange(arrayMove([...items], from - offset, to - offset));
          close();
        }}
        onAdd={() => setEditing({ index: items.length, isNew: true })}
        onRemove={(index) => {
          onChange(items.filter((_, i) => i !== index - offset));
          close();
        }}
        emptyText={<EmptyState />}
        renderRow={({ id, index, remove }) => {
          const global = globals[index];
          if (global) {
            return (
              <RoutingRowShell id={id} index={index} noun={NOUN} stacked locked pinned>
                <ModelOptionSummary option={global} />
                <span className={globalChip}>Global</span>
              </RoutingRowShell>
            );
          }
          const local = index - offset;
          const option = items[local];
          if (!option) return null;
          if (editing && !editing.isNew && editing.index === local) {
            return (
              <ModelOptionForm
                initial={option}
                taken={takenFor(local)}
                config={config}
                serverErrors={rowErrors.get(local)}
                onSave={(next) => commit(local, next)}
                onCancel={close}
              />
            );
          }
          return (
            <RoutingRowShell id={id} index={index} noun={NOUN} stacked accent={workspace} error={firstServerMessage(rowErrors.get(local))}>
              <ModelOptionSummary option={option} />
              <span className="flex items-center gap-3">
                {workspace && <span className={workspaceChip}>Workspace</span>}
                <button type="button" aria-label={`Edit ${NOUN} ${index + 1}`} className={editButton} onClick={() => setEditing({ index: local, isNew: false })}>
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
            onSave={(next) => commit(editing.index, next)}
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
