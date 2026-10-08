import type { ReactNode } from 'react';
import { labelType, touchOverlay } from '../ui';
import { layerState } from './inherit-field-model';

export function LayerField<T>({
  label,
  htmlFor,
  value,
  inheritedValue,
  inherited,
  dim = true,
  hideLabel = false,
  onChange,
  onRevert,
  children,
}: {
  label: string;
  htmlFor?: string;
  value: T;
  inheritedValue: T;
  inherited: boolean;
  // Dim the field while it tracks a parent layer. The workspace surface wants
  // this (an un-overridden field visibly defers to the global default); the
  // global surface has no parent, so a field merely at its baseline must not dim.
  dim?: boolean;
  hideLabel?: boolean;
  onChange: (value: T) => void;
  onRevert: () => void;
  children: (input: { id?: string; value: T; onChange: (value: T) => void }) => ReactNode;
}) {
  const state = layerState(value, inheritedValue, inherited);

  return (
    <div className={dim && state.inherited ? 'opacity-60' : undefined}>
      <div className={hideLabel && !state.modified ? 'flex items-center' : 'mb-1.5 flex min-h-6 items-center gap-2'}>
        <label className={hideLabel ? 'sr-only' : `${labelType} whitespace-nowrap text-muted`} htmlFor={htmlFor}>
          {label}
        </label>
        {state.modified && !hideLabel && <span className="shrink-0 text-small text-running">Modified</span>}
        {state.modified && (
          <button
            type="button"
            className="relative ml-auto shrink-0 text-label font-medium text-muted transition-colors duration-150 hover:text-ink"
            onClick={onRevert}
          >
            <span aria-hidden="true" className={touchOverlay} />
            Revert
          </button>
        )}
      </div>
      {children({ id: htmlFor, value: state.effective, onChange })}
    </div>
  );
}
