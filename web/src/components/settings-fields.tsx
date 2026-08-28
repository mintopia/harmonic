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

/** The scalar controls a {@link ScalarControl} can render. */
export type ScalarControlKind = 'text' | 'number' | 'select' | 'toggle';

/**
 * The bare input for one scalar setting, dispatching on `control` — no label,
 * no FieldError, no surrounding layout. This is the single control renderer both
 * settings surfaces share: {@link ConfigField} wraps it in a label + error for
 * the global page, and the workspace `OverrideField` wraps it in an
 * `InheritField`'s override slot, so the same select/number/text/toggle markup
 * is never written twice (ADR-0044 Decision G).
 */
export function ScalarControl({
  id,
  control,
  value,
  onChange,
  options,
  disabled = false,
  min,
  max,
  step,
  placeholder,
  switchLabel,
  widthClass,
}: {
  id?: string;
  control: ScalarControlKind;
  value: string | number | boolean;
  onChange: (raw: string | number | boolean) => void;
  options?: FieldOption[];
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  switchLabel?: string;
  widthClass?: string;
}) {
  if (control === 'toggle') {
    return (
      <Switch checked={Boolean(value)} onChange={(v) => onChange(v)} disabled={disabled}>
        {switchLabel}
      </Switch>
    );
  }

  if (control === 'select') {
    return (
      <select
        id={id}
        className={`${selectField} w-full`}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {(options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  if (control === 'number') {
    return (
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className={`${fieldClass} ${widthClass ?? 'w-28'} tabular-nums`}
        value={Number(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    );
  }

  return (
    <input
      id={id}
      className={fieldClass}
      placeholder={placeholder}
      disabled={disabled}
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Renders one scalar setting bound to the global AppConfig: label, the shared
 * {@link ScalarControl}, and its FieldError. Presentational: the caller passes
 * the config and a change handler that folds the field's write back into the
 * whole config. Every scalar settings input on the global page flows through
 * here, so no field's `<label>/<input>/<FieldError>` markup is written by hand.
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
  const control = (
    <ScalarControl
      id={d.id}
      control={d.control}
      value={d.get(config)}
      onChange={(raw) => onConfig(d.set(config, raw))}
      options={d.options?.(config)}
      disabled={disabled}
      min={d.min}
      step={d.step}
      placeholder={d.placeholder}
      switchLabel={d.switchLabel}
      widthClass={d.control === 'number' ? d.widthClass : undefined}
    />
  );

  // A toggle labels itself via its inline switch text; the others take a
  // `<label htmlFor>` above the control.
  if (d.control === 'toggle') {
    return (
      <div>
        <span className={fieldLabel}>{d.label}</span>
        <div className="pt-1">{control}</div>
        <FieldError message={error} />
      </div>
    );
  }

  // Only text/select/number reach here (toggle returned above); the width
  // utility applies to the text wrapper, harmless on the others.
  return (
    <div className={d.control === 'text' ? d.widthClass : undefined}>
      <label className={fieldLabel} htmlFor={d.id}>
        {d.label}
      </label>
      {control}
      <FieldError message={error} />
    </div>
  );
}
