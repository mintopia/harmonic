import type { ReactNode } from 'react';
import { btnQuiet, labelType } from '../ui';
import { Switch } from './Switch';
import { inheritState, toggleOverride } from './inherit-field-model';

/**
 * Inheritance field wrapper (ADR-0012, issue #65): the per-Workspace face of an
 * overridable setting. While inheriting it shows the effective value with a
 * muted "Inherited from global default" note and an Override toggle; flipping
 * the toggle reveals the input (rendered by `children`) seeded on that value,
 * and a "Reset to default" link clears the override back to inherit (`null`).
 *
 * The input is a render prop so one wrapper serves every field shape — a
 * `<select>` (harness/model/isolation/priority) or a number `<input>` (the
 * concurrency cap) — while owning the inherit/override chrome once. The global
 * settings page renders those same inputs bare (it is the root — no inherit
 * affordance), so this wrapper is Workspace-scoped only.
 */
export function InheritField<T>({
  label,
  htmlFor,
  value,
  inherited,
  onChange,
  format = String,
  children,
}: {
  /** Field name shown above the control and in the toggle's accessible label. */
  label: string;
  /** `id` handed to the revealed input so the label points at it. */
  htmlFor?: string;
  /** The Workspace's stored value: `null`/`undefined` = inherit. */
  value: T | null | undefined;
  /** The resolved global default shown while inheriting and used to seed an override. */
  inherited: T;
  /** Persist the new stored value: a real value overrides, `null` inherits. */
  onChange: (next: T | null) => void;
  /** How to render the inherited value's read-only line. Defaults to `String`;
   * pass a formatter for values `String` mangles — a boolean as "On"/"Off". */
  format?: (value: T) => string;
  /** The input to reveal once overridden, wired to the effective value. */
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
          {format(effective)}{' '}
          <span className="text-small text-muted">· Inherited from global default</span>
        </p>
      )}
    </div>
  );
}
