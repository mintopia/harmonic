import { PROMPT_CODE_PATTERN } from '../../src/domain/prompt-library.js';
import type { Prompt } from './types.js';

export function filterPrompts(prompts: readonly Prompt[], query: string): Prompt[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...prompts];
  return prompts.filter((p) => p.code.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
}

export function libraryCounts(prompts: readonly Prompt[]): { total: number; bundled: number; yours: number } {
  const bundled = prompts.filter((p) => p.bundled).length;
  return { total: prompts.length, bundled, yours: prompts.length - bundled };
}

export function countsLabel(prompts: readonly Prompt[]): string {
  const { total, bundled, yours } = libraryCounts(prompts);
  return `${total} ${total === 1 ? 'prompt' : 'prompts'} · ${bundled} Bundled · ${yours} yours`;
}

export function usedByLabel(prompt: Pick<Prompt, 'usedBy'>): string {
  const n = prompt.usedBy.length;
  return n === 0 ? 'Unused' : `${n} ${n === 1 ? 'prompt' : 'prompts'}`;
}

export function copyCode(code: string, prompts: readonly Prompt[]): string {
  const taken = new Set(prompts.map((p) => p.code));
  let next = `${code}-copy`;
  for (let n = 2; taken.has(next); n++) next = `${code}-copy-${n}`;
  return next;
}

export interface Position {
  line: number;
  column: number;
}

export function positionOf(text: string, index: number): Position {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  return { line, column: index - (before.lastIndexOf('\n') + 1) + 1 };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findInclude(text: string, code: string): (Position & { index: number; length: number }) | null {
  const m = new RegExp(`\\$\\{\\{\\s*prompts\\.${escapeRegExp(code)}\\s*\\}\\}`).exec(text);
  return m ? { ...positionOf(text, m.index), index: m.index, length: m[0].length } : null;
}

export type SaveIssue =
  | { kind: 'cycle'; field: 'text'; path: string[]; position: Position | null }
  | { kind: 'unknown'; field: 'text'; code: string; position: Position | null; suggestion: string | null }
  | { kind: 'malformed'; field: 'text'; position: Position }
  | { kind: 'code'; field: 'code'; message: string }
  | { kind: 'other'; field: 'form'; message: string };

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length] as number;
}

export function suggestCode(unknown: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Math.max(2, Math.floor(unknown.length / 3)) + 1;
  for (const code of known) {
    const d = editDistance(unknown.toLowerCase(), code.toLowerCase());
    if (d < bestDistance) {
      best = code;
      bestDistance = d;
    }
  }
  return best;
}

export function malformedReference(text: string): Position | null {
  const opens = [...text.matchAll(/\$\{\{/g)];
  for (const open of opens) {
    const start = open.index as number;
    const rest = text.slice(start + 3);
    const close = rest.indexOf('}}');
    const nextOpen = rest.indexOf('${{');
    if (close === -1 || (nextOpen !== -1 && nextOpen < close)) return positionOf(text, start);
  }
  return null;
}

export function validateCode(code: string, prompts: readonly Prompt[]): string | null {
  if (code.trim() === '') return 'Enter a code. Start with a letter; use letters, digits, hyphens or underscores.';
  if (!PROMPT_CODE_PATTERN.test(code)) return 'A code starts with a letter and holds letters, digits, - or _ (max 64).';
  const existing = prompts.find((p) => p.code === code);
  if (existing) return `A prompt with the code ${code} already exists${existing.bundled ? ' (Bundled)' : ''}. Choose another code.`;
  return null;
}

export function localIssues(draft: { text: string }): SaveIssue[] {
  const position = malformedReference(draft.text);
  return position ? [{ kind: 'malformed', field: 'text', position }] : [];
}

export function parseSaveError(message: string, text: string, knownCodes: readonly string[]): SaveIssue {
  const clean = message.replace(/\s*\(ref [^)]*\)\s*$/, '');
  const cycle = /^Include cycle: (.+)$/.exec(clean);
  if (cycle) {
    const path = (cycle[1] as string).split(' → ').map((s) => s.trim());
    const hop = path[1];
    const found = hop === undefined ? null : findInclude(text, hop);
    return { kind: 'cycle', field: 'text', path, position: found && { line: found.line, column: found.column } };
  }
  const unknown = /^Prompt includes unknown prompt codes?: (.+)$/.exec(clean);
  if (unknown) {
    const code = ((unknown[1] as string).split(',')[0] as string).trim();
    const found = findInclude(text, code);
    return {
      kind: 'unknown',
      field: 'text',
      code,
      position: found && { line: found.line, column: found.column },
      suggestion: suggestCode(code, knownCodes),
    };
  }
  if (/^A prompt with the code .+ already exists/.test(clean)) return { kind: 'code', field: 'code', message: `${clean}. Choose another code.` };
  return { kind: 'other', field: 'form', message: clean };
}

export function applySuggestion(text: string, code: string, suggestion: string): string {
  return text.replace(new RegExp(`(\\$\\{\\{\\s*prompts\\.)${escapeRegExp(code)}(\\s*\\}\\})`, 'g'), `$1${suggestion}$2`);
}

export type PreviewNode =
  | { kind: 'text'; value: string }
  | { kind: 'context'; value: string }
  | { kind: 'include'; code: string; depth: number; children: PreviewNode[] };

const TOKEN = /\$\{\{\s*([^\s}]+)\s*\}\}/g;

export function previewTree(text: string, lookup: ReadonlyMap<string, string>, seen: readonly string[] = []): PreviewNode[] {
  const nodes: PreviewNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const index = m.index as number;
    if (index > last) nodes.push({ kind: 'text', value: text.slice(last, index) });
    last = index + m[0].length;
    const ref = m[1] as string;
    const code = ref.startsWith('prompts.') ? ref.slice('prompts.'.length) : null;
    const body = code === null ? undefined : lookup.get(code);
    if (code !== null && body !== undefined && !seen.includes(code)) {
      nodes.push({ kind: 'include', code, depth: seen.length + 1, children: previewTree(body, lookup, [...seen, code]) });
    } else if (code === null) {
      nodes.push({ kind: 'context', value: ref });
    } else {
      nodes.push({ kind: 'text', value: m[0] });
    }
  }
  if (last < text.length) nodes.push({ kind: 'text', value: text.slice(last) });
  return nodes;
}

export type TextSegment = { kind: 'text' | 'include' | 'context'; value: string };

export function highlightLine(line: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const index = m.index as number;
    if (index > last) out.push({ kind: 'text', value: line.slice(last, index) });
    out.push({ kind: (m[1] as string).startsWith('prompts.') ? 'include' : 'context', value: m[0] });
    last = index + m[0].length;
  }
  if (last < line.length) out.push({ kind: 'text', value: line.slice(last) });
  return out;
}

export function includeLine(text: string, code: string): number | null {
  return findInclude(text, code)?.line ?? null;
}
