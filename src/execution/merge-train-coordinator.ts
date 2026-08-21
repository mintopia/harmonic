import { Git } from './git.js';
import { decideMergeTrainLand, type MergeTrainDecision, type MergeTrainGitFacts } from '../domain/merge-train.js';

/**
 * The single-writer merge train per Epic integration branch (issue #160).
 *
 * Each ready Task member of an Epic lands onto the Epic's integration branch
 * (`epic/<ref>`, cut by #159) one at a time: observe the branch's current
 * tip, rebase the member onto it, and fast-forward the branch to the
 * rebased result. Two members finishing "at the same time" must not race
 * that observe-rebase-land window against each other, so this coordinator
 * serialises land attempts **per integration branch** the same way
 * `LandingCoordinator`/`RunSettleCoordinator` serialise a single Run's
 * settle: a pure decision (`decideMergeTrainLand`, `src/domain/merge-train.ts`)
 * classifies observed git facts into an action, and this class is purely the
 * injected-effects shell around it — gather facts, call the decision, execute
 * the action. This is a different seam from the per-op repo-lock (#121):
 * `withRepoLock` spans exactly one git mutation and imposes no ordering
 * between callers beyond mutual exclusion during that call, whereas this
 * coordinator's lock spans a whole land attempt (rebase *and* CAS) and gives
 * members on the *same* integration branch a strict FIFO order. Distinct
 * integration branches never share a lock key, so Epics land members fully
 * in parallel with each other — only same-branch members contend.
 *
 * A rebase conflict gets exactly one bounded corrective turn (the #155
 * "no second mutating turn" contract, mirrored here via `healAttempted`):
 * the first conflict dispatches a heal and releases the branch's lock slot
 * immediately (the corrective turn itself runs out-of-band, dispatched but
 * not awaited to completion) so other ready members on the same branch are
 * never stalled behind one member's corrective turn. The member re-enters
 * the train via `onHealComplete` once that turn finishes; a second conflict
 * escalates rather than dispatching a second heal.
 *
 * Real-but-unwired: issue #161 wires `dispatchHeal` to `Runner.enqueueReMerge`,
 * `escalate` to `Runner.settleEscalated`, and the actual member-finish call
 * site that invokes `submit`.
 */

/** The slice of {@link Git} the coordinator needs — real Git in prod, a fake in tests. */
export interface MergeTrainGit {
  branchExists(dir: string, name: string): Promise<boolean>;
  revParse(dir: string, rev: string): Promise<string>;
  isAncestor(dir: string, baseRev: string, rev: string): Promise<boolean>;
  branchCheckedOutAt(dir: string, branch: string): Promise<string | null>;
  rebaseOnto(
    worktreeDir: string,
    ontoOid: string,
  ): Promise<{ ok: true; rebasedTip: string } | { ok: false; conflict: true; detail: string }>;
  casUpdateRef(dir: string, branch: string, newOid: string, expectedOld: string): Promise<{ ok: boolean; detail?: string }>;
}

/** A ready Task member attempting to land onto its Epic's integration branch. */
export interface MergeTrainMember {
  runId: number;
  taskId: number;
  /** Base repo owning `epic/<ref>`. */
  repoDir: string;
  /** e.g. `epic/42` — the chain key this member's land attempt serialises on. */
  integrationBranch: string;
  /** e.g. `harmonic/task-<id>-run-<n>`. */
  memberBranch: string;
  /** Where the rebase (and any corrective turn) happens. */
  memberWorktreeDir: string;
}

export type MergeTrainOutcome =
  | { status: 'landed'; oid: string }
  | { status: 'already-landed' }
  | { status: 'healing' }
  | { status: 'escalated'; reason: string };

export class MergeTrainCoordinator {
  private readonly git: MergeTrainGit;
  private readonly dispatchHeal: (member: MergeTrainMember) => Promise<void>;
  private readonly escalateFn: (member: MergeTrainMember, reason: string) => Promise<void>;

  /** Runs (by runId) that have already had their one bounded corrective turn
   * dispatched for their current conflict — the #155 "no second mutating
   * turn" bound. In-memory only (ADR-0024): no durable fact, no migration. */
  private readonly healAttempted = new Set<number>();

  /** One promise chain per integration branch; the tail is the current holder
   * (mechanically identical to `repo-lock.ts`'s `chains` map). */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(deps: {
    /** Default = real {@link Git}. */
    git?: MergeTrainGit;
    /** #161 wires this to `Runner.enqueueReMerge`. MUST resolve on *enqueue*,
     * not on the corrective turn's completion — the branch lock slot is held
     * across this await, so awaiting the whole turn would stall other ready
     * members on the same branch (the head-of-line blocking this design avoids). */
    dispatchHeal: (member: MergeTrainMember) => Promise<void>;
    /** #161 wires this to `Runner.settleEscalated` (async: settling writes the
     * escalate fact + Run row through the async Db — ADR-0029 #203). */
    escalate: (member: MergeTrainMember, reason: string) => Promise<void>;
  }) {
    this.git = deps.git ?? Git;
    this.dispatchHeal = deps.dispatchHeal;
    this.escalateFn = deps.escalate;
  }

  /** A member's first land attempt for its current position on the train. */
  submit(member: MergeTrainMember): Promise<MergeTrainOutcome> {
    return this.withBranchTrain(member.integrationBranch, () => this.land(member));
  }

  /** Re-entry after a dispatched corrective turn finishes — a second attempt
   * at the same land, subject to the same one-heal bound. */
  onHealComplete(member: MergeTrainMember): Promise<MergeTrainOutcome> {
    return this.withBranchTrain(member.integrationBranch, () => this.land(member));
  }

  /** Per-integration-branch serialisation, mechanically like `withRepoLock`:
   * chain prev -> gate -> tail, release in `finally`, delete the map entry
   * only when we're still the tail (a newer waiter leaves its own tail). */
  private async withBranchTrain<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.chains.set(key, tail);

    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === tail) this.chains.delete(key);
    }
  }

  /** The critical section: observe git facts, decide, execute. Runs inside
   * this member's integration branch's lock slot. */
  private async land(member: MergeTrainMember): Promise<MergeTrainOutcome> {
    const { repoDir, integrationBranch, memberBranch } = member;

    const integrationExists = await this.git.branchExists(repoDir, integrationBranch);
    if (!integrationExists) {
      return this.execute(member, this.decide(member, { integrationExists: false, alreadyMerged: false, rebase: null }));
    }

    const integrationTip = await this.git.revParse(repoDir, integrationBranch);
    const memberTip = await this.git.revParse(repoDir, memberBranch);
    // "alreadyMerged" means the member's commits are already folded into the
    // integration tip, i.e. memberTip is an ancestor-or-equal of integrationTip.
    // `Git.isAncestor(dir, baseBranch, branch)` asks "is `branch` merged into
    // `baseBranch`?" — so baseBranch is the container (integrationTip), branch
    // is the containee (memberTip).
    const alreadyMerged = await this.git.isAncestor(repoDir, integrationTip, memberTip);

    if (alreadyMerged) {
      return this.execute(
        member,
        this.decide(member, { integrationExists: true, alreadyMerged: true, rebase: null }),
        integrationTip,
      );
    }

    const rebaseResult = await this.git.rebaseOnto(member.memberWorktreeDir, integrationTip);
    const rebase: MergeTrainGitFacts['rebase'] = rebaseResult.ok
      ? { status: 'clean', rebasedTip: rebaseResult.rebasedTip }
      : { status: 'conflict', detail: rebaseResult.detail };

    return this.execute(
      member,
      this.decide(member, { integrationExists: true, alreadyMerged: false, rebase }),
      integrationTip,
    );
  }

  private decide(member: MergeTrainMember, facts: MergeTrainGitFacts): MergeTrainDecision {
    return decideMergeTrainLand({ facts, healAttempted: this.healAttempted.has(member.runId) });
  }

  /** Execute the pure decision's action against the injected git slice and
   * effect callbacks. `integrationTip` is the observed tip used as the CAS's
   * `expectedOld` — only defined (and only needed) on the `ff` action, which
   * only ever arises after the integration branch has been observed to exist. */
  private async execute(
    member: MergeTrainMember,
    decision: MergeTrainDecision,
    integrationTip?: string,
  ): Promise<MergeTrainOutcome> {
    const { repoDir, integrationBranch, runId } = member;

    switch (decision.action) {
      case 'ff': {
        const checkedOutAt = await this.git.branchCheckedOutAt(repoDir, integrationBranch);
        if (checkedOutAt !== null) {
          const reason = 'integration branch unexpectedly checked out';
          this.healAttempted.delete(runId);
          await this.escalateFn(member, reason);
          return { status: 'escalated', reason };
        }
        const cas = await this.git.casUpdateRef(repoDir, integrationBranch, decision.toOid, integrationTip!);
        if (!cas.ok) {
          const reason = cas.detail ?? 'integration branch advanced concurrently';
          this.healAttempted.delete(runId);
          await this.escalateFn(member, reason);
          return { status: 'escalated', reason };
        }
        this.healAttempted.delete(runId);
        return { status: 'landed', oid: decision.toOid };
      }
      case 'already-landed':
        this.healAttempted.delete(runId);
        return { status: 'already-landed' };
      case 'heal':
        this.healAttempted.add(runId);
        await this.dispatchHeal(member);
        return { status: 'healing' };
      case 'escalate':
        this.healAttempted.delete(runId);
        await this.escalateFn(member, decision.reason);
        return { status: 'escalated', reason: decision.reason };
      default: {
        const exhaustive: never = decision;
        throw new Error(`unreachable merge-train decision: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}
