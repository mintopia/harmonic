import type { AppConfig } from '../types';
import { settingsRegistry, type SettingKey } from '../../../src/domain/settings-registry.js';
import { field as fieldClass, selectField } from '../ui';
import { FieldError, fieldLabel } from './SettingsSection';
import { Switch } from './Switch';

export interface FieldOption {
  value: string;
  label: string;
}

/**
 * One scalar setting bound to the global AppConfig: how to read it, write it,
 * and (for a select) enumerate its options. Label and control are taken from
 * the settings registry when the field maps to a registry key (see
 * {@link registryField}), so the schema stays the single source of truth for
 * field metadata (ADR-0044). `errorKey` may depend on the config because a
 * server error path can name a nested key (e.g. the default model lives under
 * the current harness).
 */
export interface ScalarDescriptor {
  id: string;
  control: 'text' | 'number' | 'select' | 'toggle';
  label: string;
  errorKey: string | ((c: AppConfig) => string);
  get: (c: AppConfig) => string | number | boolean;
  set: (c: AppConfig, raw: string | number | boolean) => AppConfig;
  options?: (c: AppConfig) => FieldOption[];
  disabled?: (c: AppConfig) => boolean;
  min?: number;
  step?: number;
  placeholder?: string;
  /** Inline label beside a toggle's switch. */
  switchLabel?: string;
  /** Width utility for the input (number) or the wrapper (text). */
  widthClass?: string;
}

/** Registry keys whose control a {@link ConfigField} can render — i.e. the
 * scalar controls, excluding the `json`/`verifier` composites that keep bespoke
 * editors. Restricting {@link registryField} to these makes passing a composite
 * key a compile error instead of a silently-wrong text input. */
export type ScalarSettingKey = {
  [K in SettingKey]: (typeof settingsRegistry)[K]['control'] extends ScalarDescriptor['control'] ? K : never;
}[SettingKey];

/** A descriptor whose label + control come from the registry entry, so a
 * registry-backed field never re-declares metadata the schema already owns. */
export function registryField(
  key: ScalarSettingKey,
  rest: Omit<ScalarDescriptor, 'id' | 'label' | 'control'> & { id?: string },
): ScalarDescriptor {
  const spec = settingsRegistry[key];
  return {
    id: rest.id ?? `settings-${key}`,
    label: spec.label,
    control: spec.control,
    ...rest,
  };
}

/** Append the current value as a synthetic option when it is not already in the
 * list — the global page's "(not in models list)" affordance, so a configured
 * model a harness no longer serves stays visible and selectable rather than
 * silently snapping to another option. */
export function withCurrent(options: FieldOption[], current: string): FieldOption[] {
  if (!current || options.some((o) => o.value === current)) return options;
  return [...options, { value: current, label: `${current} (not in models list)` }];
}

/** Map a list of string values to `{ value, label }` options. */
export function toOptions(values: readonly string[]): FieldOption[] {
  return values.map((v) => ({ value: v, label: v }));
}

/**
 * Renders one scalar setting, dispatching on its `control`. Presentational: the
 * caller passes the config and a change handler that folds the field's write
 * back into the whole config. This is the schema-driven form engine's field
 * renderer — every scalar settings input flows through it, so no field's
 * `<label>/<input>/<FieldError>` markup is written by hand per setting.
 */
export function ConfigField({
  descriptor,
  config,
  errors,
  onConfig,
}: {
  descriptor: ScalarDescriptor;
  config: AppConfig;
  errors: Record<string, string>;
  onConfig: (c: AppConfig) => void;
}) {
  const d = descriptor;
  const errorKey = typeof d.errorKey === 'function' ? d.errorKey(config) : d.errorKey;
  const error = errors[errorKey];
  const disabled = d.disabled?.(config) ?? false;
  const change = (raw: string | number | boolean) => onConfig(d.set(config, raw));

  if (d.control === 'toggle') {
    return (
      <div>
        <span className={fieldLabel}>{d.label}</span>
        <div className="pt-1">
          <Switch checked={Boolean(d.get(config))} onChange={(v) => change(v)} disabled={disabled}>
            {d.switchLabel}
          </Switch>
        </div>
        <FieldError message={error} />
      </div>
    );
  }

  if (d.control === 'select') {
    const options = d.options?.(config) ?? [];
    return (
      <div>
        <label className={fieldLabel} htmlFor={d.id}>
          {d.label}
        </label>
        <select
          id={d.id}
          className={`${selectField} w-full`}
          value={String(d.get(config))}
          disabled={disabled}
          onChange={(e) => change(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <FieldError message={error} />
      </div>
    );
  }

  if (d.control === 'number') {
    return (
      <div>
        <label className={fieldLabel} htmlFor={d.id}>
          {d.label}
        </label>
        <input
          id={d.id}
          type="number"
          min={d.min}
          step={d.step}
          disabled={disabled}
          className={`${fieldClass} ${d.widthClass ?? 'w-28'} tabular-nums`}
          value={Number(d.get(config))}
          onChange={(e) => change(Number(e.target.value))}
        />
        <FieldError message={error} />
      </div>
    );
  }

  return (
    <div className={d.widthClass}>
      <label className={fieldLabel} htmlFor={d.id}>
        {d.label}
      </label>
      <input
        id={d.id}
        className={fieldClass}
        placeholder={d.placeholder}
        disabled={disabled}
        value={String(d.get(config))}
        onChange={(e) => change(e.target.value)}
      />
      <FieldError message={error} />
    </div>
  );
}
