/**
 * Inheritance-field logic (ADR-0012, issue #65). An overridable setting stores
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
 * The stored value after the operator flips the override toggle. Turning it on
 * seeds from the current override if one somehow lingers, else from the
 * inherited default (so the revealed input starts on the effective value).
 * Turning it off clears back to `null` — inherit again (same as Reset).
 */
export function toggleOverride<T>(on: boolean, current: T | null | undefined, inherited: T): T | null {
  if (!on) return null;
  return current ?? inherited;
}
