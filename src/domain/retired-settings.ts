// ADR-0055 retired keys; delete with the key-removal release.
import {
  BUNDLED_PROMPTS,
  BUNDLED_PROMPT_CODES,
  CRITIC_VERDICT_CONTRACT,
  READ_ONLY_RESTRAINT,
  convertedCode,
  editedCode,
  type BundledPromptCode,
} from './bundled-prompts.js';
import type { PromptLibrary } from './prompt-library-store.js';

export const RETIRED_GLOBAL_KEY = 'promptFragments';

export const RETIRED_CODES = [...BUNDLED_PROMPT_CODES, 'readOnlyRestraint', 'criticVerdictContract'] as const;
export type RetiredCode = (typeof RETIRED_CODES)[number];

export const retiredWorkspaceKey = (code: string): string => `promptFragment${code.charAt(0).toUpperCase()}${code.slice(1)}`;

/** Workspace prompt overrides removed with no runtime reader; kept on disk for rollback and read only by the settings-to-workflow migrations. */
export const RETIRED_WORKSPACE_PROMPT_KEYS = [
  'drivePrompt',
  'driveUnattendedReminder',
  'driveContinuePrompt',
  'taskPrompt',
  'driveCommitNudge',
  'mergeConflictPrompt',
  'verifyEpicResolveSuffix',
] as const;
export type RetiredWorkspacePromptKey = (typeof RETIRED_WORKSPACE_PROMPT_KEYS)[number];

export const RETIRED_WORKSPACE_KEYS: readonly string[] = [...RETIRED_CODES.map(retiredWorkspaceKey), ...RETIRED_WORKSPACE_PROMPT_KEYS];

export function retiredWorkspacePrompt(retired: RetiredSettings, workspaceId: number, key: RetiredWorkspacePromptKey): string | undefined {
  const value = retired.workspaces[String(workspaceId)]?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** The retired keys exactly as they sit on disk, kept verbatim so a rollback still finds them. */
export interface RetiredSettings {
  readonly global: Readonly<Record<string, unknown>>;
  readonly workspaces: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const NO_RETIRED: RetiredSettings = { global: {}, workspaces: {} };

export const FRAGMENT_REF = /\{fragment\.([^{}]+)\}/g;

export function translateRetiredText(text: string): string {
  return text.replace(FRAGMENT_REF, (_whole, name: string) => {
    if (name === 'readOnlyRestraint') return READ_ONLY_RESTRAINT;
    if (name === 'criticVerdictContract') return CRITIC_VERDICT_CONTRACT;
    return `\${{ prompts.${name} }}`;
  });
}

export function retiredBaseline(code: RetiredCode): string {
  if (code === 'readOnlyRestraint') return READ_ONLY_RESTRAINT;
  if (code === 'criticVerdictContract') return CRITIC_VERDICT_CONTRACT;
  const { text } = BUNDLED_PROMPTS[code];
  return code === 'criticRole' ? text.replace('{readOnlyRestraint}', '{fragment.readOnlyRestraint}') : text;
}

const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Every retired prompt's text for one scope: the Workspace override, else the global one, else the bundled default. */
export function retiredPromptTexts(workspace: Readonly<Record<string, unknown>> | undefined, global: Readonly<Record<string, unknown>>): Record<RetiredCode, string> {
  return Object.fromEntries(
    RETIRED_CODES.map((code) => [code, textOf(workspace?.[retiredWorkspaceKey(code)]) ?? textOf(global[code]) ?? retiredBaseline(code)]),
  ) as Record<RetiredCode, string>;
}

const CONVERTED_CODES: readonly BundledPromptCode[] = [
  'conflictResolution',
  'criticRevisionIdentical',
  'criticRevisionDiff',
  'criticRevisionAlone',
  'criticTicketFirst',
  'criticInstructionsFirst',
  'criticSpecTicket',
  'criticSpecInstructions',
  'criticWorkingTreeNote',
  'criticRole',
  'criticSecurity',
];

const EDITED_CODES: readonly BundledPromptCode[] = [
  'selfHeal',
  'operatorMessage',
  'peerMessages',
  'peerMessage',
  'peerLine',
  'rebaseConflict',
  'priorSession',
  'codeIndexGuidance',
  'peerLiveMessage',
  'routeClassifier',
];

/** The Library entry a retired prompt's edit is converted into. */
export function retiredEntryFor(code: string): string {
  return (CONVERTED_CODES as readonly string[]).includes(code) ? convertedCode(code) : editedCode(code);
}

/** Turns each edited retired prompt into an operator entry once; an entry that already exists marks the prompt as converted. */
export async function convertRetiredEditedPrompts(library: PromptLibrary, retired: RetiredSettings): Promise<string[]> {
  const texts = retiredPromptTexts(undefined, retired.global);
  const converted: string[] = [];
  for (const code of [...CONVERTED_CODES, ...EDITED_CODES]) {
    const entry = retiredEntryFor(code);
    if (texts[code] === retiredBaseline(code) || library.hasOperatorEntry(entry)) continue;
    await library.create(entry, BUNDLED_PROMPTS[code].description, texts[code]);
    converted.push(entry);
  }
  return converted;
}
