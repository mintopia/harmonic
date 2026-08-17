import type { WorkspaceRow } from '../db/schema.js';
import type { AppConfig, VerificationCommand, VerificationCritic, BudgetGuardrail } from '../config.js';

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

/** A Workspace's effective Verification verifiers, each null when unconfigured. */
export type ResolvedVerifiers = {
  command: VerificationCommand | null;
  critic: VerificationCritic | null;
};

/**
 * Resolve a Workspace's effective Verification verifiers (issue #132, ADR-0021).
 * Each verifier is its own key: a Workspace's stored JSON overrides the global
 * default, `null` (or an unset column) inherits it — the same `workspace ?? global`
 * rule as every scalar override, applied per verifier. With nothing configured
 * (global default null and no Workspace override) both resolve to null: an empty
 * verifier set, so a Run behaves exactly as it does today. No verifier executes
 * here — this only resolves the config.
 */
export function resolveVerifiers(
  ws: Pick<WorkspaceRow, 'verificationCommand' | 'verificationCritic'>,
  config: Pick<AppConfig, 'verification'>,
): ResolvedVerifiers {
  return {
    command: resolve(parseVerifier<VerificationCommand>(ws.verificationCommand), config.verification.command),
    critic: resolve(parseVerifier<VerificationCritic>(ws.verificationCritic), config.verification.critic),
  };
}

/** Parse a stored verifier override column; an unset/empty column means inherit (null). */
function parseVerifier<T>(stored: string | null | undefined): T | null {
  return stored ? (JSON.parse(stored) as T) : null;
}

/** A Workspace's effective Guardrail config: the budget bounds and progress toggle. */
export type ResolvedGuardrails = {
  budget: BudgetGuardrail;
  progress: boolean;
};

/**
 * Resolve a Workspace's effective Guardrail config (issue #126, ADR-0019). Each
 * member is its own key: a Workspace's stored budget JSON or progress toggle
 * overrides the global default, `null` (or an unset column) inherits it — the
 * same `workspace ?? global` rule as every scalar override. This only resolves
 * config; nothing is enforced (#126). The Runner snapshots the result onto the
 * Run at start so a later config change can't retroactively change a trip.
 */
export function resolveGuardrails(
  ws: Pick<WorkspaceRow, 'guardrailBudget' | 'guardrailProgress'>,
  config: Pick<AppConfig, 'guardrails'>,
): ResolvedGuardrails {
  return {
    budget: resolve(parseGuardrailBudget(ws.guardrailBudget), config.guardrails.budget),
    progress: resolve(ws.guardrailProgress, config.guardrails.progress),
  };
}

/** Parse a stored budget override column; an unset/empty column means inherit (null). */
function parseGuardrailBudget(stored: string | null | undefined): BudgetGuardrail | null {
  return stored ? (JSON.parse(stored) as BudgetGuardrail) : null;
}
