import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useAsyncResource } from '../../useAsyncResource';
import type { AppConfig, ModelOption, Task, Workspace } from '../../types';
import { btnGhost, btnPrimary, codeChip, labelType } from '../../ui';
import { DiscoveryModelPicker } from '../DiscoveryModelPicker';
import { formatModelLabel, providerLabel } from '../TaskIdentity';

type Override = Task['modelOptionOverrides'][number];

const selectCls = 'hm-select min-h-9 w-full rounded-md border border-edge bg-field px-2.5 py-1 text-ink focus:border-accent focus:outline-none';
const codeCls = `${codeChip} bg-tool-tint text-tool`;
const EDITABLE: Task['state'][] = ['draft', 'ready'];

/** Workspace overlay shadows the global list; disabled codes are not offered. */
export function availableOptions(workspace: Pick<Workspace, 'modelOptions'> | null, config: Pick<AppConfig, 'modelOptions'>): ModelOption[] {
  const byCode = new Map(config.modelOptions.map((o) => [o.id, o]));
  for (const o of workspace?.modelOptions ?? []) byCode.set(o.id, o);
  return [...byCode.values()].filter((o) => !o.disabled);
}

/** Server messages read `modelOptionOverrides.<index>.<field>: <text>`. */
function parseServerError(message: string): { index: number | null; text: string } {
  const m = /modelOptionOverrides\.(\d+)\.\w+: (.*)$/s.exec(message);
  return m ? { index: Number(m[1]), text: m[2]! } : { index: null, text: message };
}

const same = (a: readonly Override[], b: readonly Override[]) =>
  a.length === b.length && a.every((o, i) => o.id === b[i]!.id && o.harness === b[i]!.harness && o.model === b[i]!.model);

function ErrorMsg({ children }: { children: string }) {
  return (
    <p role="alert" className="mt-1 text-[10px] leading-snug text-fail">
      {children}
    </p>
  );
}

export function ModelOptionOverrides({ task, onChanged }: { task: Task; onChanged?: () => void }) {
  const saved = task.modelOptionOverrides;
  const editable = EDITABLE.includes(task.state);
  const [draft, setDraft] = useState<Override[]>(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ index: number | null; text: string } | null>(null);
  const savedKey = JSON.stringify(saved);

  useEffect(() => {
    setDraft(JSON.parse(savedKey) as Override[]);
    setError(null);
  }, [savedKey]);

  const config = useAsyncResource(editable ? api.config : null, [editable]);
  const workspaces = useAsyncResource(editable ? api.workspaces : null, [editable, task.workspaceId]);

  if (!editable && saved.length === 0) return null;

  const cfg = config.data;
  const workspace = workspaces.data?.workspaces.find((w) => w.id === task.workspaceId) ?? null;
  const choices = cfg ? availableOptions(workspace, cfg).filter((o) => !draft.some((d) => d.id === o.id)) : [];
  const dirty = !same(draft, saved);
  const edit = (index: number, next: Override) => {
    setDraft((rows) => rows.map((r, i) => (i === index ? next : r)));
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateTask(task.id, { modelOptionOverrides: draft });
      onChanged?.();
    } catch (e) {
      setError(parseServerError(e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Model Option overrides" className="mt-4">
      <h3 className={`mb-1 ${labelType} text-faint`}>Model Option overrides</h3>
      <p className="mb-2 text-small text-muted">
        Overrides apply to this Ticket only; each code keeps its Workspace or global Harness and Model elsewhere.
      </p>
      {draft.length === 0 && <p className="text-small text-muted">No overrides. Every Model Option uses its Workspace or global Harness and Model.</p>}
      <ul className="space-y-3">
        {draft.map((row, index) => {
          const rowError = error?.index === index ? error.text : null;
          return (
            <li key={row.id} className="rounded-md bg-raised px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <code className={codeCls}>{row.id}</code>
                {editable && (
                  <button
                    type="button"
                    aria-label={`Remove override ${row.id}`}
                    className="text-small text-faint hover:text-fail"
                    onClick={() => {
                      setDraft((rows) => rows.filter((_, i) => i !== index));
                      setError(null);
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
              {editable && cfg ? (
                <div className="mt-2 space-y-2">
                  <label className="block">
                    <span className={`mb-1 block ${labelType} text-muted`}>Harness</span>
                    <select
                      aria-label={`Harness for ${row.id}`}
                      className={selectCls}
                      value={row.harness}
                      onChange={(e) => edit(index, { ...row, harness: e.target.value, model: cfg.harnesses[e.target.value]?.defaultModel ?? '' })}
                    >
                      {Object.keys(cfg.harnesses).map((h) => (
                        <option key={h} value={h}>
                          {providerLabel(h)}
                        </option>
                      ))}
                      {!cfg.harnesses[row.harness] && <option value={row.harness}>{providerLabel(row.harness)} (not configured)</option>}
                    </select>
                  </label>
                  <div>
                    <span className={`mb-1 block ${labelType} text-muted`}>Model</span>
                    <div className={rowError ? 'rounded-md ring-1 ring-fail' : ''}>
                      <DiscoveryModelPicker
                        id={`override-model-${row.id}`}
                        ariaLabel={`Model for ${row.id}`}
                        compact
                        harness={row.harness}
                        value={row.model}
                        options={(cfg.harnesses[row.harness]?.models ?? []).map((m) => m.id)}
                        onChange={(model) => edit(index, { ...row, model })}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <p className="mt-1 text-[12.5px] text-ink">
                  {providerLabel(row.harness)} <span className="text-muted">{formatModelLabel(row.model)}</span>
                </p>
              )}
              {rowError && <ErrorMsg>{rowError}</ErrorMsg>}
            </li>
          );
        })}
      </ul>
      {editable && (
        <div className="mt-3 space-y-2">
          {config.error && <ErrorMsg>{`Could not load Model Options: ${config.error}`}</ErrorMsg>}
          {cfg && (
            <label className="block">
              <span className={`mb-1 block ${labelType} text-muted`}>Add override</span>
              <select
                aria-label="Add override"
                className={selectCls}
                value=""
                disabled={choices.length === 0}
                onChange={(e) => {
                  const option = choices.find((o) => o.id === e.target.value);
                  if (option) setDraft((rows) => [...rows, { id: option.id, harness: option.harness, model: option.model }]);
                  setError(null);
                }}
              >
                <option value="">{choices.length === 0 ? 'No more codes to override' : 'Choose a Model Option code…'}</option>
                {choices.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error?.index === null && <ErrorMsg>{error.text}</ErrorMsg>}
          {dirty && (
            <div className="flex gap-2">
              <button type="button" className={btnPrimary} disabled={saving} onClick={save}>
                {saving ? 'Saving…' : 'Save overrides'}
              </button>
              <button type="button" className={btnGhost} disabled={saving} onClick={() => { setDraft(saved); setError(null); }}>
                Discard
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
