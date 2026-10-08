import type { WorkspaceRow } from '../db/schema.js';
import {
  type AppConfig,
  type VerificationCommand,
  type VerificationCommandOverlayEntry,
  type TaskVerificationCritic,
  type TaskVerificationCriticOverlayEntry,
  type TaskVerificationStage,
  type EpicVerificationCritic,
  type EpicVerificationCriticOverlayEntry,
  type EpicVerificationStage,
  type BudgetGuardrail,
  type MergeFate,
  type RoutingLabel,
  type RoutingLabelOverlayEntry,
} from '../config.js';
import { expandFragments } from '../execution/prompt-template.js';
import {
  PROMPT_FRAGMENT_NAMES,
  promptFragmentOverrideKey,
  type PromptFragmentOverrides,
  type PromptFragments,
} from './prompt-fragments.js';
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

/**
 * Merge an ordered overlay of `global`/`local` entries against the current
 * global list by id (ADR-0037). A `global` entry resolves against the live
 * global by id — dropped if that global no longer exists — and a `local`
 * entry inlines its own item; either kind is skipped when `enabled` is false.
 * Any global not *named* by any entry, enabled or disabled, is appended,
 * enabled, at the end, so a newly added global check reaches an
 * already-customised Workspace. `null` inherits every global, in global
 * order, enabled.
 */
function mergeOverlay<TItem, TEntry extends { kind: 'global' | 'local'; enabled: boolean }>(
  overlay: readonly TEntry[] | null,
  globals: readonly TItem[],
  idOf: (item: TItem) => string,
  ref: (entry: TEntry & { kind: 'global' }) => string,
  local: (entry: TEntry & { kind: 'local' }) => TItem,
): TItem[] {
  if (overlay == null) return [...globals];
  const globalById = new Map(globals.map((item) => [idOf(item), item] as const));
  const named = new Set<string>();
  const result: TItem[] = [];
  for (const entry of overlay) {
    if (entry.kind === 'global') {
      const id = ref(entry as TEntry & { kind: 'global' });
      named.add(id);
      if (!entry.enabled) continue;
      const item = globalById.get(id);
      if (item) result.push(item);
      continue;
    }
    if (!entry.enabled) continue;
    result.push(local(entry as TEntry & { kind: 'local' }));
  }
  for (const item of globals) if (!named.has(idOf(item))) result.push(item);
  return result;
}

/** {@link mergeOverlay}, but a `global-only` registry key ignores the Workspace overlay entirely. */
function resolveOverlay<TItem extends { id: string }, TEntry extends { kind: 'global' | 'local'; enabled: boolean }>(
  key: SettingKey,
  stored: string | null,
  globals: readonly TItem[],
  ref: (entry: TEntry & { kind: 'global' }) => string,
  local: (entry: TEntry & { kind: 'local' }) => TItem,
): TItem[] {
  if (!isOverridable(key)) return [...globals];
  const overlay = stored == null ? null : (JSON.parse(stored) as TEntry[]);
  return mergeOverlay(overlay, globals, (item) => item.id, ref, local);
}

/** Defined here, not in config.ts: the web bundle imports this module and config.ts pulls in node builtins. */
export function routingLabelRef(route: Pick<RoutingLabel, 'label'>): string {
  return route.label.trim().toLowerCase();
}

/** A Routing Label list problem at `index`; `duplicate-global` names the enabled Global label it repeats. */
export type RoutingLabelIssue =
  | { index: number; kind: 'blank' | 'duplicate' }
  | { index: number; kind: 'duplicate-global'; globalRef: string };

/** Blank and case-insensitively repeated labels in a flat (Global) list. */
export function routingLabelIssues(labels: readonly Pick<RoutingLabel, 'label'>[]): RoutingLabelIssue[] {
  const seen = new Set<string>();
  return labels.flatMap((route, index): RoutingLabelIssue[] => {
    const ref = routingLabelRef(route);
    if (ref === '') return [{ index, kind: 'blank' }];
    if (seen.has(ref)) return [{ index, kind: 'duplicate' }];
    seen.add(ref);
    return [];
  });
}

/**
 * Problems that make a Workspace overlay unsavable: an enabled local label may
 * not be blank, repeat an enabled Global label (a disabled Global frees its
 * label), or repeat an earlier enabled local one. Disabled locals are not checked.
 */
export function routingLabelOverlayIssues(
  overlay: readonly (
    | { kind: 'global'; ref: string; enabled: boolean }
    | { kind: 'local'; enabled: boolean; routingLabel: Pick<RoutingLabel, 'label'> }
  )[],
  globals: readonly Pick<RoutingLabel, 'label'>[],
): RoutingLabelIssue[] {
  const disabled = new Set(overlay.flatMap((e) => (e.kind === 'global' && !e.enabled ? [e.ref] : [])));
  const globalRefs = new Set(globals.map(routingLabelRef).filter((ref) => !disabled.has(ref)));
  const seen = new Set<string>();
  return overlay.flatMap((entry, index): RoutingLabelIssue[] => {
    if (entry.kind !== 'local' || !entry.enabled) return [];
    const ref = routingLabelRef(entry.routingLabel);
    if (ref === '') return [{ index, kind: 'blank' }];
    if (globalRefs.has(ref)) return [{ index, kind: 'duplicate-global', globalRef: ref }];
    if (seen.has(ref)) return [{ index, kind: 'duplicate' }];
    seen.add(ref);
    return [];
  });
}

/** Effective Routing Labels: null inherits all globals; a local shadowed by an enabled global is dropped (ADR-0049). */
export function resolveRoutingLabels(
  ws: Pick<WorkspaceRow, 'routingLabels'> | null | undefined,
  config: Pick<AppConfig, 'routingLabels'>,
): RoutingLabel[] {
  const stored = isOverridable('routingLabels') ? ws?.routingLabels : null;
  const overlay = stored == null ? null : (JSON.parse(stored) as RoutingLabelOverlayEntry[]);
  const merged = mergeOverlay<RoutingLabel, RoutingLabelOverlayEntry>(overlay, config.routingLabels, routingLabelRef, (e) => e.ref, (e) => e.routingLabel);
  if (overlay == null) return merged;
  const globals = new Set<RoutingLabel>(config.routingLabels);
  const enabledGlobalRefs = new Set(merged.filter((route) => globals.has(route)).map(routingLabelRef));
  return merged.filter((route) => globals.has(route) || !enabledGlobalRefs.has(routingLabelRef(route)));
}

function resolveTaskStage(
  commandsKey: SettingKey,
  commandsStored: string | null,
  criticsKey: SettingKey,
  criticsStored: string | null,
  globalDefault: TaskVerificationStage,
): TaskVerificationStage {
  return {
    commands: resolveOverlay<VerificationCommand, VerificationCommandOverlayEntry>(
      commandsKey, commandsStored, globalDefault.commands,
      (e) => e.ref, (e) => e.command,
    ),
    critics: resolveOverlay<TaskVerificationCritic, TaskVerificationCriticOverlayEntry>(
      criticsKey, criticsStored, globalDefault.critics,
      (e) => e.ref, (e) => e.critic,
    ),
  };
}

function resolveEpicStage(
  commandsKey: SettingKey,
  commandsStored: string | null,
  criticsKey: SettingKey,
  criticsStored: string | null,
  globalDefault: EpicVerificationStage,
): EpicVerificationStage {
  return {
    commands: resolveOverlay<VerificationCommand, VerificationCommandOverlayEntry>(
      commandsKey, commandsStored, globalDefault.commands,
      (e) => e.ref, (e) => e.command,
    ),
    critics: resolveOverlay<EpicVerificationCritic, EpicVerificationCriticOverlayEntry>(
      criticsKey, criticsStored, globalDefault.critics,
      (e) => e.ref, (e) => e.critic,
    ),
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

/** A Workspace's effective auto-drive config: the five `drive.*` fields, each resolved `workspace ?? global`; the prompt templates arrive with their `{fragment.<name>}` references expanded. */
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
    | (Partial<PromptFragmentOverrides> &
        Pick<
          WorkspaceRow,
          'drivePrompt' | 'driveUnattendedReminder' | 'driveContinuePrompt' | 'driveMergeFate' | 'driveContinueAttempts'
        >)
    | null
    | undefined,
  config: Pick<AppConfig, 'drive' | 'promptFragments'>,
): ResolvedDrive {
  const fragments = resolvePromptFragments(ws, config);
  return {
    prompt: expandFragments(resolveScoped('drivePrompt', ws?.drivePrompt, config.drive.prompt), fragments),
    unattendedReminder: expandFragments(resolveScoped('driveUnattendedReminder', ws?.driveUnattendedReminder, config.drive.unattendedReminder), fragments),
    continuePrompt: expandFragments(resolveScoped('driveContinuePrompt', ws?.driveContinuePrompt, config.drive.continuePrompt), fragments),
    mergeFate: resolveScoped('driveMergeFate', ws?.driveMergeFate as MergeFate | null | undefined, config.drive.mergeFate),
    continueAttempts: resolveScoped('driveContinueAttempts', ws?.driveContinueAttempts, config.drive.continueAttempts),
  };
}

/**
 * Resolve a Workspace's effective Task Prompt: the template wrapping a native
 * Task's own prompt (`{prompt}` / `{id}` / `{workingDir}` / …), with its
 * `{fragment.<name>}` references expanded. A missing `ws` inherits the global default.
 */
export function resolveTaskPrompt(
  ws: (Partial<PromptFragmentOverrides> & Pick<WorkspaceRow, 'taskPrompt'>) | null | undefined,
  config: Pick<AppConfig, 'taskPrompt' | 'promptFragments'>,
): string {
  return expandFragments(resolveScoped('taskPrompt', ws?.taskPrompt, config.taskPrompt), resolvePromptFragments(ws, config));
}

/** Resolve the message that asks an active Task to pause at its next turn boundary. */
export function resolvePauseMessage(
  ws: (Partial<PromptFragmentOverrides> & Pick<WorkspaceRow, 'pauseMessage'>) | null | undefined,
  config: Pick<AppConfig, 'pauseMessage' | 'promptFragments'>,
): string {
  return expandFragments(resolveScoped('pauseMessage', ws?.pauseMessage, config.pauseMessage), resolvePromptFragments(ws, config));
}

/** Resolve the nudge sent when an Attempt ends its turn with uncommitted changes. */
export function resolveCommitNudge(
  ws: (Partial<PromptFragmentOverrides> & Pick<WorkspaceRow, 'driveCommitNudge'>) | null | undefined,
  config: Pick<AppConfig, 'drive' | 'promptFragments'>,
): string {
  return expandFragments(resolveScoped('driveCommitNudge', ws?.driveCommitNudge, config.drive.commitNudge), resolvePromptFragments(ws, config));
}

/** Resolve the Prompt Fragments a Workspace's prompts reference, each `workspace ?? global`. */
export function resolvePromptFragments(
  ws: Partial<PromptFragmentOverrides> | null | undefined,
  config: Pick<AppConfig, 'promptFragments'>,
): AppConfig['promptFragments'] {
  return {
    ...config.promptFragments,
    ...(Object.fromEntries(
      PROMPT_FRAGMENT_NAMES.map((name) => {
        const key = promptFragmentOverrideKey(name);
        return [name, resolveScoped(key, ws?.[key], config.promptFragments[name])];
      }),
    ) as PromptFragments),
  };
}

/** Resolve the merge-conflict resolution prompts and their shared fragment for a Workspace, each `workspace ?? global`. */
export function resolveMergePrompts(
  ws: (Partial<PromptFragmentOverrides> & Pick<WorkspaceRow, 'mergeConflictPrompt' | 'mergeEpicConflictPrompt'>) | null | undefined,
  config: Pick<AppConfig, 'merge' | 'promptFragments'>,
): { conflictPrompt: string; epicConflictPrompt: string; fragments: AppConfig['promptFragments'] } {
  return {
    conflictPrompt: resolveScoped('mergeConflictPrompt', ws?.mergeConflictPrompt, config.merge.conflictPrompt),
    epicConflictPrompt: resolveScoped('mergeEpicConflictPrompt', ws?.mergeEpicConflictPrompt, config.merge.epicConflictPrompt),
    fragments: resolvePromptFragments(ws, config),
  };
}

/** Resolve the Epic resolver prompts (integration refresh, verification-failure suffix) and the fragments they reference for a Workspace, each `workspace ?? global`. */
export function resolveEpicResolverPrompts(
  ws: (Partial<PromptFragmentOverrides> & Pick<WorkspaceRow, 'mergeEpicRefreshPrompt' | 'verifyEpicResolveSuffix'>) | null | undefined,
  config: Pick<AppConfig, 'merge' | 'verify' | 'promptFragments'>,
): { refreshPrompt: string; resolveSuffix: string; fragments: AppConfig['promptFragments'] } {
  return {
    refreshPrompt: resolveScoped('mergeEpicRefreshPrompt', ws?.mergeEpicRefreshPrompt, config.merge.epicRefreshPrompt),
    resolveSuffix: resolveScoped('verifyEpicResolveSuffix', ws?.verifyEpicResolveSuffix, config.verify.epic.resolveSuffix),
    fragments: resolvePromptFragments(ws, config),
  };
}
