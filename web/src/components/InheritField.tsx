import type { ReactNode } from 'react';
import { btnQuiet, labelType } from '../ui';
import { Switch } from './Switch';
import { inheritState, toggleOverride, type InheritSource } from './inherit-field-model';

export function InheritField<T, R extends T = T>({
  label,
  htmlFor,
  value,
  inherited,
  inheritedFrom = 'global default',
  onChange,
  format = String,
  children,
}: {
  label: string;
  htmlFor?: string;
  value: T | null | undefined;
  inherited: R;
  inheritedFrom?: InheritSource;
  onChange: (next: T | null) => void;
  format?: (value: R) => string;
  children: (input: { id?: string; value: T; onChange: (value: T) => void }) => ReactNode;
}) {
  const { overridden, effective } = inheritState(value, inherited);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label className={`${labelType} text-muted`} htmlFor={overridden ? htmlFor : undefined}>
          {label}
        </label>
        <Switch
          checked={overridden}
          onChange={(on) => onChange(toggleOverride(on, value, inherited))}
          label={`Override ${label}`}
        />
      </div>
      {overridden ? (
        <>
          {children({ id: htmlFor, value: effective, onChange })}
          <button type="button" className={`mt-1.5 ${btnQuiet} text-label`} onClick={() => onChange(null)}>
            Reset to default
          </button>
        </>
      ) : (
        <p className="text-ink">
          {format(inherited)}{' '}
          <span className="text-small text-muted">
            · Inherited from {inheritedFrom === 'workspace' ? 'this workspace' : 'global default'}
          </span>
        </p>
      )}
    </div>
  );
}
