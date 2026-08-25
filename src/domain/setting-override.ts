import type { WorkspaceRow } from '../db/schema.js';
import type { AppConfig, VerificationCommand, VerificationCritic, VerificationReview, BudgetGuardrail } from '../config.js';

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
  commands: VerificationCommand[];
  review: VerificationReview;
  /** Compatibility aliases during the Run-to-Attempt migration. */
  command: VerificationCommand | null;
  critic: VerificationCritic | null;
  /** Auto-accept (issue #138, ADR-0021): when true, a native Run whose
   * verifier(s) PASS lands without the human review gate. */
  autoAccept: boolean;
};

/**
 * Resolve a Workspace's effective Verification verifiers (issue #132, ADR-0021),
 * tri-state per verifier (issue #174). Each verifier is its own key: an unset
 * column inherits the global default, a stored verifier object overrides it, and
 * a stored `{ off: true }` sentinel forces the verifier off for this Workspace
 * regardless of the global default. With nothing configured (global default null
 * and no Workspace override) both resolve to null: an empty verifier set, so a
 * Run behaves exactly as it does today. No verifier executes here — this only
 * resolves the config.
 */
export function resolveVerifiers(
  ws: Pick<WorkspaceRow, 'verificationCommand' | 'verificationCritic' | 'verificationAutoAccept'>,
  config: { verify?: AppConfig['verify']; verification?: AppConfig['verification'] },
): ResolvedVerifiers {
  const verify = config.verify ?? legacyVerify(config as never);
  const commands = resolveCommands(ws.verificationCommand, verify.commands);
  const review = resolveReview(ws.verificationCritic, verify.review);
  return {
    commands,
    review,
    command: commands[0] ?? null,
    critic: review.enabled && review.prompt && review.model ? { prompt: review.prompt, model: review.model, ...(review.harness ? { harness: review.harness } : {}) } : null,
    autoAccept: ws.verificationAutoAccept ?? verify.autoAccept,
  };
}

/** Compatibility for in-memory callers and configs written before #312. */
function legacyVerify(config: { verification?: { command?: VerificationCommand | null; critic?: VerificationCritic | null; autoAccept?: boolean; maxSelfHeals?: number } }) {
  return {
    commands: config.verification?.command ? [config.verification.command] : [],
    review: config.verification?.critic ? { enabled: true, ...config.verification.critic } : { enabled: false },
    autoAccept: config.verification?.autoAccept ?? false,
    maxSelfHeals: config.verification?.maxSelfHeals ?? 1,
  };
}

/** True when a parsed verifier override column is the explicit off sentinel (issue #174). */
function isVerifierOff(v: unknown): boolean {
  return typeof v === 'object' && v !== null && (v as { off?: unknown }).off === true;
}

/**
 * Resolve a single verifier column, tri-state: an unset/empty column inherits
 * the global default, a stored `{ off: true }` sentinel resolves to null (off)
 * regardless of the global default, and any other stored object overrides it.
 */
function resolveCommands(stored: string | null | undefined, globalDefault: VerificationCommand[]): VerificationCommand[] {
  if (!stored) return globalDefault;
  const parsed = JSON.parse(stored) as unknown;
  if (isVerifierOff(parsed)) return [];
  return Array.isArray(parsed) ? parsed as VerificationCommand[] : [parsed as VerificationCommand];
}

function resolveReview(stored: string | null | undefined, globalDefault: VerificationReview): VerificationReview {
  if (!stored) return globalDefault;
  const parsed = JSON.parse(stored) as unknown;
  if (isVerifierOff(parsed)) return { enabled: false };
  if (typeof parsed === 'object' && parsed !== null && 'enabled' in parsed) return parsed as VerificationReview;
  return { enabled: true, ...(parsed as VerificationCritic) };
}

/** A Workspace's effective Guardrail config: the budget bounds, progress
 * toggle, and hard tool-timeout bound. */
export type ResolvedGuardrails = {
  budget: BudgetGuardrail;
  progress: boolean;
  toolTimeoutMinutes: number;
};

/**
 * Resolve a Workspace's effective Guardrail config (issue #126, ADR-0019). Each
 * member is its own key: a Workspace's stored budget JSON or progress toggle
 * overrides the global default, `null` (or an unset column) inherits it — the
 * same `workspace ?? global` rule as every scalar override. This only resolves
 * config; nothing is enforced (#126). The Runner snapshots the result onto the
 * Run at start so a later config change can't retroactively change a trip.
 *
 * `toolTimeoutMinutes` (issue #131) is global-only: there is no per-Workspace
 * override column for it, so it always resolves straight from `config`.
 */
export function resolveGuardrails(
  ws: Pick<WorkspaceRow, 'guardrailBudget' | 'guardrailProgress'>,
  config: Pick<AppConfig, 'guardrails'>,
): ResolvedGuardrails {
  return {
    budget: resolve(parseGuardrailBudget(ws.guardrailBudget), config.guardrails.budget),
    progress: resolve(ws.guardrailProgress, config.guardrails.progress),
    toolTimeoutMinutes: config.guardrails.toolTimeoutMinutes,
  };
}

/** Parse a stored budget override column; an unset/empty column means inherit (null). */
function parseGuardrailBudget(stored: string | null | undefined): BudgetGuardrail | null {
  return stored ? (JSON.parse(stored) as BudgetGuardrail) : null;
}
