import { createHash } from 'node:crypto';
import { Git } from './git.js';

/** A disposable checkout at an already-recorded branch head. */
export interface WorktreeProof<T> {
  before: string;
  after: string;
  mutated: boolean;
  result: T;
}

async function fingerprint(repoDir: string, worktreeDir: string): Promise<string> {
  const tree = await Git.writeWorkspaceTree(worktreeDir, 'HEAD');
  const refs = (await Git.forEachRef(repoDir))
    .split('\n')
    .filter((line) => !/ refs\/harmonic\//.test(line))
    .join('\n');
  return `${tree}|${createHash('sha256').update(refs).digest('hex')}`;
}

/** Check out a fixed commit, run a verifier, then remove the checkout. */
export async function withDetachedWorktree<T>(
  repoDir: string,
  oid: string,
  worktreePath: string,
  fn: (dir: string) => Promise<T>,
): Promise<WorktreeProof<T>> {
  await Git.addDetachedWorktree(repoDir, worktreePath, oid);
  try {
    const before = await fingerprint(repoDir, worktreePath);
    const result = await fn(worktreePath);
    const after = await fingerprint(repoDir, worktreePath);
    return { before, after, mutated: before !== after, result };
  } finally {
    await Git.removeWorktree(repoDir, worktreePath).catch(() => {});
  }
}
