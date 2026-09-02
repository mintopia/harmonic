/**
 * Inheritance-field logic. An overridable setting stores
 * `null`/`undefined` on a Workspace to mean *inherit* the global default; any
 * other value (including falsy ones like `0`) is an explicit override. The
 * component is the thin shell around these two pure transitions — kept here so
 * the state machine is testable without a DOM.
 */

export interface InheritState<T> {
  /** True when the Workspace pins its own value rather than tracking the default. */
  overridden: boolean;
  /** The value to show: the override when set, otherwise the inherited default. */
  effective: T;
}

export interface LayerState<T> {
  effective: T;
  inherited: boolean;
  modified: boolean;
}

export function layerState<T>(value: T, inheritedValue: T, inherited: boolean): LayerState<T> {
  return { effective: inherited ? inheritedValue : value, inherited, modified: !inherited };
}

/**
 * Resolve what an inheritance field should display: `null`/`undefined` inherit
 * the global default (mirroring `resolve` in src/domain/setting-override.ts),
 * anything else is a pinned override. Note `0`/`''`/`false` are real overrides,
 * not inherit — the check is against nullish only.
 */
export function inheritState<T>(value: T | null | undefined, inherited: T): InheritState<T> {
  const overridden = value !== null && value !== undefined;
  return { overridden, effective: overridden ? (value as T) : inherited };
}

/**
 * Which layer supplies an inheriting field's value, for the "Inherited from …"
 * note. A Task inherits the *Workspace* override when the Workspace
 * pinned that field (non-nullish, same rule as {@link inheritState}); only when
 * the Workspace also inherits does the value fall through to the global default.
 * Pass the Workspace's stored value for the field, not the Task's.
 */
export type InheritSource = 'workspace' | 'global default';
export function inheritSource(workspaceValue: unknown): InheritSource {
  return workspaceValue !== null && workspaceValue !== undefined ? 'workspace' : 'global default';
}

/**
 * The stored value after the operator flips the override toggle. Turning it on
 * seeds from the current override if one somehow lingers, else from the
 * inherited default (so the revealed input starts on the effective value).
 * Turning it off clears back to `null` — inherit again (same as Reset).
 */
export function toggleOverride<T>(on: boolean, current: T | null | undefined, inherited: T): T | null {
  if (!on) return null;
  return current ?? inherited;
}
