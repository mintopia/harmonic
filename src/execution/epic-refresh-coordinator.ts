import { mergeIntoBase, type MergeIntoBaseArgs, type MergeIntoBaseOutcome } from './branch-merge.js';
import { Git } from './git.js';
import { integrationBranchName } from './epic-integration.js';
import type { MergeTrainCoordinator, MergeTrainGit } from './merge-train-coordinator.js';

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
 * The queue belongs to MergeTrainCoordinator, so refreshes and member merges
 * share one FIFO per `epic/<ref>`. A merge conflict is allowed one agent turn;
 * a second conflict escalates the Epic, never one of its members.
 */
export class EpicRefreshCoordinator {
  private readonly resolving = new Set<number>();

  constructor(private readonly deps: {
    train: MergeTrainCoordinator;
    /** Default = real {@link Git}. */
    git?: Pick<MergeTrainGit, 'revParse'>;
    merge?: (args: MergeIntoBaseArgs) => Promise<MergeIntoBaseOutcome>;
    dispatchResolve: (
      target: EpicRefreshTarget,
      detail: string,
    ) => Promise<EpicRefreshResolveDispatchOutcome>;
    escalate: (epicRef: number, reason: string) => void;
  }) {}

  refresh(target: EpicRefreshTarget): Promise<EpicRefreshOutcome> {
    const branch = integrationBranchName(target.ref);
    return this.deps.train.runOnIntegrationBranch(branch, async () => {
      const outcome = await (this.deps.merge ?? mergeIntoBase)({
        repoDir: target.repoDir,
        baseBranch: branch,
        branch: target.defaultBranch,
        expectedOid: await (this.deps.git ?? Git).revParse(target.repoDir, target.defaultBranch),
        mode: 'merge',
        leaseHeld: true,
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
