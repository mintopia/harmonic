import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from './git.js';

export interface EphemeralMergeWorktreeArgs {
  repoDir: string;
  baseTipOid: string;
  parentDir?: string;
  onRemoveError?: (args: { error: unknown; worktreeDir: string }) => void;
}

export async function withEphemeralMergeWorktree<T>(
  { repoDir, baseTipOid, parentDir, onRemoveError }: EphemeralMergeWorktreeArgs,
  run: (worktreeDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(join(parentDir ?? tmpdir(), 'harmonic-merge-'));
  const worktreeDir = join(tempDir, 'admin');
  try {
    await Git.addDetachedWorktree(repoDir, worktreeDir, baseTipOid);
    return await run(worktreeDir);
  } finally {
    try {
      await Git.removeWorktree(repoDir, worktreeDir);
    } catch (error) {
      try {
        onRemoveError?.({ error, worktreeDir });
      } catch {
        // Diagnostics must not mask the operation result or stop cleanup.
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}
