import { loadBaselineConfig, type AppConfig } from '../config.js';
import { convertedCode, editedCode } from './bundled-prompts.js';
import { PROMPT_TEMPLATES, type PromptTemplateId } from './prompt-templates.js';
import type { PromptLibrary } from './prompt-library-store.js';

const LIBRARY_TEMPLATES = {
  mergeConflictPrompt: ['merge', 'conflictPrompt'],
  epicConflictPrompt: ['merge', 'epicConflictPrompt'],
  epicRefreshPrompt: ['merge', 'epicRefreshPrompt'],
} as const;

type LibraryTemplateId = keyof typeof LIBRARY_TEMPLATES;

const EDITED_TEMPLATES = ['taskPrompt', 'drivePrompt', 'unattendedReminder', 'continuePrompt', 'commitNudge', 'pauseMessage'] as const satisfies readonly PromptTemplateId[];

interface PromptSource {
  readonly code: string;
  readonly entry: string;
  readonly description: string;
  readonly path: readonly string[];
}

const SOURCES: readonly PromptSource[] = [
  ...(Object.keys(LIBRARY_TEMPLATES) as LibraryTemplateId[]).map((id) => ({
    code: id,
    entry: convertedCode(id),
    description: PROMPT_TEMPLATES[id].help,
    path: LIBRARY_TEMPLATES[id] as readonly string[],
  })),
  ...EDITED_TEMPLATES.map((id) => ({ code: id, entry: editedCode(id), description: PROMPT_TEMPLATES[id].help, path: PROMPT_TEMPLATES[id].config })),
];

export const libraryEntryFor = (code: string): string | undefined => SOURCES.find((s) => s.code === code)?.entry;

const readPath = (root: unknown, path: readonly string[]): string => path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root) as string;

function withPathText(config: AppConfig, path: readonly string[], text: string): AppConfig {
  const [head, ...rest] = path as [keyof AppConfig, ...string[]];
  if (rest.length === 0) return { ...config, [head]: text };
  return { ...config, [head]: withPathText(config[head] as never, rest, text) };
}

/** Turns each edited covered prompt into an operator entry once; an entry that already exists marks the prompt as converted. */
export async function convertEditedPrompts(library: PromptLibrary, config: AppConfig): Promise<string[]> {
  const baseline = loadBaselineConfig();
  const converted: string[] = [];
  for (const source of SOURCES) {
    const text = readPath(config, source.path);
    if (text === readPath(baseline, source.path)) continue;
    if (library.hasOperatorEntry(source.entry)) continue;
    await library.create(source.entry, source.description, text);
    converted.push(source.entry);
  }
  return converted;
}

/** Carries a Settings-side edit of a covered prompt into its Library entry so the two never disagree; `only` limits it to the codes a request actually named. */
export async function syncEditedPrompts(library: PromptLibrary, config: AppConfig, only?: ReadonlySet<string>): Promise<void> {
  const baseline = loadBaselineConfig();
  for (const source of SOURCES) {
    if (only && !only.has(source.code)) continue;
    const text = readPath(config, source.path);
    if (text === (library.operatorText(source.entry) ?? readPath(baseline, source.path))) continue;
    if (library.hasOperatorEntry(source.entry)) await library.update(source.entry, source.description, text);
    else await library.create(source.entry, source.description, text);
  }
}

export function changedPromptCodes(before: AppConfig, after: AppConfig): Set<string> {
  return new Set(SOURCES.filter((s) => readPath(before, s.path) !== readPath(after, s.path)).map((s) => s.code));
}

const patchNamesPath = (patch: unknown, path: readonly string[]): boolean =>
  path.reduce<unknown>((node, key) => (node !== null && typeof node === 'object' && key in node ? (node as Record<string, unknown>)[key] : undefined), patch) !== undefined;

export function namedPromptCodes(patch: object): Set<string> {
  return new Set(SOURCES.filter((s) => patchNamesPath(patch, s.path)).map((s) => s.code));
}

/** The global config with the covered prompts read from the Library: the operator entry when one exists, else the config's own text. */
export function withLibraryPrompts(config: AppConfig, library: PromptLibrary): AppConfig {
  return SOURCES.reduce((acc, source) => {
    const text = library.operatorText(source.entry);
    return text === undefined ? acc : withPathText(acc, source.path, text);
  }, config);
}
