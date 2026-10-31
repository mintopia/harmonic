import { Git } from './git.js';
import { withEphemeralMergeWorktree } from './ephemeral-merge-worktree.js';
import { logger } from '../logger.js';

const MAX_PUSH_ATTEMPTS = 5;

export interface RemoteMergeInput {
  repoDir: string;
  remote: string;
  baseBranch: string;
  taskBranch: string;
}

export type RemoteMergeOutcome =
  | { kind: 'merged'; mergeOid: string }
  | { kind: 'escalated'; reason: 'conflict' | 'write-failed'; message: string };

export async function mergeRemoteTicketBranch(input: RemoteMergeInput): Promise<RemoteMergeOutcome> {
  const { repoDir, remote, baseBranch, taskBranch } = input;
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    const baseTip = await Git.fetchRemoteBranch(repoDir, remote, baseBranch);
    const taskTip = await Git.fetchRemoteBranch(repoDir, remote, taskBranch);

    const built = await withEphemeralMergeWorktree({ repoDir, baseTipOid: baseTip }, async (worktreeDir) => {
      const merge = await Git.mergeNoFf(worktreeDir, taskTip);
      if (merge.ok) return { mergeOid: merge.mergeOid };
      if (!merge.conflict) throw new Error(merge.detail);
      await Git.abortMerge(worktreeDir);
      return null;
    });
    if (built === null) {
      return {
        kind: 'escalated',
        reason: 'conflict',
        message: `Merging ${taskBranch} into ${baseBranch} hit conflicts; a human needs to resolve them.`,
      };
    }

    const pushed = await Git.pushToRemoteBranch(repoDir, remote, built.mergeOid, baseBranch);
    if (pushed.ok) return { kind: 'merged', mergeOid: built.mergeOid };
    if (!pushed.rejected) {
      return { kind: 'escalated', reason: 'write-failed', message: `Couldn't push ${baseBranch} to ${remote}: ${pushed.detail}` };
    }
    logger.warn('merge: remote base moved before the push; merging the latest base', {
      'merge.base_branch': baseBranch,
      'merge.attempt': attempt,
    });
  }
  return {
    kind: 'escalated',
    reason: 'write-failed',
    message: `${baseBranch} on ${remote} kept moving; gave up after ${MAX_PUSH_ATTEMPTS} push attempts.`,
  };
}
