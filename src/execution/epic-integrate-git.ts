import { Git } from './git.js';
import { integrationBranchName } from './epic-integration.js';
import type { MergePolicyOutcome } from './merge-policy.js';
import { decideEpicIntegrate, type MemberMergeState } from '../domain/epic-integrate-decision.js';
import type { VerificationDecision } from '../verification/combine.js';
import { logger } from '../logger.js';
import { EpicOperations } from './epic-operations.js';

/** The slice of {@link Git} the coordinator needs — real Git in prod, a fake in tests. */
export interface EpicIntegrateGit {
  branchExists(dir: string, name: string): Promise<boolean>;
  revParse(dir: string, rev: string): Promise<string>;
  /** The default branch the integration branch integrates into, or `null` on a detached HEAD. */
  symbolicBranch(dir: string): Promise<string | null>;
  /** Whether `branch` is already merged into `baseBranch` (an ancestor of its tip). */
  isAncestor(dir: string, baseBranch: string, branch: string): Promise<boolean>;
  /** Whether merging `branch` into `baseBranch` adds no net content — the work is
   * already integrated even when a squash/rebase rewrote its commits so the tip is
   * not a literal ancestor. Heavier than {@link isAncestor} (a real 3-way merge). */
  isContentContained(dir: string, baseBranch: string, branch: string): Promise<boolean>;
}

/** Run a whole-Epic Verification against the integration branch's tip OID and
 * fold the verifiers' verdicts into a single decision. */
export type EpicVerify = (args: { repoDir: string; verifiedHeadOid: string }) => Promise<VerificationDecision>;

/** Merge the Epic's integration branch into the default branch under the one
 * merge policy: `git merge --no-ff` under the base repo mutex, bounded agentic
 * resolve turns, the deterministic post-merge check, and `git revert -m 1` on red.
 * A moved base is reconciled by the merge commit and never detected, so the
 * outcome is only `merged` or `escalated` (conflict / red post-merge check). */
export type EpicIntegrate = (args: {
  repoDir: string;
  epicRef: number;
  defaultBranch: string;
  integrationBranch: string;
}) => Promise<MergePolicyOutcome>;

/** The retained whole-Epic Verification status for the operator read model:
 * `pending` while a verify is in flight, `pass`/`fail` for the last completed
 * attempt's verdict, `null` when none has run for the current integration branch.
 * In-memory only. */
export type EpicVerificationStatus = 'pass' | 'fail' | 'pending' | null;

/** An Epic offered for a integrate attempt, reduced from the poll's derived Epic and
 * its members' mirrored Task states. */
export interface EpicIntegrateTarget {
  ref: number;
  /** Each member's reduced merge state. An empty array is only safe under an
   * operator force-integrate (which bypasses the per-member gate); a non-force
   * submit with `[]` decides `noop` and never integrates. */
  members: MemberMergeState[];
  /** The Epic's member refs, snapshotted onto the stored Epic record at integration.
   * Absent ⇒ an empty snapshot. */
  memberRefs?: number[];
}

/** Persist a completed Epic integration onto its stored record: the merge-commit
 * hash (null for a no-op finish where the branch already matched base) and the
 * member-ref snapshot. */
export type EpicRecordIntegration = (input: {
  epicRef: number;
  mergeCommit: string | null;
  memberRefs: number[];
}) => Promise<void>;

export type EpicIntegrateOutcome =
  | { status: 'integrated'; oid: string }
  | { status: 'blocked'; reason: string }
  | { status: 'waiting'; reason: string }
  | { status: 'escalated'; reason: string }
  | { status: 'noop'; reason: string }
  /** A integrate attempt for this Epic is already in flight; the caller re-submits next poll. */
  | { status: 'busy' };

export class EpicIntegrateCoordinator {
  private readonly repoDir: string;
  private readonly git: EpicIntegrateGit;
  private readonly verify: EpicVerify;
  private readonly integrate: EpicIntegrate;
  private readonly retire: (epicRef: number) => Promise<void>;
  private readonly escalateFn: (epicRef: number, reason: string) => void;
  private readonly onError: (msg: string) => void;
  private readonly operations: EpicOperations;
  private readonly recordIntegrationFn: EpicRecordIntegration | undefined;

  private readonly inFlight = new Set<number>();

  private readonly settledEscalated = new Map<number, string>();

  private readonly lastVerification = new Map<number, Exclude<EpicVerificationStatus, null>>();

  private readonly lastVerifyAttemptAt = new Map<number, number>();

  private readonly now: () => number;
  private readonly verifyBackoffMs: number;

  constructor(deps: {
    /** The base repo owning `epic/<ref>` — the Workspace's working directory. */
    repoDir: string;
    git?: EpicIntegrateGit;
    /** Whole-Epic Verification against the integration tip. */
    verify: EpicVerify;
    /** Merge the integration branch into the default branch under the one merge policy. */
    integrate: EpicIntegrate;
    /** Retire the integration branch after a successful integrate. */
    retire: (epicRef: number) => Promise<void>;
    /** Epic-level escalation surface (verify fail/inconclusive or integrate failure). */
    escalate: (epicRef: number, reason: string) => void;
    /** Injected clock for the hard backoff; default `Date.now`. */
    now?: () => number;
    /** Minimum gap between whole-Epic verify+integrate attempts per Epic; default 60s. */
    verifyBackoffMs?: number;
    onError?: (msg: string) => void;
    operations?: EpicOperations;
    /** Persist the integration snapshot onto the stored Epic record; absent ⇒ nothing is recorded. */
    recordIntegration?: EpicRecordIntegration;
  }) {
    this.repoDir = deps.repoDir;
    this.git = deps.git ?? Git;
    this.verify = deps.verify;
    this.integrate = deps.integrate;
    this.retire = deps.retire;
    this.escalateFn = deps.escalate;
    this.now = deps.now ?? (() => Date.now());
    this.verifyBackoffMs = deps.verifyBackoffMs ?? 60_000;
    this.onError = deps.onError ?? logger.error;
    this.operations = deps.operations ?? new EpicOperations();
    this.recordIntegrationFn = deps.recordIntegration;
  }

  /**
   * Attempt a whole-Epic integrate for `target`. `force` is the operator's explicit
   * force-integrate-the-ready-subset override — set only by the operator action,
   * never by the automatic poll trigger. Idempotent and re-entrancy-safe: an
   * in-flight attempt for the same Epic returns `busy`.
   */
  async submit(target: EpicIntegrateTarget, opts?: { force?: boolean }): Promise<EpicIntegrateOutcome> {
    const force = opts?.force ?? false;
    if (this.inFlight.has(target.ref)) return { status: 'busy' };
    this.inFlight.add(target.ref);
    try {
      const existing = this.operations.has({ repoDir: this.repoDir, epicRef: target.ref });
      if (!existing && !(await this.git.branchExists(this.repoDir, integrationBranchName(target.ref)))) {
        return await this.attempt(target, force);
      }
      return await this.operations.run({
        repoDir: this.repoDir,
        epicRef: target.ref,
        type: 'integrate',
        attributes: { 'epic.integration_branch': integrationBranchName(target.ref) },
        work: () => this.attempt(target, force),
      });
    } finally {
      this.inFlight.delete(target.ref);
    }
  }

  private async attempt(target: EpicIntegrateTarget, force: boolean): Promise<EpicIntegrateOutcome> {
    const branch = integrationBranchName(target.ref);
    const integrationExists = await this.git.branchExists(this.repoDir, branch);
    if (!integrationExists) {
      this.forget(target.ref);
    }

    const gate = decideEpicIntegrate({ integrationExists, members: target.members, verification: null, force });
    switch (gate.action) {
      case 'noop':
        this.operations.complete({ repoDir: this.repoDir, epicRef: target.ref });
        return { status: 'noop', reason: gate.reason };
      case 'wait':
        return { status: 'waiting', reason: gate.reason };
      case 'blocked':
        this.operations.fail({ repoDir: this.repoDir, epicRef: target.ref, reason: gate.reason });
        return { status: 'blocked', reason: gate.reason };
      case 'verify':
        break;
      default:
        return { status: 'noop', reason: gate.reason };
    }

    const defaultBranch = await this.git.symbolicBranch(this.repoDir);
    if (defaultBranch === null) {
      return { status: 'waiting', reason: 'default branch is detached; deferring the integrate' };
    }

    if (await this.git.isAncestor(this.repoDir, defaultBranch, branch)) {
      return await this.retireContained(target, branch);
    }

    if (!force && this.settledEscalated.get(target.ref) === this.signatureOf(target.members)) {
      return { status: 'escalated', reason: 'already escalated for this member state; awaiting operator or a state change' };
    }

    if (!force) {
      const at = this.now();
      const last = this.lastVerifyAttemptAt.get(target.ref);
      if (last !== undefined && at - last < this.verifyBackoffMs) {
        return { status: 'waiting', reason: 'whole-Epic verify+integrate backoff active; deferring this poll' };
      }
      this.lastVerifyAttemptAt.set(target.ref, at);
    }

    if (await this.git.isContentContained(this.repoDir, defaultBranch, branch)) {
      return await this.retireContained(target, branch);
    }

    const verifiedHeadOid = await this.git.revParse(this.repoDir, branch);
    this.lastVerification.set(target.ref, 'pending');
    let verification: VerificationDecision;
    try {
      verification = await this.operations.run({
        repoDir: this.repoDir,
        epicRef: target.ref,
        type: 'verify',
        attributes: { 'git.verified_head_oid': verifiedHeadOid },
        work: () => this.verify({ repoDir: this.repoDir, verifiedHeadOid }),
      });
    } catch (err) {
      this.lastVerification.set(target.ref, 'fail');
      return this.escalate(target, force, `whole-Epic verification could not run: ${err instanceof Error ? err.message : String(err)}`);
    }

    const verdict = decideEpicIntegrate({ integrationExists: true, members: target.members, verification, force });
    if (verdict.action === 'escalate') {
      this.lastVerification.set(target.ref, 'fail');
      return this.escalate(target, force, verdict.reason);
    }
    if (verdict.action !== 'integrate') {
      this.onError(`epic ${target.ref} unexpected post-verification decision: ${verdict.action}`);
      return { status: 'noop', reason: `unexpected post-verification decision: ${verdict.action}` };
    }

    this.lastVerification.set(target.ref, 'pass');

    const integrated = await this.operations.run({
      repoDir: this.repoDir,
      epicRef: target.ref,
      type: 'merge',
      attributes: { 'git.base_branch': defaultBranch, 'git.branch': branch },
      work: () => this.integrate({ repoDir: this.repoDir, epicRef: target.ref, defaultBranch, integrationBranch: branch }),
    });
    if (integrated.kind === 'escalated') {
      return this.escalate(target, force, `whole-Epic integrate into '${defaultBranch}' failed (${integrated.reason}): ${integrated.message}`);
    }

    const recorded = await this.recordIntegrationQuietly(target, integrated.mergeOid);

    this.clearMergeGuards(target.ref);
    if (recorded) await this.retireQuietly(target.ref, 'after integrate');
    this.operations.complete({ repoDir: this.repoDir, epicRef: target.ref });
    return { status: 'integrated', oid: integrated.mergeOid };
  }

  /** Whether `epicRef` currently has a integrate attempt in flight. */
  isInFlight(epicRef: number): boolean {
    return this.inFlight.has(epicRef);
  }

  /** The last retained whole-Epic Verification status for `epicRef`. */
  verificationStatus(epicRef: number): EpicVerificationStatus {
    return this.lastVerification.get(epicRef) ?? null;
  }

  /** Record that `epicRef`'s integration branch has fallen behind develop and a
   * refresh could not fast-forward it. A moving base is normal, never a failure:
   * logged quietly and retried on the next trigger, never raised as an operator hold. */
  recordRefreshBehind(epicRef: number, reason: string): void {
    logger.debug(`epic ${epicRef} integration refresh behind develop (retrying): ${reason}`);
  }

  /** The hold reason if `epicRef` is currently held by the sticky-escalation guard, else `null`. */
  heldReason(epicRef: number): string | null {
    return this.settledEscalated.has(epicRef)
      ? 'already escalated for this member state; awaiting operator or a state change'
      : null;
  }

  /** The integration branch's existence and tip OID for `epicRef`; `tip:null` when the branch is absent. */
  async integrationFacts(epicRef: number): Promise<{ exists: boolean; tip: string | null }> {
    const branch = integrationBranchName(epicRef);
    const exists = await this.git.branchExists(this.repoDir, branch);
    if (!exists) return { exists: false, tip: null };
    const tip = await this.git.revParse(this.repoDir, branch);
    return { exists: true, tip };
  }

  private escalate(target: EpicIntegrateTarget, force: boolean, reason: string): EpicIntegrateOutcome {
    if (!force) this.settledEscalated.set(target.ref, this.signatureOf(target.members));
    this.escalateFn(target.ref, reason);
    this.operations.fail({ repoDir: this.repoDir, epicRef: target.ref, reason });
    return { status: 'escalated', reason };
  }

  private signatureOf(members: MemberMergeState[]): string {
    return [...members].sort().join(',');
  }

  private forget(ref: number): void {
    this.settledEscalated.delete(ref);
    this.lastVerification.delete(ref);
    this.lastVerifyAttemptAt.delete(ref);
  }

  private clearMergeGuards(ref: number): void {
    this.settledEscalated.delete(ref);
    this.lastVerifyAttemptAt.delete(ref);
  }

  private async retireContained(target: EpicIntegrateTarget, branch: string): Promise<EpicIntegrateOutcome> {
    const tip = await this.git.revParse(this.repoDir, branch);
    this.settledEscalated.delete(target.ref);
    const recorded = await this.recordIntegrationQuietly(target, null);
    if (recorded) await this.retireQuietly(target.ref, 'already-contained');
    this.operations.complete({ repoDir: this.repoDir, epicRef: target.ref });
    return { status: 'integrated', oid: tip };
  }

  private async recordIntegrationQuietly(target: EpicIntegrateTarget, mergeCommit: string | null): Promise<boolean> {
    try {
      await this.recordIntegrationFn?.({ epicRef: target.ref, mergeCommit, memberRefs: target.memberRefs ?? [] });
      return true;
    } catch (err) {
      this.onError(`epic ${target.ref} integration snapshot record failed (deferring branch retire): ${String(err)}`);
      return false;
    }
  }

  private async retireQuietly(ref: number, context: string): Promise<void> {
    try {
      await this.operations.run({
        repoDir: this.repoDir,
        epicRef: ref,
        type: 'retire',
        work: () => this.retire(ref),
      });
    } catch (err) {
      this.onError(`epic ${ref} integration branch retire (${context}) failed: ${String(err)}`);
    }
  }
}
