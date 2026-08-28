/**
 * The one merge policy, everywhere (ADR-0001, "One merge policy, everywhere").
 * A self-contained, dependency-injected primitive: it knows nothing about
 * TaskService, the runner, config, or the DB — every variable behaviour
 * (resolving a conflict turn, running the post-merge check, escalating) is
 * injected by the caller. NOT wired into the completion loop yet.
 *
 * Precondition: the caller ensures `input.baseBranch` is the checked-out HEAD
 * of `input.baseDir` before calling {@link runMergePolicy}.
 */
import { Git } from './git.js';
import { withRepoLock } from './repo-lock.js';

export interface ConflictResolveContext {
  baseDir: string;
  baseBranch: string;
  taskBranch: string;
  unmergedPaths: string[];
  turn: number; // 1-based
}

export interface PostMergeCheckResult {
  pass: boolean;
  output: string; // failing command output to surface on escalation; empty when pass
}

export interface MergePolicyDeps {
  // Drive one bounded agentic resolve turn against the conflicted base checkout.
  // The turn edits files and `git add`s them in ctx.baseDir; the policy re-checks
  // for remaining conflicts and completes the merge commit itself.
  resolveConflictTurn: (ctx: ConflictResolveContext) => Promise<void>;
  // Run the deterministic verify commands once against the merged base tip.
  // Only invoked when input.postMergeCheck is true.
  runPostMergeCheck: (mergeOid: string, baseDir: string) => Promise<PostMergeCheckResult>;
  // Escalate the task with a composed plain-language reason (NEVER a raw git conflict dump).
  escalate: (reason: string) => Promise<void>;
}

export interface MergePolicyInput {
  baseDir: string; // base checkout: baseBranch is its HEAD; merge/revert happen here; its repo identity is the mutex key
  baseBranch: string;
  taskBranch: string;
  conflictResolveTurns: number; // bounded agentic resolve turns; 0 => escalate on first conflict
  postMergeCheck: boolean; // run the post-merge deterministic check under the mutex
}

export type MergePolicyOutcome =
  | { kind: 'merged'; mergeOid: string }
  | { kind: 'escalated'; reason: 'conflict' | 'post-merge-red'; message: string; revertOid?: string };

function conflictMessage(taskBranch: string, baseBranch: string, conflictResolveTurns: number): string {
  if (conflictResolveTurns === 0) {
    return `Merging ${taskBranch} into ${baseBranch} hit conflicts and automated resolution is disabled (0 resolve turns); a human needs to resolve them.`;
  }
  const turns = conflictResolveTurns === 1 ? '1 automated resolve turn' : `${conflictResolveTurns} automated resolve turns`;
  return `Merging ${taskBranch} into ${baseBranch} hit conflicts that ${turns} could not settle; a human needs to resolve them.`;
}

function postMergeRedMessage(taskBranch: string, baseBranch: string, output: string): string {
  return `The post-merge check on ${baseBranch} failed after merging ${taskBranch}; the merge was reverted so the base stays green.\n\nFailing output:\n${output}`;
}

// Aborts the in-progress merge under the lock and composes the escalation
// outcome, but does not deliver it — deps.escalate runs after the lock is
// released (ADR-0001).
async function escalateConflict(input: MergePolicyInput): Promise<MergePolicyOutcome> {
  await Git.abortMerge(input.baseDir);
  const message = conflictMessage(input.taskBranch, input.baseBranch, input.conflictResolveTurns);
  return { kind: 'escalated', reason: 'conflict', message };
}

/**
 * Bounded agentic resolve loop (ADR-0001 step 3): up to `conflictResolveTurns`
 * turns, each re-checking `Git.unmergedPaths` before and after so a turn that
 * resolves everything completes the merge itself without spending a turn it
 * didn't need. `conflictResolveTurns === 0` runs zero turns and escalates
 * immediately.
 */
async function resolveConflict(
  input: MergePolicyInput,
  deps: MergePolicyDeps,
): Promise<{ mergeOid: string } | { escalated: true }> {
  for (let turn = 1; turn <= input.conflictResolveTurns; turn++) {
    const unmerged = await Git.unmergedPaths(input.baseDir);
    if (unmerged.length === 0) break; // already resolved between turns

    await deps.resolveConflictTurn({
      baseDir: input.baseDir,
      baseBranch: input.baseBranch,
      taskBranch: input.taskBranch,
      unmergedPaths: unmerged,
      turn,
    });

    const stillUnmerged = await Git.unmergedPaths(input.baseDir);
    if (stillUnmerged.length === 0) {
      const done = await Git.completeMerge(input.baseDir);
      if (done.ok) return { mergeOid: done.mergeOid };
      break; // completeMerge failed unexpectedly; fall through to escalation
    }
  }
  return { escalated: true };
}

export async function runMergePolicy(input: MergePolicyInput, deps: MergePolicyDeps): Promise<MergePolicyOutcome> {
  const outcome = await withRepoLock(input.baseDir, async (): Promise<MergePolicyOutcome> => {
    const merge = await Git.mergeNoFf(input.baseDir, input.taskBranch);

    let mergeOid: string;
    if (merge.ok) {
      mergeOid = merge.mergeOid;
    } else if (merge.conflict) {
      const resolved = await resolveConflict(input, deps);
      if ('escalated' in resolved) return escalateConflict(input);
      mergeOid = resolved.mergeOid;
    } else {
      // A hard git fault, not a resolvable conflict — the primitive does not
      // escalate infra faults; the caller decides how to handle them.
      throw new Error(merge.detail);
    }

    if (input.postMergeCheck) {
      const check = await deps.runPostMergeCheck(mergeOid, input.baseDir);
      if (!check.pass) {
        const revertOid = await Git.revertMergeCommit(input.baseDir, mergeOid);
        const message = postMergeRedMessage(input.taskBranch, input.baseBranch, check.output);
        return { kind: 'escalated', reason: 'post-merge-red', message, revertOid };
      }
    }

    return { kind: 'merged', mergeOid };
  });

  // Escalation is delivered after the repo mutex is released (ADR-0001: "...
  // release the mutex, escalate ..."), so a slow/network-bound escalation
  // never holds up other merges waiting on this base repo.
  if (outcome.kind === 'escalated') {
    await deps.escalate(outcome.message);
  }
  return outcome;
}
