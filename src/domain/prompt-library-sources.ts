import { loadBaselineConfig, type AppConfig } from '../config.js';
import { PROMPT_FRAGMENTS, type PromptFragmentName } from './prompt-fragments.js';
import { PROMPT_TEMPLATES } from './prompt-templates.js';
import type { PromptLibrary } from './prompt-library-store.js';

export const ENGINE_APPENDED_FRAGMENTS = ['readOnlyRestraint', 'criticVerdictContract'] as const satisfies readonly PromptFragmentName[];

const LIBRARY_FRAGMENTS = [
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
] as const satisfies readonly PromptFragmentName[];

const LIBRARY_TEMPLATES = {
  mergeConflictPrompt: ['merge', 'conflictPrompt'],
  epicConflictPrompt: ['merge', 'epicConflictPrompt'],
  epicRefreshPrompt: ['merge', 'epicRefreshPrompt'],
} as const;

type LibraryTemplateId = keyof typeof LIBRARY_TEMPLATES;

type EngineFragments = Pick<AppConfig['promptFragments'], (typeof ENGINE_APPENDED_FRAGMENTS)[number]>;

let engineFragments: EngineFragments | undefined;

export const engineAppendedFragments = (): EngineFragments => {
  if (!engineFragments) {
    const { promptFragments } = loadBaselineConfig();
    engineFragments = { readOnlyRestraint: promptFragments.readOnlyRestraint, criticVerdictContract: promptFragments.criticVerdictContract };
  }
  return engineFragments;
};

export const withEngineFragments = (fragments: AppConfig['promptFragments']): AppConfig['promptFragments'] => ({ ...fragments, ...engineAppendedFragments() });

export const convertedCode = (code: string): string => `${code}-migrated`;

interface PromptSource {
  readonly code: string;
  readonly description: string;
  readonly read: (config: AppConfig) => string;
}

const SOURCES: readonly PromptSource[] = [
  ...LIBRARY_FRAGMENTS.map((name) => ({ code: name, description: PROMPT_FRAGMENTS[name].help, read: (c: AppConfig) => c.promptFragments[name] })),
  ...(Object.keys(LIBRARY_TEMPLATES) as LibraryTemplateId[]).map((id) => ({
    code: id,
    description: PROMPT_TEMPLATES[id].help,
    read: (c: AppConfig) => c.merge[LIBRARY_TEMPLATES[id][1]],
  })),
];

/** Turns each edited critic-review or merge-conflict prompt into an operator entry once; an entry that already exists marks the prompt as converted. */
export async function convertEditedPrompts(library: PromptLibrary, config: AppConfig): Promise<string[]> {
  const baseline = loadBaselineConfig();
  const converted: string[] = [];
  for (const source of SOURCES) {
    const text = source.read(config);
    if (text === source.read(baseline)) continue;
    const code = convertedCode(source.code);
    if (library.hasOperatorEntry(code)) continue;
    await library.create(code, source.description, text);
    converted.push(code);
  }
  return converted;
}

/** Carries a Settings-side edit of a covered prompt into its Library entry so the two never disagree; `only` limits it to the codes a request actually named. */
export async function syncEditedPrompts(library: PromptLibrary, config: AppConfig, only?: ReadonlySet<string>): Promise<void> {
  const baseline = loadBaselineConfig();
  for (const source of SOURCES) {
    if (only && !only.has(source.code)) continue;
    const text = source.read(config);
    const code = convertedCode(source.code);
    if (text === (library.operatorText(code) ?? source.read(baseline))) continue;
    if (library.hasOperatorEntry(code)) await library.update(code, source.description, text);
    else await library.create(code, source.description, text);
  }
}

export function changedPromptCodes(before: AppConfig, after: AppConfig): Set<string> {
  return new Set(SOURCES.filter((s) => s.read(before) !== s.read(after)).map((s) => s.code));
}

export function namedPromptCodes(patch: { promptFragments?: object | undefined; merge?: object | undefined }): Set<string> {
  const fragments = Object.keys(patch.promptFragments ?? {});
  const mergeKeys = new Set(Object.keys(patch.merge ?? {}));
  const templates = (Object.keys(LIBRARY_TEMPLATES) as LibraryTemplateId[]).filter((id) => mergeKeys.has(LIBRARY_TEMPLATES[id][1]));
  return new Set([...fragments, ...templates]);
}

/** The global config with the critic-review and merge-conflict prompts read from the Library: the converted entry when one exists, else the config's own text. */
export function withLibraryPrompts(config: AppConfig, library: PromptLibrary): AppConfig {
  const promptFragments = { ...config.promptFragments };
  for (const name of LIBRARY_FRAGMENTS) promptFragments[name] = library.operatorText(convertedCode(name)) ?? promptFragments[name];
  const merge = { ...config.merge };
  for (const id of Object.keys(LIBRARY_TEMPLATES) as LibraryTemplateId[]) {
    const key = LIBRARY_TEMPLATES[id][1];
    merge[key] = library.operatorText(convertedCode(id)) ?? merge[key];
  }
  return { ...config, promptFragments, merge };
}
