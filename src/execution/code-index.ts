import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function cliName(): string {
  return process.env.HARMONIC_CODE_INDEX_CLI || 'jcodemunch-mcp';
}

const INDEX_TIMEOUT_MS = 120_000;
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
 * id to hand the agent, or `null` when the CLI is absent or anything failed.
 * jCodeMunch keys a repo by path and resolves a bare `.` to the canonical
 * checkout, not this worktree, so the agent must query by this id.
 */
export async function indexWorktree(absPath: string): Promise<string | null> {
  if (!(await codeIndexAvailable())) return null;
  // jCodeMunch keys its index by source_root, so re-indexing a reused worktree
  // path serves the prior checkout's cached index unless it is dropped first.
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

/** Reap the index for the worktree at `absPath`, if one exists. A no-op when the path was never indexed. */
export async function dropIndexForPath(absPath: string): Promise<void> {
  const repoId = await repoIdForPath(absPath);
  if (repoId) await dropIndex(repoId);
}
