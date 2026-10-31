import { DomainError } from './errors.js';

export const PROMPT_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const INCLUDE = /\$\{\{\s*prompts\.([^\s}]+)\s*\}\}/g;

export interface PromptEntry {
  readonly code: string;
  readonly description: string;
  readonly text: string;
  readonly bundled: boolean;
  readonly updatedAt?: string | undefined;
}

export function includedCodes(text: string): string[] {
  return [...new Set([...text.matchAll(INCLUDE)].map((m) => m[1] as string))];
}

/** Refuses `candidate` when it includes an unknown code or closes an include cycle; `others` is every other entry. */
export function validateIncludes(candidate: Pick<PromptEntry, 'code' | 'text'>, others: ReadonlyMap<string, string>): void {
  const textOf = (code: string): string | undefined => (code === candidate.code ? candidate.text : others.get(code));
  const unknown = includedCodes(candidate.text).filter((code) => textOf(code) === undefined);
  if (unknown.length > 0) {
    throw new DomainError('validation', `Prompt includes unknown prompt code${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  }
  const visit = (code: string, path: string[]): void => {
    for (const next of includedCodes(textOf(code) ?? '')) {
      if (next === candidate.code) throw new DomainError('validation', `Include cycle: ${[...path, next].join(' → ')}`);
      if (!path.includes(next)) visit(next, [...path, next]);
    }
  };
  visit(candidate.code, [candidate.code]);
}

/** Expands every include, recursively. Callers validate first, so unknown codes and cycles are left as written rather than looped on. */
export function resolvePrompt(text: string, lookup: ReadonlyMap<string, string>, seen: readonly string[] = []): string {
  return text.replace(INCLUDE, (whole, code: string) => {
    const included = lookup.get(code);
    if (included === undefined || seen.includes(code)) return whole;
    return resolvePrompt(included, lookup, [...seen, code]);
  });
}

export function usedBy(code: string, entries: readonly PromptEntry[]): string[] {
  return entries.filter((e) => e.code !== code && includedCodes(e.text).includes(code)).map((e) => e.code);
}
