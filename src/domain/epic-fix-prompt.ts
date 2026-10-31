import type { AppConfig } from '../config.js';
import type { PromptLibrary } from './prompt-library-store.js';
import { retiredPromptTexts, type RetiredSettings } from './retired-settings.js';

export const EPIC_FIX_PART_CODES = ['epicResolvePrompt', 'epicResolveSuffix', 'epicFailingVerification'] as const;
export type EpicFixPartCode = (typeof EPIC_FIX_PART_CODES)[number];

type EpicFixConfig = Pick<AppConfig, 'verify'>;

const CONFIGURED: Record<EpicFixPartCode, (config: EpicFixConfig, retired: RetiredSettings) => string> = {
  epicResolvePrompt: (c) => c.verify.epic.resolvePrompt,
  epicResolveSuffix: (c) => c.verify.epic.resolveSuffix,
  epicFailingVerification: (_c, retired) => retiredPromptTexts(undefined, retired.global).epicFailingVerification,
};

export const editedPromptCode = (code: EpicFixPartCode): string => `${code}-edited`;

/** Copies each edited Epic fix part into an operator Library entry; a part whose entry already exists is left alone, so a second boot converts nothing. */
export async function convertEditedEpicFixPrompts(library: PromptLibrary, config: EpicFixConfig, retired: RetiredSettings): Promise<EpicFixPartCode[]> {
  const existing = new Set((await library.list()).map((entry) => entry.code));
  const converted: EpicFixPartCode[] = [];
  for (const code of EPIC_FIX_PART_CODES) {
    const edited = editedPromptCode(code);
    if (existing.has(edited)) continue;
    const bundled = await library.get(code);
    const configured = CONFIGURED[code](config, retired);
    if (configured === bundled.text) continue;
    await library.create(edited, `${bundled.description} (converted from the edited setting)`, configured);
    converted.push(code);
  }
  return converted;
}

export interface EpicFixTexts {
  readonly resolvePrompt: string;
  readonly resolveSuffix: string;
  readonly failingVerification: string;
}

/** The text of each Epic fix part: the converted entry when one exists, else the bundled entry, with includes expanded. */
export async function epicFixTexts(library: PromptLibrary): Promise<EpicFixTexts> {
  const names = new Set((await library.list()).map((entry) => entry.code));
  const text = async (code: EpicFixPartCode): Promise<string> => {
    const edited = editedPromptCode(code);
    return (await library.get(names.has(edited) ? edited : code)).resolved;
  };
  return {
    resolvePrompt: await text('epicResolvePrompt'),
    resolveSuffix: await text('epicResolveSuffix'),
    failingVerification: await text('epicFailingVerification'),
  };
}
