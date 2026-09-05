import type { WorkspaceRow } from '../db/schema.js';
import {
  type AppConfig,
  type VerificationCommand,
  type VerificationCritic,
  type VerificationReview,
  type BudgetGuardrail,
  type MergeFate,
} from '../config.js';
import { isOverridable, type SettingKey } from './settings-registry.js';

/**
 * The effective value of an overridable setting: the Workspace's own value when
 * set, otherwise the global default it inherits. `null`/`undefined` both mean
 * inherit.
 */
export function resolve<T>(workspaceVal: T | null | undefined, globalDefault: T): T {
  return workspaceVal ?? globalDefault;
}

/**
 * Resolve an overridable setting by its registry key. A `global-only` setting
 * ignores any per-Workspace value; an `overridable` setting resolves like
 * {@link resolve}.
 */
export function resolveScoped<T>(key: SettingKey, workspaceVal: T | null | undefined, globalDefault: T): T {
  return isOverridable(key) ? resolve(workspaceVal, globalDefault) : globalDefault;
}

/**
 * A Workspace's concurrency cap resolves like any override, then is clamped to
 * the Host Ceiling. Inherit (`null`) resolves straight to the ceiling.
 */
export function resolveCap(workspaceCap: number | null | undefined, hostCeiling: number): number {
  return Math.min(resolveScoped('maxConcurrentAttempts', workspaceCap, hostCeiling), hostCeiling);
}

/** A resolved review, carrying the raw toggle (`requested`) alongside runnability
 *  (`enabled`). `requested` without `enabled` is a review toggled on yet missing
 *  a resolved prompt or model, so it can never run. */
export type ResolvedReview = VerificationReview & { requested: boolean };

/** A Workspace's effective Verification verifiers, each null when unconfigured. */
export type ResolvedVerifiers = {
  commands: VerificationCommand[];
  review: ResolvedReview;
  command: VerificationCommand | null;
  critic: VerificationCritic | null;
};

/**
 * Resolve a Workspace's effective Verification verifiers. The command list
 * overrides at the list grain: `null` inherits the global list, an explicit
 * array overrides it whole (an empty array is off). Each review field
 * (`reviewEnabled`/`reviewPrompt`/`reviewModel`/`reviewHarness`) resolves
 * `workspace ?? global` on its own. Nothing executes here.
 */
export function resolveVerifiers(
  ws: Pick<WorkspaceRow, 'verificationCommand' | 'reviewEnabled' | 'reviewPrompt' | 'reviewModel' | 'reviewHarness'>,
  config: Pick<AppConfig, 'verify'>,
): ResolvedVerifiers {
  const commandStored = ws.verificationCommand == null ? null : (JSON.parse(ws.verificationCommand) as VerificationCommand[]);
  const commands = resolveScoped('verificationCommand', commandStored, config.verify.commands);
  const review = resolveReview(ws, config.verify.review);
  return {
    commands,
    review,
    command: commands[0] ?? null,
    critic: review.enabled && review.prompt && review.model ? { prompt: review.prompt, model: review.model, ...(review.harness ? { harness: review.harness } : {}) } : null,
  };
}

function resolveReview(
  ws: Pick<WorkspaceRow, 'reviewEnabled' | 'reviewPrompt' | 'reviewModel' | 'reviewHarness'>,
  globalDefault: VerificationReview,
): ResolvedReview {
  const requested = resolveScoped('reviewEnabled', ws.reviewEnabled, globalDefault.enabled);
  const prompt = resolveScoped('reviewPrompt', ws.reviewPrompt, globalDefault.prompt);
  const model = resolveScoped('reviewModel', ws.reviewModel, globalDefault.model);
  const harness = resolveScoped<VerificationReview['harness']>(
    'reviewHarness',
    ws.reviewHarness as VerificationReview['harness'],
    globalDefault.harness,
  );
  const enabled = Boolean(requested && prompt && model);
  return {
    enabled,
    requested,
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(harness ? { harness } : {}),
  };
}

/** A Workspace's effective Guardrail config: the budget bounds, progress toggle, and hard tool-timeout bound. */
export type ResolvedGuardrails = {
  budget: BudgetGuardrail;
  progress: boolean;
  toolTimeoutMinutes: number;
};

/** Resolve a Workspace's effective Guardrail config; each member resolves `workspace ?? global` on its own. Nothing is enforced here. */
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

function parseGuardrailBudget(stored: string | null | undefined): BudgetGuardrail | null {
  return stored ? (JSON.parse(stored) as BudgetGuardrail) : null;
}

/** A Workspace's effective auto-drive config: the five `drive.*` fields, each resolved `workspace ?? global`. */
export type ResolvedDrive = {
  prompt: string;
  unattendedReminder: string;
  continuePrompt: string;
  mergeFate: MergeFate;
  continueAttempts: number;
};

/** Resolve a Workspace's effective auto-drive config. A missing `ws` inherits every global default. */
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
    mergeFate: resolveScoped('driveMergeFate', ws?.driveMergeFate as MergeFate | null | undefined, config.drive.mergeFate),
    continueAttempts: resolveScoped('driveContinueAttempts', ws?.driveContinueAttempts, config.drive.continueAttempts),
  };
}

/**
 * Resolve a Workspace's effective Task Prompt: the template wrapping a native
 * Task's own prompt (`{prompt}` / `{id}` / `{workingDir}` / …). A missing `ws`
 * inherits the global default.
 */
export function resolveTaskPrompt(
  ws: Pick<WorkspaceRow, 'taskPrompt'> | null | undefined,
  config: Pick<AppConfig, 'taskPrompt'>,
): string {
  return resolveScoped('taskPrompt', ws?.taskPrompt, config.taskPrompt);
}
