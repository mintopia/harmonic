import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  } catch (err: any) {
    // Conflict explanations land on stdout, other failures on stderr.
    const output = [err.stderr?.trim(), err.stdout?.trim()].filter(Boolean).join('\n');
    throw new GitError(`git ${args.join(' ')} failed: ${output || err.message}`, err.stderr ?? '');
  }
}

// Commits made by AgentDeck itself (snapshotting a run's work) carry a
// fixed identity so they work without operator git config.
const IDENTITY = ['-c', 'user.name=AgentDeck', '-c', 'user.email=agentdeck@localhost'];

export const Git = {
  currentBranch: (dir: string) => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),

  addWorktree: (dir: string, worktreePath: string, newBranch: string) =>
    git(dir, 'worktree', 'add', '-b', newBranch, worktreePath),

  removeWorktree: (dir: string, worktreePath: string) =>
    git(dir, 'worktree', 'remove', '--force', worktreePath),

  /** Snapshot everything in the worktree onto its branch; no-op when clean. */
  async commitAll(worktreePath: string, message: string): Promise<void> {
    await git(worktreePath, 'add', '-A');
    const status = await git(worktreePath, 'status', '--porcelain');
    if (status.length === 0) return;
    await git(worktreePath, ...IDENTITY, 'commit', '-m', message);
  },

  /**
   * Merge `branch` into `baseBranch` inside `dir` (ADR-0002). On conflict
   * the merge is aborted and { ok: false } returned with git's output.
   */
  async merge(dir: string, baseBranch: string, branch: string): Promise<{ ok: boolean; detail?: string }> {
    const current = await Git.currentBranch(dir);
    if (current !== baseBranch) await git(dir, 'checkout', baseBranch);
    try {
      await git(dir, ...IDENTITY, 'merge', '--no-edit', branch);
      return { ok: true };
    } catch (err) {
      const detail = err instanceof GitError ? err.message : String(err);
      try {
        await git(dir, 'merge', '--abort');
      } catch {
        // No merge in progress (e.g. the merge failed before starting).
      }
      return { ok: false, detail };
    }
  },

  /** Diffstat of what the run's branch adds over the merge base. */
  diffStat: (dir: string, baseBranch: string, branch: string) =>
    git(dir, 'diff', '--stat', `${baseBranch}...${branch}`),
};
