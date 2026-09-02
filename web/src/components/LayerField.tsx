import type { ReactNode } from 'react';
import { btnQuiet, labelType } from '../ui';
import { layerState } from './inherit-field-model';

export function LayerField<T>({
  label,
  htmlFor,
  value,
  inheritedValue,
  inherited,
  onChange,
  onRevert,
  children,
}: {
  label: string;
  htmlFor?: string;
  value: T;
  inheritedValue: T;
  inherited: boolean;
  onChange: (value: T) => void;
  onRevert: () => void;
  children: (input: { id?: string; value: T; onChange: (value: T) => void }) => ReactNode;
}) {
  const state = layerState(value, inheritedValue, inherited);

  return (
    <div className={state.inherited ? 'opacity-60' : undefined}>
      <div className="mb-1.5 flex items-center gap-2">
        <label className={`${labelType} text-muted`} htmlFor={htmlFor}>
          {label}
        </label>
        {state.modified && <span className="text-small text-amber">Modified</span>}
        {state.modified && (
          <button type="button" className={`ml-auto ${btnQuiet} text-label`} onClick={onRevert}>
            Revert
          </button>
        )}
      </div>
      {children({ id: htmlFor, value: state.effective, onChange })}
    </div>
  );
}
