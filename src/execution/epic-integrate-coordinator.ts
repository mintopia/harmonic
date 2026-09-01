import { Git } from './git.js';
import { integrationBranchName } from './epic-integration.js';
import type { MergePolicyOutcome } from './merge-policy.js';
import { decideEpicIntegrate, type MemberMergeState } from '../domain/epic-integrate.js';
import type { VerificationDecision } from '../verification/combine.js';
import { logger } from '../logger.js';
import { EpicOperations } from './epic-operations.js';

/**
 * The whole-Epic integrate coordinator (issue #161, parallel-epic tranche). The
 * injected-effects shell around the pure {@link decideEpicIntegrate} (`src/domain/
 * epic-integrate.ts`): gather the observed facts, call the decision, execute the
 * action against an injected `Git` slice and effect callbacks.
 *
 * The last step of an Epic's life (ADR-0024): once every member has merged onto
 * the Epic's integration branch (`epic/<ref>`, cut by #159) under the one merge
 * policy (ADR-0001), Verify the integrated whole as a unit, and only on a pass
 * merge the integration branch into the default branch and retire it. A member
 * that cannot integrate holds the whole Epic back; the operator has an explicit
 * force-integrate-the-ready-subset override (`submit(..., { force })`), which
 * integrates whatever subset is folded in — but never bypasses Verification, so a
 * partial integrate is never automatic and never a silent pass.
 *
 * Poll-driven and idempotent: {@link submit} is called once per derived Epic
 * each poll. An Epic already being integrated (a slow whole-Epic Verification is in
 * flight) short-circuits to `busy` rather than starting a redundant second
 * attempt — the poll trigger is a level, not an edge, so the next poll simply
 * re-submits. After a successful integrate the integration branch is retired, so the
 * following poll observes no branch and decides `noop`.
 *
 * Integrating into the default branch runs the one merge policy (ADR-0001) via the
 * injected {@link EpicIntegrate} callback: `git merge --no-ff` under the base repo
 * mutex, bounded agentic resolve turns, a deterministic post-merge check, and a
 * `git revert -m 1` on red. A moved default branch is reconciled by the merge
 * commit and never detected — there is no lease, freshness gate, or `--ff-only`
 * frozen-tree assertion. A detached HEAD still defers (the coordinator resolves
 * the default branch up front so it can name the integrate target).
 *
 * Idempotent and storm-proof (issue #218): before verify+integrate it (a) retires the
 * integration branch outright when its work is already contained in the default
 * branch (an ancestor of it) — a prior integrate whose retire didn't finish, or a
 * hand-merge — and (b) hard-backs-off repeated verify+integrate per Epic, so a
 * never-integrating or already-integrated Epic can't spin git on the event loop.
 */

/** The slice of {@link Git} the coordinator needs — real Git in prod, a fake in tests. */
export interface EpicIntegrateGit {
  branchExists(dir: string, name: string): Promise<boolean>;
  revParse(dir: string, rev: string): Promise<string>;
  /** The default branch the integration branch integrates into, or `null` on a
   * detached HEAD (a concurrent afk-direct Run — defer the integrate that poll). */
  symbolicBranch(dir: string): Promise<string | null>;
  /** Whether `branch` is already merged into `baseBranch` (an ancestor of its
   * tip) — the cheap containment fast-path (issue #218): an integration branch
   * whose work is already in the default branch is retired without re-running the
   * (expensive, git-heavy) verify+integrate. */
  isAncestor(dir: string, baseBranch: string, branch: string): Promise<boolean>;
  /** Whether merging `branch` into `baseBranch` adds no net content — the
   * work is already integrated even when a squash/rebase rewrote its commits so the
   * tip is *not* a literal ancestor (issue #218). Heavier than {@link isAncestor}
   * (a real 3-way merge), so the coordinator runs it only when already committed
   * to expensive work this poll. */
  isContentContained(dir: string, baseBranch: string, branch: string): Promise<boolean>;
}

/** Run a whole-Epic Verification against the integration branch's tip OID and
 * fold the verifiers' verdicts into a single decision (issue #161). Injected so
 * the coordinator stays decoupled from the verifier plumbing; the wire builds an
 * adapter around {@link verifyEpicIntegration} (`epic-verification.ts`) that
 * supplies the Workspace's resolved verifiers. */
export type EpicVerify = (args: { repoDir: string; verifiedHeadOid: string }) => Promise<VerificationDecision>;

/** Merge the Epic's integration branch into the default branch under the one
 * merge policy (ADR-0001): `git merge --no-ff` under the base repo mutex, bounded
 * agentic resolve turns, the deterministic post-merge check, and `git revert -m 1`
 * on red. Injected so the coordinator stays decoupled from the runner's harness
 * plumbing; the wire builds an adapter around `Runner.mergeEpicIntegration`. A
 * moved base is reconciled by the merge commit and never detected, so the outcome
 * is only `merged` or `escalated` (conflict / red post-merge check). */
export type EpicIntegrate = (args: {
  repoDir: string;
  epicRef: number;
  defaultBranch: string;
  integrationBranch: string;
}) => Promise<MergePolicyOutcome>;

/** The retained whole-Epic Verification status for the operator read model
 * (issue #178): `pending` while a verify is in flight, `pass`/`fail` for the
 * last completed attempt's verdict, `null` when none has run for the current
 * integration branch. In-memory only (ADR-0024), like the coordinator's other
 * guards. */
export type EpicVerificationStatus = 'pass' | 'fail' | 'pending' | null;

/** An Epic offered for a integrate attempt, reduced from the poll's derived Epic and
 * its members' mirrored Task states. */
export interface EpicIntegrateTarget {
  ref: number;
  /** Each member's reduced merge state. An empty array is only safe under an
   * operator force-integrate (which bypasses the per-member gate); a non-force
   * submit with `[]` decides `noop` and never integrates. */
  members: MemberMergeState[];
  /** The Epic's member refs, snapshotted onto the stored Epic record at integration
   * (ADR-0018, #438). Absent ⇒ an empty snapshot; the reconcile carries the real list. */
  memberRefs?: number[];
}

/** Persist a completed Epic integration onto its stored record (ADR-0018, #438):
 * the merge-commit hash (null for a no-op finish where the branch already matched
 * base) and the member-ref snapshot. Injected so the coordinator stays decoupled
 * from the store; the wire binds it to `TaskService.markEpicIntegrated` for the
 * Workspace. */
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

  /** Epic refs with a integrate attempt currently in flight — the redundancy guard.
   * In-memory only (ADR-0024): no durable grouping entity, no migration. */
  private readonly inFlight = new Set<number>();

  /** Epic refs whose *automatic* integrate attempt escalated, keyed by the member-state
   * signature that escalated — the level trigger's terminal guard. `submit` is
   * called every poll, so without this a gated-open Epic that cannot auto-integrate (a
   * failing whole-Epic Verification, or a integrate that falls back to a manual PR)
   * would re-run the whole-Epic Verification (minutes of CI) and re-escalate on
   * every poll, forever. Once escalated it stays held until the member state
   * changes or the branch is gone; an operator force-integrate bypasses it. In-memory
   * only (ADR-0024). */
  private readonly settledEscalated = new Map<number, string>();

  /** The last whole-Epic Verification status per Epic ref (issue #178), retained
   * so the operator read model surfaces the real verdict instead of the former
   * always-`null` placeholder: `'pending'` set right before the verify runs,
   * then `'pass'`/`'fail'` from the verdict. Cleared when the integration branch
   * is gone (alongside {@link settledEscalated}) so a re-cut Epic reusing the ref
   * starts `null` again. In-memory only (ADR-0024); an absent key reads as `null`. */
  private readonly lastVerification = new Map<number, Exclude<EpicVerificationStatus, null>>();

  /** The wall-clock of the last verify+integrate *attempt* per Epic ref (issue #218),
   * the key to the hard backoff. Cleared alongside the other guards when the
   * branch is gone or just retired. In-memory only (ADR-0024). */
  private readonly lastVerifyAttemptAt = new Map<number, number>();

  private readonly now: () => number;
  /** The minimum gap between whole-Epic verify+integrate attempts for one Epic (issue
   * #218): a hard floor so a churning member signature or an in-memory-guard
   * reset after a restart can't spin the (git-heavy) verify+integrate on the event
   * loop. Bypassed by an operator force-integrate. */
  private readonly verifyBackoffMs: number;

  constructor(deps: {
    /** The base repo owning `epic/<ref>` — the Workspace's working directory. */
    repoDir: string;
    git?: EpicIntegrateGit;
    /** Whole-Epic Verification against the integration tip (default {@link verifyEpicIntegration} at the wire). */
    verify: EpicVerify;
    /** Merge the integration branch into the default branch under the one merge
     * policy (ADR-0001) — wired to `Runner.mergeEpicIntegration`. */
    integrate: EpicIntegrate;
    /** Retire the integration branch after a successful integrate — wired to
     * `EpicIntegrationCoordinator.retireIntegrationBranch`. */
    retire: (epicRef: number) => Promise<void>;
    /** Epic-level escalation surface (verify fail/inconclusive or integrate failure). */
    escalate: (epicRef: number, reason: string) => void;
    /** Injected clock for the hard backoff (issue #218); default `Date.now`. */
    now?: () => number;
    /** Minimum gap between whole-Epic verify+integrate attempts per Epic (issue #218);
     * default 60s. */
    verifyBackoffMs?: number;
    onError?: (msg: string) => void;
    operations?: EpicOperations;
    /** Persist the integration snapshot onto the stored Epic record (ADR-0018, #438);
     * absent ⇒ nothing is recorded (the base-set-only wiring, and unit tests). */
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
   * force-integrate-the-ready-subset override (issue #161) — set only by the operator
   * action, never by the automatic poll trigger. Idempotent and re-entrancy-safe:
   * an in-flight attempt for the same Epic returns `busy`.
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
    // Branch gone (a completed integrate retired it, or it was integrated by hand): drop
    // any sticky escalation / backoff so a fresh Epic reusing the ref starts clean.
    if (!integrationExists) {
      this.forget(target.ref);
    }

    // First pass: the gate decision, before any (slow) Verification is run.
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
        break; // gate open — run the whole-Epic Verification below.
      default:
        // 'integrate'/'escalate' are unreachable with verification === null; total-switch guard.
        return { status: 'noop', reason: gate.reason };
    }

    // Resolve the default branch up front so a detached HEAD (a concurrent
    // afk-direct Run #152) defers *before* burning a minutes-long Verification or
    // the containment check, and reuse the same value as the integrate target below.
    const defaultBranch = await this.git.symbolicBranch(this.repoDir);
    if (defaultBranch === null) {
      return { status: 'waiting', reason: 'default branch is detached; deferring the integrate' };
    }

    // Containment fast-path, tier 1 (issue #218). If the integration branch tip is
    // already an ancestor of the default branch, its work is *already integrated* — a
    // prior integrate whose retire didn't complete, or a hand-merge. Retire it
    // idempotently and skip verify+integrate entirely: re-running the (expensive,
    // git-heavy) verify+integrate against a branch with nothing left to integrate is exactly
    // the reconcile git storm this fixes. The `isAncestor` check is cheap (one
    // `merge-base`), so it runs every poll — *before* the sticky-escalation hold,
    // so a hand-integrated-but-escalated Epic is auto-retired, not left lingering.
    if (await this.git.isAncestor(this.repoDir, defaultBranch, branch)) {
      return await this.retireContained(target, branch);
    }

    // Gate open, work not yet integrated. On the automatic path, an Epic already
    // escalated for this exact member state is held: don't re-burn Verification or
    // re-escalate every poll until its state changes or the branch is gone. An
    // operator force-integrate (which never sets this) always retries.
    if (!force && this.settledEscalated.get(target.ref) === this.signatureOf(target.members)) {
      return { status: 'escalated', reason: 'already escalated for this member state; awaiting operator or a state change' };
    }

    // Hard backoff (issue #218): bound how often the expensive verify+integrate runs
    // per Epic, so a churning member signature — or a re-burn after a restart
    // cleared the in-memory guards — can't spin verify+integrate on the event loop. An
    // operator force-integrate bypasses it. In-memory only (ADR-0024): no persisted
    // record, so at most one attempt per boot survives a restart, then this holds.
    if (!force) {
      const at = this.now();
      const last = this.lastVerifyAttemptAt.get(target.ref);
      if (last !== undefined && at - last < this.verifyBackoffMs) {
        return { status: 'waiting', reason: 'whole-Epic verify+integrate backoff active; deferring this poll' };
      }
      this.lastVerifyAttemptAt.set(target.ref, at);
    }

    // Containment fast-path, tier 2 (issue #218). Tier 1 misses a squash/rebase
    // integrate that rewrote the member OIDs so the tip is not a literal ancestor even
    // though the *content* is already in the default branch. Catch that with a
    // real 3-way merge (`merge-tree`) that adds no net content. It is heavier than
    // tier 1, so it runs only here — past the sticky hold and the backoff, i.e. on
    // a poll already committed to the expensive verify+integrate (at most once per
    // backoff window), never every poll. Contained ⇒ retire, don't verify+integrate.
    if (await this.git.isContentContained(this.repoDir, defaultBranch, branch)) {
      return await this.retireContained(target, branch);
    }

    // Verify the integrated whole against the integration branch tip.
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
      // A verification-harness failure is genuine infra doubt: fail-safe to
      // escalate, never integrate (the same direction `inconclusive` folds to).
      this.lastVerification.set(target.ref, 'fail');
      return this.escalate(target, force, `whole-Epic verification could not run: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Second pass: re-decide with the Verification result folded in.
    const verdict = decideEpicIntegrate({ integrationExists: true, members: target.members, verification, force });
    if (verdict.action === 'escalate') {
      this.lastVerification.set(target.ref, 'fail');
      return this.escalate(target, force, verdict.reason);
    }
    if (verdict.action !== 'integrate') {
      // Truly unreachable: with the gate open and a non-null Verification,
      // decideEpicIntegrate yields only integrate/escalate. Surface rather than swallow.
      this.onError(`epic ${target.ref} unexpected post-verification decision: ${verdict.action}`);
      return { status: 'noop', reason: `unexpected post-verification decision: ${verdict.action}` };
    }

    // Verification proceeded — record the pass verdict for the read model (issue
    // #178) independent of whether the subsequent integrate succeeds (a integrate failure
    // escalates via its own path and surfaces through `held`, not as a verify fail).
    this.lastVerification.set(target.ref, 'pass');

    // Verification passed: integrate the whole integration branch into the default
    // branch under the one merge policy (ADR-0001). A moved base is reconciled by
    // the merge commit and never detected — the post-merge check catches semantic
    // collisions on the merged tip and reverts on red, so the outcome is only
    // `merged` or `escalated` (an unresolved conflict or a red post-merge check).
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

    // Settle the stored Epic record before retiring the branch: record the real
    // merge-commit hash and the member snapshot, and flip the lifecycle to
    // `integrated` (ADR-0018, #438).
    const recorded = await this.recordIntegrationQuietly(target, integrated.mergeOid);

    // Integrated: clear the sticky escalation and the backoff (but keep the retained
    // `pass` verification for the read model), then retire the integration branch
    // (idempotent). Retire ONLY once the record landed: the branch is what makes the
    // next poll re-settle (its containment fast-path, #218), so retiring after a
    // failed record would strand the Epic at `open` with no re-trigger. On a failed
    // record the branch is left for the next poll to re-record and retire.
    this.clearMergeGuards(target.ref);
    if (recorded) await this.retireQuietly(target.ref, 'after integrate');
    this.operations.complete({ repoDir: this.repoDir, epicRef: target.ref });
    return { status: 'integrated', oid: integrated.mergeOid };
  }

  /**
   * Whether `epicRef` currently has a integrate attempt in flight (issue #167 read
   * model) — exposes the private {@link inFlight} guard for the operator read
   * endpoint's `EpicIntegrateState.inFlight`.
   */
  isInFlight(epicRef: number): boolean {
    return this.inFlight.has(epicRef);
  }

  /**
   * The last retained whole-Epic Verification status for `epicRef` (issue #178) —
   * exposes the private {@link lastVerification} guard as an
   * {@link EpicVerificationStatus}, feeding the operator read endpoint's
   * `EpicVerification.status` (previously hardcoded `null`).
   */
  verificationStatus(epicRef: number): EpicVerificationStatus {
    return this.lastVerification.get(epicRef) ?? null;
  }

  /** Record that `epicRef`'s integration branch has fallen behind develop and a
   * refresh could not fast-forward it — a moving base, or no member free to host
   * the one corrective turn. Per ADR-0046 a moving base is normal, never a failure:
   * this is logged quietly and retried on the next trigger, never raised as an
   * operator hold. The epic-level escalation is reserved for the integrate gate
   * (every member merged + whole-Epic verify/ff-only merge), which is member-gated —
   * so an in-flight Epic whose members are still in progress is never escalated for
   * a base that moved under it. */
  recordRefreshBehind(epicRef: number, reason: string): void {
    logger.debug(`epic ${epicRef} integration refresh behind develop (retrying): ${reason}`);
  }

  /**
   * The hold reason if `epicRef` is currently held by the sticky-escalation
   * guard ({@link settledEscalated}), else `null` (issue #167 read model).
   * `settledEscalated` only stores the member-state signature it's held
   * against, not the original escalation's free-text reason (that reason was
   * a one-off argument to the injected `escalate` callback, never retained) —
   * so this mirrors the exact reason text `submit` would return were it
   * re-invoked with the same member state right now, rather than fabricating
   * a different one.
   */
  heldReason(epicRef: number): string | null {
    return this.settledEscalated.has(epicRef)
      ? 'already escalated for this member state; awaiting operator or a state change'
      : null;
  }

  /**
   * The integration branch's existence and tip OID for `epicRef` (issue #167
   * read model) — the same `EpicGit.branchExists` + `revParse` pair
   * {@link attempt} uses, exposed read-only so the operator read endpoint
   * doesn't need its own git plumbing. `tip:null` when the branch is absent.
   */
  async integrationFacts(epicRef: number): Promise<{ exists: boolean; tip: string | null }> {
    const branch = integrationBranchName(epicRef);
    const exists = await this.git.branchExists(this.repoDir, branch);
    if (!exists) return { exists: false, tip: null };
    const tip = await this.git.revParse(this.repoDir, branch);
    return { exists: true, tip };
  }

  /** Escalate the Epic (verify fail/inconclusive, verify-harness failure, or a
   * failed integrate) and, on the *automatic* path, make it sticky for this member
   * state so the level trigger holds rather than re-escalating every poll. */
  private escalate(target: EpicIntegrateTarget, force: boolean, reason: string): EpicIntegrateOutcome {
    if (!force) this.settledEscalated.set(target.ref, this.signatureOf(target.members));
    this.escalateFn(target.ref, reason);
    this.operations.fail({ repoDir: this.repoDir, epicRef: target.ref, reason });
    return { status: 'escalated', reason };
  }

  /** A stable signature of the members' reduced integrate states — the key the sticky
   * escalation is held under, so any change in a member's state releases the hold. */
  private signatureOf(members: MemberMergeState[]): string {
    return [...members].sort().join(',');
  }

  /** Drop every in-memory per-Epic guard for `ref` — the sticky escalation, the
   * retained verification status, and the verify+integrate backoff — when the branch
   * is *gone*, so a re-cut Epic reusing the ref starts clean (issue #218). */
  private forget(ref: number): void {
    this.settledEscalated.delete(ref);
    this.lastVerification.delete(ref);
    this.lastVerifyAttemptAt.delete(ref);
  }

  /** Clear only the guards that must not outlive a completed integrate — the sticky
   * escalation and the verify+integrate backoff — while *retaining* the last
   * verification verdict for the operator read model (issue #178). Shared by the
   * post-integrate success path and the containment fast-path so a integrated Epic reports
   * a consistent verdict either way (issue #218). */
  private clearMergeGuards(ref: number): void {
    this.settledEscalated.delete(ref);
    this.lastVerifyAttemptAt.delete(ref);
  }

  /** Retire an integration branch whose work is *already contained* in the
   * default branch (either containment tier, issue #218): keep any retained
   * verification verdict (a normal integrate that reached here via a failed retire
   * stays `pass`), release only the sticky escalation, retire idempotently, and
   * report the branch tip as the integrated OID.
   *
   * Deliberately does *not* clear the verify+integrate backoff: a contained Epic has
   * nothing left to integrate, so if the retire keeps failing (a lingering branch),
   * the backoff must keep throttling the poll — otherwise the heavy tier-2
   * `isContentContained` merge would re-run every poll, reviving the storm class
   * #218 targets on the op it labels heavy. A successful retire makes the branch
   * gone, and the next poll's `forget()` clears every guard anyway. */
  private async retireContained(target: EpicIntegrateTarget, branch: string): Promise<EpicIntegrateOutcome> {
    const tip = await this.git.revParse(this.repoDir, branch);
    this.settledEscalated.delete(target.ref);
    // No merge happened — the branch already matched base — so settle the stored
    // Epic record as a no-op with a null merge-commit (ADR-0018, #438). Retire only
    // once that landed, so a failed record leaves the branch for the next poll to
    // re-settle rather than stranding the Epic at `open`.
    const recorded = await this.recordIntegrationQuietly(target, null);
    if (recorded) await this.retireQuietly(target.ref, 'already-contained');
    this.operations.complete({ repoDir: this.repoDir, epicRef: target.ref });
    return { status: 'integrated', oid: tip };
  }

  /** Persist the integration snapshot onto the stored Epic record, logging (not
   * throwing) on failure (ADR-0018, #438): the merge already advanced the base
   * branch — the durable truth — so a store hiccup must not fail the integrate or
   * block the retire. `markEpicIntegrated`'s `state = 'open'` guard makes the write
   * a once-only transition, so a later poll re-recording the (now retired) branch
   * with a null hash can't clobber the real merge-commit stored here. Returns
   * whether the record landed (true when no recorder is wired — nothing to defer),
   * so the caller can hold the branch retire until it did. */
  private async recordIntegrationQuietly(target: EpicIntegrateTarget, mergeCommit: string | null): Promise<boolean> {
    try {
      await this.recordIntegrationFn?.({ epicRef: target.ref, mergeCommit, memberRefs: target.memberRefs ?? [] });
      return true;
    } catch (err) {
      this.onError(`epic ${target.ref} integration snapshot record failed (deferring branch retire): ${String(err)}`);
      return false;
    }
  }

  /** Retire the integration branch, logging (not throwing) on failure: the integrate
   * has already succeeded or the branch is already contained, so a retire hiccup
   * leaves a stale branch the next poll's containment fast-path retires — never a
   * corruption. `context` names the call site for the log (issue #218). */
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
