import { useState } from 'react';
import type { AppConfig, ConfigLayers, HarnessConfig, ModelCatalogEntry } from '../types';
import { btnGhost, btnQuiet, field, selectField, tableHead, touchTarget, touchTargetInline } from '../ui';
import { FieldError, fieldLabel } from './SettingsSection';
import { Icon } from './Icon';
import { ListEditor } from './EntryList';
import { EnvEditor } from './EnvEditor';

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

function HarnessCard({
  id,
  harness,
  baseline,
  fieldErrors,
  permissionModes,
  onChange,
}: {
  id: string;
  harness: HarnessConfig;
  baseline: HarnessConfig;
  fieldErrors: Record<string, string>;
  permissionModes: ConfigLayers['harnessPermissionModes'];
  onChange: (harness: HarnessConfig) => void;
}) {
  const set = <K extends keyof HarnessConfig>(key: K, value: HarnessConfig[K]) => onChange({ ...harness, [key]: value });
  const prefix = `harnesses.${id}`;
  const hasErrors = Object.keys(fieldErrors).some((k) => k.startsWith(`${prefix}.`));
  const permissionMode = permissionModes[id];

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
          {permissionMode && (
            <div>
              <label className={fieldLabel} htmlFor={`harness-${id}-permission-mode`}>Permission mode</label>
              <select
                id={`harness-${id}-permission-mode`}
                className={`${selectField} w-full`}
                value={harness.permissionMode ?? permissionMode.defaultMode}
                onChange={(e) => set('permissionMode', e.target.value)}
              >
                {Object.entries(permissionMode.modes).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <FieldError message={fieldErrors[`${prefix}.permissionMode`]} />
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

export function HarnessesSection({
  config,
  baseline,
  fieldErrors,
  permissionModes,
  onChange,
}: {
  config: AppConfig;
  baseline: AppConfig;
  fieldErrors: Record<string, string>;
  permissionModes: ConfigLayers['harnessPermissionModes'];
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
          permissionModes={permissionModes}
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
