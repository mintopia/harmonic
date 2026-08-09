/**
 * Setting Overrides (ADR-0012, issue #59). An overridable setting resolves as
 * `Workspace value ?? global default`: a Workspace stores `null` to mean
 * *inherit* (tracking the global default as it changes) until it sets an
 * explicit value. The effective value is derived at read time — no per-Workspace
 * copy drifts silently behind the default.
 */

/**
 * The effective value of an overridable setting: the Workspace's own value when
 * set, otherwise the global default it inherits. `null`/`undefined` both mean
 * *inherit* (a not-yet-migrated row reads `undefined`, a stored inherit reads
 * `null`) — either way the global default wins.
 */
export function resolve<T>(workspaceVal: T | null | undefined, globalDefault: T): T {
  return workspaceVal ?? globalDefault;
}

/**
 * A Workspace's concurrency cap resolves like any override, then is clamped to
 * the Machine Ceiling: a per-Workspace override can never breach the machine's
 * safety limit, so total concurrency across all Workspaces still cannot exceed
 * the ceiling (ADR-0012). Inherit (`null`) resolves straight to the ceiling.
 */
export function resolveCap(workspaceCap: number | null | undefined, machineCeiling: number): number {
  return Math.min(resolve(workspaceCap, machineCeiling), machineCeiling);
}
