/**
 * GitHub's native `blockedBy` is empty unless the repo enabled the dependency preview and the edges were
 * filed in the UI, so also read the "Blocked by" / "Depends on" body convention. The scan stops before a
 * "Blocks" clause on the same line so reverse edges never leak into `blockedBy`.
 */
export function parseBlockedByLines(body: string): number[] {
  const out = new Set<number>();
  for (const line of body.split('\n')) {
    const m = /\b(?:blocked by|depends on)\b[:\s]*(.*)/i.exec(line);
    if (!m) continue;
    const clause = m[1]!.split(/\bblock(?:s|ing)\b/i)[0]!;
    for (const h of clause.matchAll(/#(\d+)/g)) out.add(Number(h[1]));
  }
  return [...out];
}

/** The `#<n>` of a `Part of [epic] #<n>` line, or null when the body names no parent. */
export function parsePartOfParent(body: string): number | null {
  const m = body.match(/^\s*Part of\b[^#\n]*#(\d+)/im);
  return m ? Number(m[1]) : null;
}

/** The `#<n>`s named in a `Blocked by` section: its heading/label line up to the blank line that ends the block. */
export function parseBlockedBySection(body: string): number[] {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^\s*#{0,6}\s*Blocked by\b/i.test(l));
  if (start === -1) return [];
  const block: string[] = [];
  for (let i = start; i < lines.length && !(i > start && lines[i]!.trim() === ''); i++) block.push(lines[i]!);
  return [...new Set([...block.join('\n').matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
}

/** The numbers on a `**Blocked by:** 01, 02` field line; "None" or no field yields none. Numbers are feature-local. */
export function parseBlockedByField(raw: string): number[] {
  const line = raw.match(/^\s*\*\*Blocked by:\*\*\s*(.+?)\s*$/im)?.[1] ?? '';
  return /\bnone\b/i.test(line) ? [] : [...line.matchAll(/\d+/g)].map((m) => parseInt(m[0]!, 10));
}
