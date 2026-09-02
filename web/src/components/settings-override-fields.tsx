import type { ReactNode } from 'react';
import type { AppConfig, Workspace } from '../types';
import { settingsRegistry, type SettingKey } from '../../../src/domain/settings-registry.js';
import { FieldError } from './SettingsSection';
import { LayerField } from './LayerField';
import { ScalarControl, type FieldOption, type ScalarControlKind } from './settings-fields';

type Scalar = string | number | boolean;

/**
 * One overridable setting bound to a Workspace column: how to read its override
 * (`null` = inherit), write it, and what global default it inherits. The label
 * and control come from the settings registry so the schema stays the
 * single source of truth. This is the workspace-surface twin of
 * {@link ScalarDescriptor}: where the global page maps `ScalarDescriptor[]`
 * through `ConfigField`, the workspace page maps `OverridableDescriptor[]`
 * through {@link OverrideField}, and both render the same {@link ScalarControl}.
 */
export interface OverridableDescriptor {
  /** Registry key — supplies the label and (unless {@link renderControl} is
   * given) the control type, so field metadata is never re-declared. */
  key: SettingKey;
  id: string;
  /** Parsed server error path for this override column (e.g. `'maxAttempts'`). */
  errorKey: string;
  /** The Workspace column value: `null`/`undefined` means inherit. */
  get: (w: Workspace) => Scalar | null | undefined;
  /** Fold an override write (or `null` to clear) back into the Workspace. */
  set: (w: Workspace, value: Scalar | null) => Workspace;
  /** The global default this field inherits when not overridden. The current
   * Workspace is passed too because some inherited values track the effective
   * override of another field (e.g. the model default follows the harness). */
  inherited: (c: AppConfig, w: Workspace) => Scalar;
  /** Options for a `select` control, given the config and current workspace. */
  options?: (c: AppConfig, w: Workspace) => FieldOption[];
  min?: number;
  /** A number input's `max`, or a config-derived one (e.g. the Machine Ceiling). */
  max?: number | ((c: AppConfig) => number);
  step?: number;
  /** Optional shorter label than the registry's, for a section context. */
  label?: string;
  format?: (v: Scalar) => string;
  switchLabel?: string;
  /** Replace the default {@link ScalarControl} — e.g. a model combobox. */
  renderControl?: (
    input: { id?: string; value: Scalar; onChange: (value: Scalar) => void },
    ctx: { config: AppConfig; workspace: Workspace },
  ) => ReactNode;
}

export function OverrideField({
  descriptor,
  config,
  workspace,
  errors,
  onWorkspace,
}: {
  descriptor: OverridableDescriptor;
  config: AppConfig;
  workspace: Workspace;
  errors: Record<string, string>;
  onWorkspace: (w: Workspace) => void;
}) {
  const d = descriptor;
  const spec = settingsRegistry[d.key];
  const control = spec.control as ScalarControlKind;
  return (
    <div>
      <LayerField<Scalar>
        label={d.label ?? spec.label}
        htmlFor={control === 'toggle' ? undefined : d.id}
        value={d.get(workspace) ?? d.inherited(config, workspace)}
        inheritedValue={d.inherited(config, workspace)}
        inherited={d.get(workspace) === null || d.get(workspace) === undefined}
        onChange={(next) => onWorkspace(d.set(workspace, next))}
        onRevert={() => onWorkspace(d.set(workspace, null))}
      >
        {({ id, value, onChange }) =>
          d.renderControl ? (
            d.renderControl({ id, value, onChange }, { config, workspace })
          ) : (
            <ScalarControl
              id={id}
              control={control}
              value={value}
              onChange={onChange}
              options={d.options?.(config, workspace)}
              min={d.min}
              max={typeof d.max === 'function' ? d.max(config) : d.max}
              step={d.step}
              switchLabel={d.switchLabel}
              widthClass={control === 'number' ? 'w-28' : undefined}
            />
          )
        }
      </LayerField>
      <FieldError message={errors[d.errorKey]} />
    </div>
  );
}
