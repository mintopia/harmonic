import { z } from 'zod';

const diffLineSchema = z.object({
  kind: z.enum(['add', 'del', 'context', 'hunk']),
  oldLn: z.number().nullable(),
  newLn: z.number().nullable(),
  text: z.string(),
});

export const diffFileSchema = z.object({
  path: z.string().meta({ example: 'src/server/rate-limit.ts' }),
  status: z.enum(['M', 'A', 'D']),
  additions: z.number().meta({ example: 96 }),
  deletions: z.number().meta({ example: 4 }),
  lines: z.array(diffLineSchema),
});

export type DiffFile = z.infer<typeof diffFileSchema>;

/** Decode git's C-style quoting (`"a\\tb"`, `"\\303\\251"`) used when core.quotePath applies. */
export function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p;
  const bytes: number[] = [];
  const esc: Record<string, number> = { t: 9, n: 10, r: 13, '"': 34, '\\': 92 };
  const body = Buffer.from(p.slice(1, -1), 'utf8');
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as number;
    if (c !== 92) {
      bytes.push(c);
      continue;
    }
    const next = String.fromCharCode(body[i + 1] as number);
    const oct = body.subarray(i + 1, i + 4).toString();
    if (/^[0-7]{3}$/.test(oct)) {
      bytes.push(parseInt(oct, 8));
      i += 3;
    } else {
      bytes.push(esc[next] ?? (body[i + 1] as number));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Post-image path of a `diff --git a/X b/Y` header; ambiguous renames/spaces resolve via later lines. */
function headerPath(header: string): string {
  const rest = header.slice('diff --git '.length);
  const quoted = /^"(?:[^"\\]|\\.)*" (".*")$/.exec(rest);
  if (quoted) return unquoteGitPath(quoted[1] as string).replace(/^b\//, '');
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ') return rest.slice(half + 3);
  const idx = rest.lastIndexOf(' b/');
  return idx >= 0 ? rest.slice(idx + 3) : '';
}

/**
 * Parse a `git diff` unified diff (the `base...branch` range whose diffstat
 * counts, so per-file additions/deletions here agree with the diffstat) into one
 * {@link DiffFile} per file. `oldLn`/`newLn` track the pre-/post-image line the
 * hunk header seeds; an added line has no old line and a deleted line no new one.
 */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let inHunk = false;
  let oldLn = 0;
  let newLn = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      current = { path: headerPath(line), status: 'M', additions: 0, deletions: 0, lines: [] };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      if (line.startsWith('rename to ')) current.path = unquoteGitPath(line.slice(10));
      else if (line.startsWith('new file')) current.status = 'A';
      else if (line.startsWith('deleted file')) current.status = 'D';
      else if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') current.path = unquoteGitPath(p.replace(/\t$/, '')).replace(/^b\//, '');
      }
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldLn = Number(hunk[1]);
      newLn = Number(hunk[2]);
      current.lines.push({ kind: 'hunk', oldLn: null, newLn: null, text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      current.additions++;
      current.lines.push({ kind: 'add', oldLn: null, newLn, text: line.slice(1) });
      newLn++;
    } else if (line.startsWith('-')) {
      current.deletions++;
      current.lines.push({ kind: 'del', oldLn, newLn: null, text: line.slice(1) });
      oldLn++;
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', oldLn, newLn, text: line.slice(1) });
      oldLn++;
      newLn++;
    }
  }
  return files;
}
