import type { WorkspaceRow } from '../db/schema.js';
import {
  verificationReviewSchema,
  verificationCriticSchema,
  type AppConfig,
  type VerificationCommand,
  type VerificationCritic,
  type VerificationReview,
  type BudgetGuardrail,
  type MergeFate,
} from '../config.js';
import { isOverridable, type SettingKey } from './settings-registry.js';

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
 * Resolve an overridable setting by its registry key: the scoped resolver. The
 * settings registry (issue #336) is the single authority for scope, so a
 * `global-only` setting ignores any per-Workspace value and always resolves to
 * the global default — a Workspace can never override it. An `overridable`
 * setting resolves exactly like {@link resolve} (`workspace ?? global`).
 *
 * Every per-Workspace override path routes through here (or a specialised
 * resolver below that itself consults the registry) so overridability lives in
 * one place, not at each call site.
 */
export function resolveScoped<T>(key: SettingKey, workspaceVal: T | null | undefined, globalDefault: T): T {
  return isOverridable(key) ? resolve(workspaceVal, globalDefault) : globalDefault;
}

/**
 * A Workspace's concurrency cap resolves like any override, then is clamped to
 * the Machine Ceiling: a per-Workspace override can never breach the machine's
 * safety limit, so total concurrency across all Workspaces still cannot exceed
 * the ceiling (ADR-0012). Inherit (`null`) resolves straight to the ceiling.
 */
export function resolveCap(workspaceCap: number | null | undefined, machineCeiling: number): number {
  return Math.min(resolveScoped('maxConcurrentRuns', workspaceCap, machineCeiling), machineCeiling);
}

/** A Workspace's effective Verification verifiers, each null when unconfigured. */
export type ResolvedVerifiers = {
  commands: VerificationCommand[];
  review: VerificationReview;
  /** Compatibility aliases during the Run-to-Attempt migration. */
  command: VerificationCommand | null;
  critic: VerificationCritic | null;
};

/**
 * Resolve a Workspace's effective Verification verifiers (issue #132, ADR-0021).
 *
 * The **command list** overrides at the list grain (ADR-0044 §D, issue #338): an
 * unset column (`null`) inherits the global list, an explicit array overrides it
 * whole — a non-empty array is that ordered list, an empty array is *off* (run no
 * commands here). There is no per-command inheritance. It routes through
 * {@link resolveScoped}, so the registry decides overridability and the plain
 * `workspace ?? global` rule applies: only `null` inherits, an empty array is a
 * real override.
 *
 * The **critic** is still tri-state per issue #174: an unset column inherits, a
 * stored critic object overrides, and a stored `{ off: true }` sentinel forces it
 * off. With nothing configured anywhere, commands resolve to `[]` and the review
 * to disabled — an empty verifier set, so a Run behaves exactly as today. No
 * verifier executes here — this only resolves the config.
 */
export function resolveVerifiers(
  ws: Pick<WorkspaceRow, 'verificationCommand' | 'verificationCritic'>,
  config: Pick<AppConfig, 'verify'>,
): ResolvedVerifiers {
  // The command column stores the whole list as JSON (or null to inherit). Parse
  // then hand to resolveScoped, which applies the registry's scope and the
  // `workspace ?? global` rule — an empty array survives as a real override.
  const commandStored = ws.verificationCommand == null ? null : (JSON.parse(ws.verificationCommand) as VerificationCommand[]);
  const commands = resolveScoped('verificationCommand', commandStored, config.verify.commands);
  // The critic keeps its bespoke tri-state; route its column through the registry.
  const criticStored = isOverridable('verificationCritic') ? ws.verificationCritic : null;
  const review = resolveReview(criticStored, config.verify.review);
  return {
    commands,
    review,
    command: commands[0] ?? null,
    critic: review.enabled && review.prompt && review.model ? { prompt: review.prompt, model: review.model, ...(review.harness ? { harness: review.harness } : {}) } : null,
  };
}

/** True when a parsed critic override column is the explicit off sentinel (issue #174). */
function isVerifierOff(v: unknown): boolean {
  return typeof v === 'object' && v !== null && (v as { off?: unknown }).off === true;
}

function resolveReview(stored: string | null | undefined, globalDefault: VerificationReview): VerificationReview {
  if (!stored) return verificationReviewSchema.parse(globalDefault);
  const parsed = JSON.parse(stored) as unknown;
  if (isVerifierOff(parsed)) return { enabled: false };
  if (typeof parsed === 'object' && parsed !== null && 'enabled' in parsed) return verificationReviewSchema.parse(parsed);
  return { enabled: true, ...verificationCriticSchema.parse(parsed) };
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
 * member is its own key: a Workspace's stored budget JSON, progress toggle, or
 * tool-timeout bound overrides the global default, `null` (or an unset column)
 * inherits it — the same `workspace ?? global` rule as every scalar override.
 * This only resolves config; nothing is enforced (#126). The Runner snapshots
 * the result onto the Run at start so a later config change can't retroactively
 * change a trip.
 *
 * `toolTimeoutMinutes` (issue #131) moved from global-only into the overridable
 * set (ADR-0044): repos differ in tolerance for slow tools, so it now resolves
 * `workspace ?? global` through the registry like the other guardrail members.
 */
export function resolveGuardrails(
  ws: Pick<WorkspaceRow, 'guardrailBudget' | 'guardrailProgress' | 'toolTimeoutMinutes'>,
  config: Pick<AppConfig, 'guardrails'>,
): ResolvedGuardrails {
  return {
    budget: resolveScoped('guardrailBudget', parseGuardrailBudget(ws.guardrailBudget), config.guardrails.budget),
    progress: resolveScoped('guardrailProgress', ws.guardrailProgress, config.guardrails.progress),
    toolTimeoutMinutes: resolveScoped('toolTimeoutMinutes', ws.toolTimeoutMinutes, config.guardrails.toolTimeoutMinutes),
  };
}

/** Parse a stored budget override column; an unset/empty column means inherit (null). */
function parseGuardrailBudget(stored: string | null | undefined): BudgetGuardrail | null {
  return stored ? (JSON.parse(stored) as BudgetGuardrail) : null;
}

/** A Workspace's effective auto-drive config: the five independently-inheritable
 * `drive.*` fields, each resolved `workspace ?? global` (ADR-0044). */
export type ResolvedDrive = {
  prompt: string;
  unattendedReminder: string;
  continuePrompt: string;
  mergeFate: MergeFate;
  continueAttempts: number;
};

/**
 * Resolve a Workspace's effective auto-drive config (ADR-0044). The `drive.*`
 * block decomposes into five independently-inheritable scalars — each its own
 * registry key — so a Workspace can override, say, its Merge Fate while still
 * inheriting the global Drive Prompt. Every field routes through the scoped
 * resolver, so the registry stays the single authority for overridability. A
 * missing/undefined `ws` (no Workspace resolved) inherits every global default.
 */
export function resolveDrive(
  ws:
    | Pick<
        WorkspaceRow,
        'drivePrompt' | 'driveUnattendedReminder' | 'driveContinuePrompt' | 'driveMergeFate' | 'driveContinueAttempts'
      >
    | null
    | undefined,
  config: Pick<AppConfig, 'drive'>,
): ResolvedDrive {
  return {
    prompt: resolveScoped('drivePrompt', ws?.drivePrompt, config.drive.prompt),
    unattendedReminder: resolveScoped('driveUnattendedReminder', ws?.driveUnattendedReminder, config.drive.unattendedReminder),
    continuePrompt: resolveScoped('driveContinuePrompt', ws?.driveContinuePrompt, config.drive.continuePrompt),
    // The column is validated to a MergeFate on write (`z.enum(MERGE_FATES)`), so
    // the stored string is always a valid fate; cast past the raw `text` column type.
    mergeFate: resolveScoped('driveMergeFate', ws?.driveMergeFate as MergeFate | null | undefined, config.drive.mergeFate),
    continueAttempts: resolveScoped('driveContinueAttempts', ws?.driveContinueAttempts, config.drive.continueAttempts),
  };
}
