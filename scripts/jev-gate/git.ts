/**
 * Git plumbing for the gate: resolving the base ref, the merge-base, the
 * changed-file set, and a per-file diff. Everything reads the *working tree*
 * against the merge-base (not HEAD against the merge-base), so a verify-stage
 * run scores exactly what is currently on disk, uncommitted changes included
 * — the same choice the reference `jev_score.py --diff` makes.
 *
 * Per the repo's house rules (AGENTS.md, "Branching and rebasing"): never
 * default to `origin/main` — `main` is the stale release line. The default
 * base-ref search below only ever falls back to `develop` / its remote
 * tracking branch or the current branch's own upstream, never `main`.
 */
import { execFileSync } from 'node:child_process';

export class GitError extends Error {}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const detail = stderr ? stderr.toString() : (err as Error).message;
    throw new GitError(`git ${args.join(' ')} failed: ${detail.trim()}`);
  }
}

function refExists(ref: string, cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the BASE ref for diffing, in priority order:
 *   1. explicit (CLI --base)
 *   2. $JEV_GATE_BASE
 *   3. local `develop`
 *   4. `origin/develop`
 *   5. the current branch's own upstream (`@{u}`)
 * Never falls back to `origin/main` / `main` — see module doc.
 */
export function resolveBaseRef(explicit: string | undefined, cwd: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env['JEV_GATE_BASE'];
  if (fromEnv) return fromEnv;
  for (const candidate of ['develop', 'origin/develop', '@{u}']) {
    if (refExists(candidate, cwd)) return candidate;
  }
  throw new GitError(
    'could not determine a base ref: no --base given, $JEV_GATE_BASE unset, and neither "develop", ' +
      '"origin/develop", nor an upstream branch was found. Pass --base explicitly (e.g. the task/epic ' +
      'integration branch this attempt started from).',
  );
}

export function mergeBase(baseRef: string, cwd: string): string {
  return git(['merge-base', baseRef, 'HEAD'], cwd);
}

/** Changed (added/modified, never deleted — `--diff-filter=d`) paths, working tree vs `mergeBaseSha`. */
export function changedFiles(mergeBaseSha: string, cwd: string): string[] {
  const out = git(['diff', '--name-only', '--diff-filter=d', mergeBaseSha], cwd);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Every git-tracked path in the working tree — the candidate set for a whole-project baseline. */
export function trackedFiles(cwd: string): string[] {
  const out = git(['ls-files'], cwd);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export interface FileDiff {
  text: string;
  truncated: boolean;
}

/** The working-tree diff of one file against `mergeBaseSha`, capped to `charBudget` chars. */
export function fileDiff(mergeBaseSha: string, relPath: string, cwd: string, charBudget: number): FileDiff {
  const full = git(['diff', mergeBaseSha, '--', relPath], cwd);
  if (full.length <= charBudget) return { text: full, truncated: false };
  return { text: `${full.slice(0, charBudget)}\n... [diff truncated, ${full.length - charBudget} more chars]`, truncated: true };
}
