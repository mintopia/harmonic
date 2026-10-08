import type { SettingKey } from './settings-registry.js';

export const PROMPT_TEMPLATE_IDS = [
  'taskPrompt',
  'drivePrompt',
  'unattendedReminder',
  'continuePrompt',
  'commitNudge',
  'pauseMessage',
  'mergeConflictPrompt',
  'epicConflictPrompt',
  'epicRefreshPrompt',
  'epicResolvePrompt',
  'epicResolveSuffix',
] as const;

export type PromptTemplateId = (typeof PROMPT_TEMPLATE_IDS)[number];

export interface PromptTemplateSpec {
  readonly label: string;
  readonly help: string;
  readonly config: readonly string[];
  readonly workspace: SettingKey | null;
}

export const PROMPT_TEMPLATES: Readonly<Record<PromptTemplateId, PromptTemplateSpec>> = {
  taskPrompt: {
    label: 'Task prompt',
    help: "Wraps a native Task's own prompt before it's sent to the agent. Placeholders are filled per Task; the default bare {prompt} sends the prompt verbatim. Mirrored tickets use the Drive prompt instead.",
    config: ['taskPrompt'],
    workspace: 'taskPrompt',
  },
  drivePrompt: {
    label: 'Drive prompt',
    help: 'The prompt Harmonic sends when it runs a mirrored ticket unattended. Placeholders are filled per Task.',
    config: ['drive', 'prompt'],
    workspace: 'drivePrompt',
  },
  unattendedReminder: {
    label: 'Unattended reminder',
    help: 'Appended to every auto-driven turn: the checkpoint reminder and the finish/escalate signals.',
    config: ['drive', 'unattendedReminder'],
    workspace: 'driveUnattendedReminder',
  },
  continuePrompt: {
    label: 'Continue prompt',
    help: 'The re-prompt nudge when a turn ends without finishing. The unattended reminder is appended after it.',
    config: ['drive', 'continuePrompt'],
    workspace: 'driveContinuePrompt',
  },
  commitNudge: {
    label: 'Commit nudge',
    help: 'Sent when an Attempt finishes its turn with uncommitted changes. No placeholders.',
    config: ['drive', 'commitNudge'],
    workspace: 'driveCommitNudge',
  },
  pauseMessage: {
    label: 'Pause message',
    help: 'Sent to a running Task when it is paused, asking the agent to finish its turn and wait.',
    config: ['pauseMessage'],
    workspace: 'pauseMessage',
  },
  mergeConflictPrompt: {
    label: 'Merge conflict resolver',
    help: 'Opens each turn of the agent that resolves a Task merge conflict.',
    config: ['merge', 'conflictPrompt'],
    workspace: 'mergeConflictPrompt',
  },
  epicConflictPrompt: {
    label: 'Epic merge conflict resolver',
    help: 'Opens each turn of the agent that resolves an Epic integration merge conflict.',
    config: ['merge', 'epicConflictPrompt'],
    workspace: 'mergeEpicConflictPrompt',
  },
  epicRefreshPrompt: {
    label: 'Epic refresh resolver',
    help: 'Sent to the agent that resolves a conflict when the Epic integration branch is refreshed from the default branch.',
    config: ['merge', 'epicRefreshPrompt'],
    workspace: 'mergeEpicRefreshPrompt',
  },
  epicResolvePrompt: {
    label: 'Epic resolve prompt',
    help: 'Sent to the agent that fixes a failing Epic verification. Global only: Workspaces cannot override it.',
    config: ['verify', 'epic', 'resolvePrompt'],
    workspace: null,
  },
  epicResolveSuffix: {
    label: 'Epic verification resolver suffix',
    help: 'Appended to the Epic resolve prompt when the agent fixes a failing Epic verification.',
    config: ['verify', 'epic', 'resolveSuffix'],
    workspace: 'verifyEpicResolveSuffix',
  },
};
