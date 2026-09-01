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
      current = { path: '', status: 'M', additions: 0, deletions: 0, lines: [] };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      // Header lines precede the first hunk; a body `+++ `/`--- ` line can only
      // appear once inHunk, so header detection is safe from that ambiguity.
      if (line.startsWith('new file')) current.status = 'A';
      else if (line.startsWith('deleted file')) current.status = 'D';
      else if (line.startsWith('--- ')) {
        const p = line.slice(4);
        if (p !== '/dev/null' && current.path === '') current.path = p.replace(/^[ab]\//, '');
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') current.path = p.replace(/^[ab]\//, '');
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
    // `\ No newline at end of file` and blank trailing lines fall through, ignored.
  }
  return files;
}
