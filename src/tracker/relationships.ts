/** How a body names another ticket: `#<n>` (GitHub/GitLab, numeric) or a Jira key like `PROJ-12` (string). */
export type RefStyle = 'hash' | 'jira';

const JIRA_KEY = /\b([A-Z][A-Z0-9_]*-\d+)\b/g;

function refsIn(text: string, style: RefStyle): (number | string)[] {
  return style === 'jira'
    ? [...text.matchAll(JIRA_KEY)].map((m) => m[1]!)
    : [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

/**
 * GitHub's native `blockedBy` is empty unless the repo enabled the dependency preview and the edges were
 * filed in the UI, so also read the "Blocked by" / "Depends on" body convention. The scan stops before a
 * "Blocks" clause on the same line so reverse edges never leak into `blockedBy`.
 */
export function parseBlockedByLines(body: string): number[];
export function parseBlockedByLines(body: string, style: 'jira'): string[];
export function parseBlockedByLines(body: string, style: RefStyle = 'hash'): (number | string)[] {
  const out = new Set<number | string>();
  for (const line of body.split('\n')) {
    const m = /\b(?:blocked by|depends on)\b[:\s]*(.*)/i.exec(line);
    if (!m) continue;
    const clause = m[1]!.split(/\bblock(?:s|ing)\b/i)[0]!;
    for (const r of refsIn(clause, style)) out.add(r);
  }
  return [...out];
}

/** The `#<n>` of a `Part of [epic] #<n>` line, or null when the body names no parent. */
export function parsePartOfParent(body: string): number | null;
export function parsePartOfParent(body: string, style: 'jira'): string | null;
export function parsePartOfParent(body: string, style: RefStyle = 'hash'): number | string | null {
  if (style === 'jira') return refsIn(/^\s*Part of\b(.*)$/im.exec(body)?.[1] ?? '', style)[0] ?? null;
  const m = body.match(/^\s*Part of\b[^#\n]*#(\d+)/im);
  return m ? Number(m[1]) : null;
}

/** The `#<n>`s named in a `Blocked by` section: its heading/label line up to the blank line that ends the block. */
export function parseBlockedBySection(body: string): number[];
export function parseBlockedBySection(body: string, style: 'jira'): string[];
export function parseBlockedBySection(body: string, style: RefStyle = 'hash'): (number | string)[] {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^\s*(?:#{0,6}|h[1-6]\.)\s*Blocked by\b/i.test(l));
  if (start === -1) return [];
  const block: string[] = [];
  for (let i = start; i < lines.length && !(i > start && lines[i]!.trim() === ''); i++) block.push(lines[i]!);
  return [...new Set(refsIn(block.join('\n'), style))];
}

/** The numbers on a `**Blocked by:** 01, 02` field line; "None" or no field yields none. Numbers are feature-local. */
export function parseBlockedByField(raw: string): number[] {
  const line = raw.match(/^\s*\*\*Blocked by:\*\*\s*(.+?)\s*$/im)?.[1] ?? '';
  return /\bnone\b/i.test(line) ? [] : [...line.matchAll(/\d+/g)].map((m) => parseInt(m[0]!, 10));
}
