import { mergeIntoBase, type MergeIntoBaseArgs, type MergeIntoBaseOutcome } from './branch-merge.js';
import { Git } from './git.js';
import { integrationBranchName } from './epic-integration.js';
import { withRepoLock } from './repo-lock.js';

/** A live integration branch that must follow one observed develop advance. */
export interface EpicRefreshTarget {
  ref: number;
  repoDir: string;
  defaultBranch: string;
}

export type EpicRefreshOutcome =
  | { status: 'refreshed'; oid: string }
  | { status: 'resolving'; detail: string }
  | { status: 'deferred'; reason: string }
  | { status: 'escalated'; reason: string };

export type EpicRefreshResolveDispatchOutcome =
  | { status: 'dispatched' }
  | { status: 'escalated'; reason: string };

/**
 * Merges a newly advanced default branch into live Epic integration branches.
 *
 * The merge runs under the base repo's {@link withRepoLock} mutex (ADR-0001), so
 * a refresh and a member's `runMergePolicy` merge onto the same repo serialize
 * on one lock. A merge conflict is allowed one agent turn; a second conflict
 * escalates the Epic, never one of its members. Per ADR-0046 a base that moved
 * under the refresh is normal: it is recorded and retried, never an operator hold.
 */
export class EpicRefreshCoordinator {
  private readonly resolving = new Set<number>();

  constructor(private readonly deps: {
    /** Default = real {@link Git}. */
    git?: { revParse(dir: string, rev: string): Promise<string> };
    merge?: (args: MergeIntoBaseArgs) => Promise<MergeIntoBaseOutcome>;
    dispatchResolve: (
      target: EpicRefreshTarget,
      detail: string,
    ) => Promise<EpicRefreshResolveDispatchOutcome>;
    escalate: (epicRef: number, reason: string) => void;
  }) {}

  refresh(target: EpicRefreshTarget): Promise<EpicRefreshOutcome> {
    const branch = integrationBranchName(target.ref);
    return withRepoLock(target.repoDir, async () => {
      const outcome = await (this.deps.merge ?? mergeIntoBase)({
        repoDir: target.repoDir,
        baseBranch: branch,
        branch: target.defaultBranch,
        expectedOid: await (this.deps.git ?? Git).revParse(target.repoDir, target.defaultBranch),
        mode: 'merge',
        mutexHeld: true,
      });
      if (outcome.ok) {
        this.resolving.delete(target.ref);
        return { status: 'refreshed', oid: outcome.oid };
      }
      if (outcome.reason === 'fallback-pr-manual' || outcome.reason === 'target-advanced') {
        return { status: 'deferred', reason: outcome.detail };
      }
      if (outcome.reason !== 'conflict') {
        const reason = `integration refresh failed: ${outcome.detail}`;
        this.resolving.delete(target.ref);
        this.deps.escalate(target.ref, reason);
        return { status: 'escalated', reason };
      }
      if (this.resolving.has(target.ref)) {
        const reason = `integration refresh still conflicts after corrective turn: ${outcome.detail}`;
        this.resolving.delete(target.ref);
        this.deps.escalate(target.ref, reason);
        return { status: 'escalated', reason };
      }
      const dispatch = await this.deps.dispatchResolve(target, outcome.detail);
      if (dispatch.status === 'escalated') return dispatch;
      this.resolving.add(target.ref);
      return { status: 'resolving', detail: outcome.detail };
    });
  }
}
