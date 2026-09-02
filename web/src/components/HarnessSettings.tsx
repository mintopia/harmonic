import { useState } from 'react';
import type { AppConfig, HarnessConfig, ModelCatalogEntry } from '../types';
import { btnGhost, btnQuiet, field, selectField, tableHead, touchTarget, touchTargetInline } from '../ui';
import { FieldError, fieldLabel } from './SettingsSection';
import { Icon } from './Icon';
import { renameRecordKey } from './settings-rename';

/**
 * Holds the in-progress name in local state so typing never rewrites the parent
 * object's key — which is what remounted the row and stole focus. Committed to
 * the parent only on `commit` (blur), via {@link renameRecordKey}, which
 * silently keeps the old name on an empty or colliding rename.
 */
function useKeyRename<V>(record: Record<string, V>, onChange: (next: Record<string, V>) => void) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return {
    nameFor: (key: string) => drafts[key] ?? key,
    setName: (key: string, value: string) => setDrafts((d) => ({ ...d, [key]: value })),
    commit: (key: string) => {
      const draft = drafts[key];
      setDrafts((d) => {
        const { [key]: _omit, ...rest } = d;
        return rest;
      });
      if (draft === undefined) return;
      const next = renameRecordKey(record, key, draft);
      if (next !== record) onChange(next);
    },
  };
}

function ListEditor({ items, onChange, ariaLabel }: { items: string[]; onChange: (items: string[]) => void; ariaLabel: string }) {
  const update = (i: number, value: string) => onChange(items.map((item, idx) => (idx === i ? value : item)));
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const add = () => onChange([...items, '']);

  return (
    <div className="space-y-2.5">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <input aria-label={ariaLabel} className={`${field} font-data`} value={item} onChange={(e) => update(i, e.target.value)} />
          <button type="button" aria-label={`Remove ${ariaLabel}`} onClick={() => remove(i)} className={`${touchTarget} ${btnQuiet}`}>
            ✕
          </button>
        </div>
      ))}
      {items.length === 0 && <p className="text-body text-muted">None set.</p>}
      <button type="button" onClick={add} className={btnGhost}>
        + Add
      </button>
    </div>
  );
}

const catalogCols = 'grid-cols-[minmax(200px,340px)_repeat(4,minmax(0,88px))_minmax(0,104px)_auto]';
const numField = `${field} px-2 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`;

function CatalogEditor({ items, baseline, onChange }: { items: ModelCatalogEntry[]; baseline: ModelCatalogEntry[]; onChange: (items: ModelCatalogEntry[]) => void }) {
  const [priceDrafts, setPriceDrafts] = useState<Record<string, NonNullable<ModelCatalogEntry['price']>>>({});
  const update = (i: number, entry: ModelCatalogEntry) => onChange(items.map((item, index) => (index === i ? entry : item)));
  const updatePrice = (i: number, key: keyof NonNullable<ModelCatalogEntry['price']>, value: string) => {
    const item = items[i];
    if (!item) return;
    const draft = priceDrafts[item.id] ?? item.price ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    setPriceDrafts((drafts) => ({ ...drafts, [item.id]: draft }));
    if (value === '') return update(i, { ...item, price: undefined });
    const price = { ...draft, [key]: Number(value) };
    setPriceDrafts((drafts) => ({ ...drafts, [item.id]: price }));
    update(i, { ...item, price });
  };
  const baselineById = new Map(baseline.map((item) => [item.id, item]));
  const removed = baseline.filter((item) => !items.some((current) => current.id === item.id));
  return <div>
    <div className="overflow-x-auto">
      <div className="w-fit min-w-[560px]">
        {items.length > 0 && <div className={`grid ${catalogCols} items-end gap-x-2 border-b border-hairline pb-1.5 ${tableHead}`}>
          <span>Model</span>
          {PRICE_FIELDS.map((key) => <span key={key} className="text-right leading-tight">{PRICE_LABELS[key]}</span>)}
          <span className="text-right leading-tight">Context</span>
          <span aria-hidden="true" />
        </div>}
        {items.map((item, i) => {
          const inherited = baselineById.get(item.id);
          const modified = inherited === undefined || JSON.stringify(item) !== JSON.stringify(inherited);
          return <div key={i} className={`grid ${catalogCols} items-center gap-x-2 border-b border-hairline py-1.5 ${modified ? '' : 'opacity-55'}`}>
            <input aria-label="Model id" className={`${field} font-data`} value={item.id} onChange={(e) => update(i, { ...item, id: e.target.value })} />
            {PRICE_FIELDS.map((key) => <input key={key} aria-label={PRICE_LABELS[key]} type="number" min={0} step="any" placeholder={inherited?.price?.[key] != null ? String(inherited.price[key]) : undefined} className={numField} value={item.price?.[key] ?? ''} onChange={(e) => updatePrice(i, key, e.target.value)} />)}
            <input aria-label="Context window" type="number" min={1} placeholder={inherited?.contextWindow != null ? String(inherited.contextWindow) : undefined} className={numField} value={item.contextWindow ?? ''} onChange={(e) => update(i, { ...item, contextWindow: e.target.value === '' ? undefined : Number(e.target.value) })} />
            <div className="flex items-center justify-end gap-0.5">
              {modified && <button type="button" className={`${touchTargetInline} ${btnQuiet} px-1.5 text-label`} onClick={() => onChange(inherited === undefined ? items.filter((_, index) => index !== i) : items.map((current, index) => index === i ? inherited : current))}>Revert</button>}
              <button type="button" aria-label={`Remove ${item.id || 'model'}`} onClick={() => onChange(items.filter((_, index) => index !== i))} className={`${touchTarget} ${btnQuiet}`}>✕</button>
            </div>
          </div>;
        })}
        {items.length === 0 && <p className="py-1.5 text-body text-muted">No models in this harness.</p>}
      </div>
    </div>
    {removed.length > 0 && <div className="mt-2 space-y-1.5">
      {removed.map((item) => <div key={item.id} className="flex items-center gap-2 opacity-60">
        <span className="font-data text-data line-through">{item.id}</span>
        <span className="text-small text-fail">Removed</span>
        <button type="button" className={`ml-auto ${touchTargetInline} ${btnQuiet} text-label`} onClick={() => onChange([...items, item])}>Restore</button>
      </div>)}
    </div>}
    <button type="button" onClick={() => onChange([...items, { id: '' }])} className={`mt-3 ${btnGhost}`}>+ Add model</button>
  </div>;
}

function EnvEditor({ env, onChange }: { env: Record<string, string>; onChange: (env: Record<string, string>) => void }) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const rename = useKeyRename(env, onChange);
  const entries = Object.entries(env);

  const setValue = (key: string, value: string) => onChange({ ...env, [key]: value });
  const remove = (key: string) => {
    const { [key]: _dropped, ...rest } = env;
    onChange(rest);
  };
  const add = () => {
    let key = 'NEW_VAR';
    let i = 1;
    while (key in env) key = `NEW_VAR_${i++}`;
    onChange({ ...env, [key]: '' });
  };

  return (
    <div className="space-y-2.5">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-center gap-2.5">
          <input
            aria-label="Env var name"
            className={`${field} w-1/3 font-data`}
            value={rename.nameFor(key)}
            onChange={(e) => rename.setName(key, e.target.value)}
            onBlur={() => rename.commit(key)}
          />
          <input
            aria-label="Env var value"
            type={revealed[key] ? 'text' : 'password'}
            className={`${field} flex-1 font-data`}
            value={value}
            onChange={(e) => setValue(key, e.target.value)}
          />
          <button
            type="button"
            aria-label={revealed[key] ? 'Hide value' : 'Reveal value'}
            onClick={() => setRevealed((r) => ({ ...r, [key]: !r[key] }))}
            className={`${touchTargetInline} ${btnQuiet}`}
          >
            {revealed[key] ? 'Hide' : 'Show'}
          </button>
          <button type="button" aria-label="Remove env var" onClick={() => remove(key)} className={`${touchTarget} ${btnQuiet}`}>
            ✕
          </button>
        </div>
      ))}
      {entries.length === 0 && <p className="text-body text-muted">No environment variables set.</p>}
      <button type="button" onClick={add} className={btnGhost}>
        + Add variable
      </button>
    </div>
  );
}

function HarnessCard({
  id,
  harness,
  baseline,
  fieldErrors,
  onChange,
}: {
  id: string;
  harness: HarnessConfig;
  baseline: HarnessConfig;
  fieldErrors: Record<string, string>;
  onChange: (harness: HarnessConfig) => void;
}) {
  const set = <K extends keyof HarnessConfig>(key: K, value: HarnessConfig[K]) => onChange({ ...harness, [key]: value });
  const prefix = `harnesses.${id}`;
  const hasErrors = Object.keys(fieldErrors).some((k) => k.startsWith(`${prefix}.`));

  return (
    <details className="group" open={hasErrors || undefined}>
      <summary className="flex cursor-pointer select-none items-center gap-2 rounded-md px-1.5 py-2.5 transition-colors duration-150 hover:bg-raised [list-style:none] [&::-webkit-details-marker]:hidden">
        <Icon
          className="-rotate-90 text-faint transition-transform duration-150 group-open:rotate-0 motion-reduce:transition-none"
          name="chevron-down"
        />
        <span className="font-semibold">{id}</span>
        <span className="min-w-0 truncate font-data text-data text-muted">
          {[harness.command, ...harness.args].join(' ')}
        </span>
      </summary>

      <div className="px-1.5 pb-3 pt-1">
        <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
          <div>
            <label className={fieldLabel} htmlFor={`harness-${id}-command`}>Command</label>
            <input
              id={`harness-${id}-command`}
              className={`${field} font-data`}
              value={harness.command}
              onChange={(e) => set('command', e.target.value)}
            />
            <FieldError message={fieldErrors[`${prefix}.command`]} />
          </div>
          <div>
            <label className={fieldLabel} htmlFor={`harness-${id}-session-log-dir`}>Session Log Directory</label>
            <input
              id={`harness-${id}-session-log-dir`}
              className={`${field} font-data`}
              value={harness.sessionLogDir ?? ''}
              onChange={(e) => set('sessionLogDir', e.target.value)}
            />
            <FieldError message={fieldErrors[`${prefix}.sessionLogDir`]} />
          </div>
        </div>

        <div className="mt-3 max-w-3xl">
          <label className={fieldLabel}>Args</label>
          <ListEditor items={harness.args} onChange={(args) => set('args', args)} ariaLabel="Argument" />
          <FieldError message={fieldErrors[`${prefix}.args`]} />
        </div>

        <div className="mt-3 max-w-3xl">
          <label className={fieldLabel}>Environment</label>
          <EnvEditor env={harness.env} onChange={(env) => set('env', env)} />
          <FieldError message={fieldErrors[`${prefix}.env`]} />
        </div>

        <div className="mt-3">
          <CatalogEditor items={harness.models} baseline={baseline.models} onChange={(models) => set('models', models)} />
          <FieldError message={fieldErrors[`${prefix}.models`]} />
        </div>

        <div className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-2">
          <div>
            <label className={fieldLabel} htmlFor={`harness-${id}-default-model`}>Default Model</label>
            <select
              id={`harness-${id}-default-model`}
              className={`${selectField} w-full font-data`}
              value={harness.defaultModel}
              onChange={(e) => set('defaultModel', e.target.value)}
            >
              {harness.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
              {harness.defaultModel && !harness.models.some((model) => model.id === harness.defaultModel) && (
                <option value={harness.defaultModel}>{harness.defaultModel} (not in models list)</option>
              )}
            </select>
            <FieldError message={fieldErrors[`${prefix}.defaultModel`]} />
          </div>
          <div>
            <label className={fieldLabel} htmlFor={`harness-${id}-cache-warm-seconds`}>Cache warm seconds</label>
            <input id={`harness-${id}-cache-warm-seconds`} type="number" min={1} className={field} value={harness.cacheWarmSeconds} onChange={(e) => set('cacheWarmSeconds', Number(e.target.value))} />
            <FieldError message={fieldErrors[`${prefix}.cacheWarmSeconds`]} />
          </div>
        </div>
      </div>
    </details>
  );
}

export function HarnessesSection({
  config,
  baseline,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  baseline: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (harnesses: AppConfig['harnesses']) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {Object.entries(config.harnesses).map(([id, harness]) => (
        <HarnessCard
          key={id}
          id={id}
          harness={harness}
          baseline={baseline.harnesses[id] ?? harness}
          fieldErrors={fieldErrors}
          onChange={(next) => onChange({ ...config.harnesses, [id]: next })}
        />
      ))}
    </div>
  );
}

const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const PRICE_LABELS: Record<(typeof PRICE_FIELDS)[number], string> = {
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache Read',
  cacheWrite: 'Cache Write',
};
