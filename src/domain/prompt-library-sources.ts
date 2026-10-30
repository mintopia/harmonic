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
