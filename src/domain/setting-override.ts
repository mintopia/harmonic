import type { WorkspaceRow } from '../db/schema.js';
import {
  type AppConfig,
  type VerificationCommand,
  type TaskVerificationCritic,
  type TaskVerificationStage,
  type EpicVerificationCritic,
  type EpicVerificationStage,
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

/** A Workspace's effective Verification verifiers, resolved at stage/list grain. */
export type ResolvedVerifiers = {
  task: { preMerge: TaskVerificationStage; postMerge: TaskVerificationStage };
  epic: { preMerge: EpicVerificationStage };
};

/**
 * Resolve a Workspace's effective Verification verifiers. Every stage/list
 * resolves independently: `null` inherits, an array replaces, and `[]` turns
 * just that verifier list off. Nothing executes here.
 */
export function resolveVerifiers(
  ws: Pick<WorkspaceRow, 'taskPreMergeCommands' | 'taskPreMergeCritics' | 'taskPostMergeCommands' | 'taskPostMergeCritics' | 'epicPreMergeCommands' | 'epicPreMergeCritics'>,
  config: Pick<AppConfig, 'verify'>,
): ResolvedVerifiers {
  return {
    task: {
      preMerge: resolveTaskStage('taskPreMergeCommands', ws.taskPreMergeCommands, 'taskPreMergeCritics', ws.taskPreMergeCritics, config.verify.task.preMerge),
      postMerge: resolveTaskStage('taskPostMergeCommands', ws.taskPostMergeCommands, 'taskPostMergeCritics', ws.taskPostMergeCritics, config.verify.task.postMerge),
    },
    epic: { preMerge: resolveEpicStage('epicPreMergeCommands', ws.epicPreMergeCommands, 'epicPreMergeCritics', ws.epicPreMergeCritics, config.verify.epic.preMerge) },
  };
}

function resolveTaskStage(
  commandsKey: SettingKey,
  commandsStored: string | null,
  criticsKey: SettingKey,
  criticsStored: string | null,
  globalDefault: TaskVerificationStage,
): TaskVerificationStage {
  const commands = commandsStored == null ? null : (JSON.parse(commandsStored) as VerificationCommand[]);
  const critics = criticsStored == null ? null : (JSON.parse(criticsStored) as TaskVerificationCritic[]);
  return {
    commands: resolveScoped(commandsKey, commands, globalDefault.commands),
    critics: resolveScoped(criticsKey, critics, globalDefault.critics),
  };
}

function resolveEpicStage(
  commandsKey: SettingKey,
  commandsStored: string | null,
  criticsKey: SettingKey,
  criticsStored: string | null,
  globalDefault: EpicVerificationStage,
): EpicVerificationStage {
  const commands = commandsStored == null ? null : (JSON.parse(commandsStored) as VerificationCommand[]);
  const critics = criticsStored == null ? null : (JSON.parse(criticsStored) as EpicVerificationCritic[]);
  return {
    commands: resolveScoped(commandsKey, commands, globalDefault.commands),
    critics: resolveScoped(criticsKey, critics, globalDefault.critics),
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

/** Resolve the message that asks an active Task to pause at its next turn boundary. */
export function resolvePauseMessage(
  ws: Pick<WorkspaceRow, 'pauseMessage'> | null | undefined,
  config: Pick<AppConfig, 'pauseMessage'>,
): string {
  return resolveScoped('pauseMessage', ws?.pauseMessage, config.pauseMessage);
}
