import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Deterministic, Harmonic-driven integration with the jCodeMunch code-index CLI
 * (`jcodemunch-mcp`).
 *
 * WHY THIS EXISTS. A Harmonic agent (builder or verify critic) runs inside a git
 * worktree checked out at its candidate. When the harness navigates code through
 * a jCodeMunch MCP server, that server resolves a bare repo reference (`.`) — over
 * its SSE transport, against its own working directory — to the *canonical*
 * checkout (`working_dir`, parked on the default branch), NOT this worktree. The
 * agent then reads stale code that lacks the worktree's changes: a builder can't
 * see prior candidate work, and a critic reports "work not done" against a tree
 * that never contained the change. jCodeMunch keys a repo by path, so the fix is
 * to index THIS worktree as its own `local/<name>-<hash>` repo and hand the agent
 * that id to query instead of `.`.
 *
 * Harmonic holds no jCodeMunch client, but the CLI is present, so the Runner
 * drives the whole cycle deterministically: {@link indexWorktree} before the turn
 * (returning the id to inject via {@link codeIndexRepoGuidance}), and
 * {@link dropIndex} after, so ephemeral worktree indexes do not accumulate.
 *
 * Every function here is BEST-EFFORT: any failure (CLI absent, index error, parse
 * miss) resolves to a skip, never a throw — the agent then falls back to reading
 * files directly, exactly as before this integration existed.
 */

/** Overridable CLI name (read per call so it can be set at runtime / in tests); a
 * bare name is resolved on `PATH` by `execFile`. */
function cliName(): string {
  return process.env.HARMONIC_CODE_INDEX_CLI || 'jcodemunch-mcp';
}

/** Indexing a worktree (structural parse, no AI summaries) is a few seconds; this
 * ceiling only guards a hung child, which is SIGKILLed rather than left to linger
 * (issue #199 house rule). */
const INDEX_TIMEOUT_MS = 120_000;
/** A metadata read / cache drop is sub-second; keep the guard tight. */
const QUERY_TIMEOUT_MS = 30_000;

async function cli(args: string[], timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cliName(), args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    return stdout;
  } catch {
    // ENOENT (CLI absent) or a non-zero exit — both mean "skip", never fatal.
    return null;
  }
}

let availability: Promise<boolean> | undefined;

/** Whether the jCodeMunch CLI is usable, probed once per process and cached. */
export function codeIndexAvailable(): Promise<boolean> {
  return (availability ??= cli(['--version'], QUERY_TIMEOUT_MS).then((out) => out !== null));
}

/** Test-only: reset the cached availability probe. */
export function resetCodeIndexAvailabilityForTest(): void {
  availability = undefined;
}

interface RepoListRow {
  repo_id?: string;
  repo?: string;
  source_root?: string;
  git_root?: string;
}

/** Resolve the `local/<name>-<hash>` id jCodeMunch assigns to `absPath`, read back
 * from `list-repos` by matching the indexed source root. */
async function repoIdForPath(absPath: string): Promise<string | null> {
  const out = await cli(['list-repos', '--json'], QUERY_TIMEOUT_MS);
  if (out === null) return null;
  let rows: RepoListRow[];
  try {
    const parsed = JSON.parse(out) as { repos?: RepoListRow[] } | RepoListRow[];
    rows = Array.isArray(parsed) ? parsed : (parsed.repos ?? []);
  } catch {
    return null;
  }
  const want = resolve(absPath);
  for (const row of rows) {
    const root = row.source_root ?? row.git_root;
    if (root && resolve(root) === want) return row.repo_id ?? row.repo ?? null;
  }
  return null;
}

/**
 * Index the worktree at `absPath` as its own jCodeMunch repo and return the repo
 * id to hand the agent, or `null` when the CLI is absent or anything failed (the
 * caller then simply skips the injection). Structural-only (`--no-ai-summaries`):
 * the agent needs correct symbols from THIS tree, not prose, and skipping
 * summaries keeps the pre-turn step to a few seconds.
 */
export async function indexWorktree(absPath: string): Promise<string | null> {
  if (!(await codeIndexAvailable())) return null;
  // jCodeMunch keys its index by source_root, so re-indexing a REUSED worktree
  // path (e.g. `critic-<runId>`, reused across a Run's reviews) otherwise serves
  // the prior checkout's cached index and the critic reviews a stale tree. Drop
  // the path's index first to force a fresh parse of the current checkout.
  await dropIndexForPath(absPath);
  const indexed = await cli(['index', '--no-ai-summaries', absPath], INDEX_TIMEOUT_MS);
  if (indexed === null) return null;
  return repoIdForPath(absPath);
}

/** Best-effort reap of an ephemeral worktree index (CLI alias for
 * `invalidate_cache`). Safe to call with any id; a no-op when the CLI is absent. */
export async function dropIndex(repoId: string): Promise<void> {
  await cli(['delete-index', '--json', repoId], QUERY_TIMEOUT_MS);
}

/**
 * Reap the index for the worktree at `absPath`, if one exists. Used at worktree
 * teardown, where the caller knows the path but not the id. A no-op when the path
 * was never indexed (so it is safe to call on every worktree removal) — and it
 * can only match a `local/*` worktree index, never the canonical repo's, because
 * they have different source roots.
 */
export async function dropIndexForPath(absPath: string): Promise<void> {
  const repoId = await repoIdForPath(absPath);
  if (repoId) await dropIndex(repoId);
}
