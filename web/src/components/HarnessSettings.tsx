import { useState } from 'react';
import type { AppConfig, HarnessConfig, ModelPrice } from '../types';
import { btnGhost, btnQuiet, field } from '../ui';
import { FieldError, fieldLabel } from './SettingsSection';
import { Icon } from './Icon';

/** Add/remove/edit rows of a plain string list (harness args, models). */
function ListEditor({ items, onChange, ariaLabel }: { items: string[]; onChange: (items: string[]) => void; ariaLabel: string }) {
  const update = (i: number, value: string) => onChange(items.map((item, idx) => (idx === i ? value : item)));
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const add = () => onChange([...items, '']);

  return (
    <div className="space-y-2.5">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <input aria-label={ariaLabel} className={`${field} font-data`} value={item} onChange={(e) => update(i, e.target.value)} />
          <button type="button" aria-label={`Remove ${ariaLabel}`} onClick={() => remove(i)} className={`${btnQuiet} px-2 py-1.5`}>
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

/** Key-value rows for a harness's spawned-process env. Values are masked
 * (password-style) by default since they commonly hold API keys, with a
 * per-row reveal toggle. */
function EnvEditor({ env, onChange }: { env: Record<string, string>; onChange: (env: Record<string, string>) => void }) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const entries = Object.entries(env);

  const rename = (oldKey: string, newKey: string, value: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (k === oldKey) {
        if (newKey) next[newKey] = value;
      } else {
        next[k] = v;
      }
    }
    onChange(next);
  };
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
            value={key}
            onChange={(e) => rename(key, e.target.value, value)}
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
            className={`${btnQuiet} px-2 py-1.5`}
          >
            {revealed[key] ? 'Hide' : 'Show'}
          </button>
          <button type="button" aria-label="Remove env var" onClick={() => remove(key)} className={`${btnQuiet} px-2 py-1.5`}>
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

/** One harness as a collapsed disclosure row: the summary carries the id
 * and launch command (machine data → Data face); the deep config only
 * unfolds on demand. A failed save with errors inside forces it open so
 * the messages are never hidden. */
function HarnessCard({
  id,
  harness,
  fieldErrors,
  onChange,
}: {
  id: string;
  harness: HarnessConfig;
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
        <div className="grid gap-3 sm:grid-cols-2">
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

        <div className="mt-3">
          <label className={fieldLabel}>Args</label>
          <ListEditor items={harness.args} onChange={(args) => set('args', args)} ariaLabel="Argument" />
          <FieldError message={fieldErrors[`${prefix}.args`]} />
        </div>

        <div className="mt-3">
          <label className={fieldLabel}>Environment</label>
          <EnvEditor env={harness.env} onChange={(env) => set('env', env)} />
          <FieldError message={fieldErrors[`${prefix}.env`]} />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className={fieldLabel}>Models</label>
            <ListEditor items={harness.models} onChange={(models) => set('models', models)} ariaLabel="Model" />
            <FieldError message={fieldErrors[`${prefix}.models`]} />
          </div>
          <div>
            <label className={fieldLabel} htmlFor={`harness-${id}-default-model`}>Default Model</label>
            <select
              id={`harness-${id}-default-model`}
              className={`${field} font-data`}
              value={harness.defaultModel}
              onChange={(e) => set('defaultModel', e.target.value)}
            >
              {harness.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {harness.defaultModel && !harness.models.includes(harness.defaultModel) && (
                <option value={harness.defaultModel}>{harness.defaultModel} (not in models list)</option>
              )}
            </select>
            <FieldError message={fieldErrors[`${prefix}.defaultModel`]} />
          </div>
        </div>
      </div>
    </details>
  );
}

export function HarnessesSection({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
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

export function PriceOverridesSection({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (prices: AppConfig['prices']) => void;
}) {
  const entries = Object.entries(config.prices);

  const renameModel = (oldModel: string, newModel: string) => {
    const next: AppConfig['prices'] = {};
    for (const [m, p] of entries) next[m === oldModel ? newModel : m] = p;
    onChange(next);
  };
  const setPrice = (model: string, price: ModelPrice) => onChange({ ...config.prices, [model]: price });
  const remove = (model: string) => {
    const { [model]: _dropped, ...rest } = config.prices;
    onChange(rest);
  };
  const add = () => {
    let model = 'new-model';
    let i = 1;
    while (model in config.prices) model = `new-model-${i++}`;
    onChange({ ...config.prices, [model]: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  };

  return (
    <div>
      {entries.length > 0 && (
        <div className="mb-1 hidden gap-2.5 sm:grid sm:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]">
          <span className={fieldLabel}>Model</span>
          {PRICE_FIELDS.map((k) => (
            <span key={k} className={fieldLabel}>
              {PRICE_LABELS[k]}
            </span>
          ))}
          <span />
        </div>
      )}

      <div className="space-y-2.5">
        {entries.map(([model, price]) => (
          <div key={model}>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] sm:items-center">
              <input
                aria-label="Model id"
                className={`${field} font-data`}
                value={model}
                onChange={(e) => renameModel(model, e.target.value)}
              />
              {PRICE_FIELDS.map((k) => (
                <input
                  key={k}
                  type="number"
                  min={0}
                  step="any"
                  aria-label={PRICE_LABELS[k]}
                  className={`${field} font-data`}
                  value={price[k]}
                  onChange={(e) => setPrice(model, { ...price, [k]: Number(e.target.value) })}
                />
              ))}
              <button type="button" aria-label="Remove price override" onClick={() => remove(model)} className={`${btnQuiet} px-2 py-1.5`}>
                ✕
              </button>
            </div>
            <FieldError
              message={
                fieldErrors[`prices.${model}.input`] ??
                fieldErrors[`prices.${model}.output`] ??
                fieldErrors[`prices.${model}.cacheRead`] ??
                fieldErrors[`prices.${model}.cacheWrite`]
              }
            />
          </div>
        ))}
      </div>
      {entries.length === 0 && <p className="text-body text-muted">No price overrides configured.</p>}
      <button type="button" onClick={add} className={`${btnGhost} mt-3`}>
        + Add price override
      </button>
    </div>
  );
}
