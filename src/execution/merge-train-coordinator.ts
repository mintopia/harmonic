import { Git } from './git.js';
import { decideMergeTrainLand, type MergeTrainDecision, type MergeTrainGitFacts } from '../domain/merge-train.js';
import { EpicOperations } from './epic-operations.js';
import { parseIntegrationBranch } from './epic-integration.js';
import type { Operation } from '../telemetry/operations.js';

/**
 * The single-writer merge train per Epic integration branch (issue #160,
 * ADR-0024; freshness gate ADR-0041).
 *
 * Each ready Task member of an Epic lands onto the Epic's integration branch
 * (`epic/<ref>`, cut by #159) one at a time. Two members finishing "at the
 * same time" must not race the observe→land window against each other, so
 * this coordinator serialises land attempts **per integration branch** the
 * same way `LandingCoordinator`/`RunSettleCoordinator` serialise a single
 * Run's settle: a pure decision (`decideMergeTrainLand`,
 * `src/domain/merge-train.ts`) classifies observed git facts into an action,
 * and this class is purely the injected-effects shell around it — gather
 * facts, call the decision, execute the action. This is a different seam from
 * the per-op repo-lock (#121): `withRepoLock` spans exactly one git mutation
 * and imposes no ordering between callers beyond mutual exclusion during that
 * call, whereas this coordinator's lock spans a whole land attempt and gives
 * members on the *same* integration branch a strict FIFO order. Distinct
 * integration branches never share a lock key, so Epics land members fully
 * in parallel with each other — only same-branch members contend.
 *
 * The train never rebases. Rebasing is the Attempt's Rebase Task, run and
 * verified by the Runner before submission; inside the slot the train asserts
 * the member still sits at its verified tip AND that tip is based on the
 * current integration tip, then fast-forwards. A member that fails either
 * assertion is `stale`: the slot is released at once (no head-of-line
 * blocking) and the Runner re-enters Rebase → Verification on the same
 * Attempt before resubmitting.
 */

/** The slice of {@link Git} the coordinator needs — real Git in prod, a fake in tests. */
export interface MergeTrainGit {
  branchExists(dir: string, name: string): Promise<boolean>;
  revParse(dir: string, rev: string): Promise<string>;
  isAncestor(dir: string, baseRev: string, rev: string): Promise<boolean>;
  branchCheckedOutAt(dir: string, branch: string): Promise<string | null>;
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
  /** The branch tip verification recorded; the only object the train lands. */
  verifiedTip: string;
}

export type MergeTrainOutcome =
  | { status: 'landed'; oid: string }
  | { status: 'already-landed' }
  | { status: 'stale'; reason: string }
  | { status: 'escalated'; reason: string };

export class MergeTrainCoordinator {
  private readonly git: MergeTrainGit;
  private readonly escalateFn: (member: MergeTrainMember, reason: string) => Promise<void>;
  private readonly operations: EpicOperations;

  /** One promise chain per integration branch; the tail is the current holder
   * (mechanically identical to `repo-lock.ts`'s `chains` map). */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(deps: {
    /** Default = real {@link Git}. */
    git?: MergeTrainGit;
    /** Wired to `Runner.settleEscalatedForMember` (async: settling writes the
     * escalate fact + Run row through the async Db — ADR-0029 #203). */
    escalate: (member: MergeTrainMember, reason: string) => Promise<void>;
    operations?: EpicOperations;
  }) {
    this.git = deps.git ?? Git;
    this.escalateFn = deps.escalate;
    this.operations = deps.operations ?? new EpicOperations();
  }

  /** A member's land attempt at its verified tip. Resubmitted by the Runner
   * after a `stale` outcome once it has rebased and re-verified. */
  submit(member: MergeTrainMember): Promise<MergeTrainOutcome> {
    return this.withEpicOperation(member, (memberLand) =>
      this.withBranchTrain(member.integrationBranch, () => this.land(member, memberLand)),
    );
  }

  /**
   * Run another integration-branch mutation through the same FIFO as member
   * landings. Integration refreshes use this rather than a second lock: a
   * member can therefore never land against a branch while its refresh is
   * half applied.
   */
  runOnIntegrationBranch<T>(branch: string, work: () => Promise<T>): Promise<T> {
    return this.withBranchTrain(branch, work);
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
  private async land(member: MergeTrainMember, memberLand: Operation): Promise<MergeTrainOutcome> {
    const { repoDir, integrationBranch, memberBranch, verifiedTip } = member;

    const integrationExists = await this.git.branchExists(repoDir, integrationBranch);
    if (!integrationExists) {
      return this.execute(member, memberLand, decideMergeTrainLand({
        integrationExists: false, alreadyMerged: false, memberTip: verifiedTip, verifiedTip, basedOnIntegrationTip: false,
      }));
    }

    const integrationTip = await this.git.revParse(repoDir, integrationBranch);
    const memberTip = await this.git.revParse(repoDir, memberBranch);
    // `Git.isAncestor(dir, container, containee)` asks "is `containee` merged
    // into `container`?".
    const facts: MergeTrainGitFacts = {
      integrationExists: true,
      alreadyMerged: await this.git.isAncestor(repoDir, integrationTip, memberTip),
      memberTip,
      verifiedTip,
      basedOnIntegrationTip: await this.git.isAncestor(repoDir, memberTip, integrationTip),
    };
    return this.execute(member, memberLand, decideMergeTrainLand(facts), integrationTip);
  }

  /** Execute the pure decision's action against the injected git slice and
   * effect callbacks. `integrationTip` is the observed tip used as the CAS's
   * `expectedOld` — only defined (and only needed) on the `ff` action, which
   * only ever arises after the integration branch has been observed to exist. */
  private async execute(
    member: MergeTrainMember,
    memberLand: Operation,
    decision: MergeTrainDecision,
    integrationTip?: string,
  ): Promise<MergeTrainOutcome> {
    const { repoDir, integrationBranch } = member;

    switch (decision.action) {
      case 'ff': {
        return this.operations.run({
          repoDir: member.repoDir,
          epicRef: this.epicRef(member),
          type: 'git.fast-forward',
          parent: memberLand,
          attributes: { 'task.id': member.taskId, 'run.id': member.runId, 'git.operation': 'fast-forward' },
          work: async () => {
            const checkedOutAt = await this.git.branchCheckedOutAt(repoDir, integrationBranch);
            if (checkedOutAt !== null) {
              const reason = 'integration branch unexpectedly checked out';
              await this.escalateFn(member, reason);
              this.failEpic(member, reason);
              return { status: 'escalated', reason };
            }
            const cas = await this.git.casUpdateRef(repoDir, integrationBranch, decision.toOid, integrationTip!);
            if (!cas.ok) {
              const reason = cas.detail ?? 'integration branch advanced concurrently';
              await this.escalateFn(member, reason);
              this.failEpic(member, reason);
              return { status: 'escalated', reason };
            }
            return { status: 'landed', oid: decision.toOid };
          },
        });
      }
      case 'already-landed':
        return { status: 'already-landed' };
      case 'stale':
        return { status: 'stale', reason: decision.reason };
      case 'escalate':
        await this.escalateFn(member, decision.reason);
        this.failEpic(member, decision.reason);
        return { status: 'escalated', reason: decision.reason };
      default: {
        const exhaustive: never = decision;
        throw new Error(`unreachable merge-train decision: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private withEpicOperation(
    member: MergeTrainMember,
    work: (memberLand: Operation) => Promise<MergeTrainOutcome>,
  ): Promise<MergeTrainOutcome> {
    return this.operations.run({
      repoDir: member.repoDir,
      epicRef: this.epicRef(member),
      type: 'member-land',
      attributes: { 'task.id': member.taskId, 'run.id': member.runId, 'epic.integration_branch': member.integrationBranch },
      work: async (memberLand) => {
        try {
          return await work(memberLand);
        } catch (error) {
          this.failEpic(member, error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    });
  }

  private failEpic(member: MergeTrainMember, reason: string): void {
    this.operations.fail({ repoDir: member.repoDir, epicRef: this.epicRef(member), reason });
  }

  private epicRef(member: MergeTrainMember): number {
    const ref = parseIntegrationBranch(member.integrationBranch);
    if (ref === null) throw new Error(`merge train member has no Epic integration branch: ${member.integrationBranch}`);
    return ref;
  }
}
