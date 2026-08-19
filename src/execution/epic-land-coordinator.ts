import { Git } from './git.js';
import { integrationBranchName } from './epic-integration.js';
import { landBranch, type LandBranchArgs, type LandBranchOutcome } from './branch-landing.js';
import { decideEpicLand, type MemberLandState } from '../domain/epic-land.js';
import type { VerificationDecision } from '../verification/combine.js';

/**
 * The whole-Epic land coordinator (issue #161, parallel-epic tranche). The
 * injected-effects shell around the pure {@link decideEpicLand} (`src/domain/
 * epic-land.ts`), mirroring `MergeTrainCoordinator`'s shape: gather the observed
 * facts, call the decision, execute the action against an injected `Git` slice
 * and effect callbacks.
 *
 * The last step of an Epic's life (ADR-0024): once every member has landed onto
 * the Epic's integration branch (`epic/<ref>`, cut by #159, fed by the merge
 * train #160), Verify the integrated whole as a unit, and only on a pass merge
 * the integration branch into the default branch in one go and retire it. A
 * member that cannot land holds the whole Epic back; the operator has an
 * explicit force-land-the-ready-subset override (`submit(..., { force })`),
 * which lands whatever subset is folded in — but never bypasses Verification,
 * so a partial land is never automatic and never a silent pass.
 *
 * Poll-driven and idempotent: {@link submit} is called once per derived Epic
 * each poll. An Epic already being landed (a slow whole-Epic Verification is in
 * flight) short-circuits to `busy` rather than starting a redundant second
 * attempt — the poll trigger is a level, not an edge, so the next poll simply
 * re-submits. After a successful land the integration branch is retired, so the
 * following poll observes no branch and decides `noop`.
 *
 * Landing into the default branch obeys `branch-landing.ts`'s contract (#153):
 * when the default branch is checked out in the base repo (the common case — it
 * is the working dir's symbolic HEAD), a coherent in-place land needs an
 * exclusive clean lease; absent one, `landBranch` returns `fallback-pr-manual`
 * and this coordinator escalates (fail-safe) rather than desyncing the checkout.
 * The lease assertion is the one fact the wiring supplies via `landLeaseHeld`.
 */

/** The slice of {@link Git} the coordinator needs — real Git in prod, a fake in tests. */
export interface EpicLandGit {
  branchExists(dir: string, name: string): Promise<boolean>;
  revParse(dir: string, rev: string): Promise<string>;
  /** The default branch the integration branch lands into, or `null` on a
   * detached HEAD (a concurrent afk-direct Run — defer the land that poll). */
  symbolicBranch(dir: string): Promise<string | null>;
}

/** Run a whole-Epic Verification against the integration branch's tip OID and
 * fold the verifiers' verdicts into a single decision (issue #161). Injected so
 * the coordinator stays decoupled from the verifier plumbing; the wire builds an
 * adapter around {@link verifyEpicIntegration} (`epic-verification.ts`) that
 * supplies the Workspace's resolved verifiers. */
export type EpicVerify = (args: { repoDir: string; candidateOid: string }) => Promise<VerificationDecision>;

/** The retained whole-Epic Verification status for the operator read model
 * (issue #178): `pending` while a verify is in flight, `pass`/`fail` for the
 * last completed attempt's verdict, `null` when none has run for the current
 * integration branch. In-memory only (ADR-0024), like the coordinator's other
 * guards. */
export type EpicVerificationStatus = 'pass' | 'fail' | 'pending' | null;

/** An Epic offered for a land attempt, reduced from the poll's derived Epic and
 * its members' mirrored Task states. */
export interface EpicLandTarget {
  ref: number;
  /** Each member's reduced land state; ignored under an operator force-land. */
  members: MemberLandState[];
}

export type EpicLandOutcome =
  | { status: 'landed'; oid: string }
  | { status: 'blocked'; reason: string }
  | { status: 'waiting'; reason: string }
  | { status: 'escalated'; reason: string }
  | { status: 'noop'; reason: string }
  /** A land attempt for this Epic is already in flight; the caller re-submits next poll. */
  | { status: 'busy' };

export class EpicLandCoordinator {
  private readonly repoDir: string;
  private readonly git: EpicLandGit;
  private readonly verify: EpicVerify;
  private readonly land: (args: LandBranchArgs) => Promise<LandBranchOutcome>;
  private readonly retire: (epicRef: number) => Promise<void>;
  private readonly escalateFn: (epicRef: number, reason: string) => void;
  private readonly landLeaseHeld: boolean;
  private readonly onError: (msg: string) => void;

  /** Epic refs with a land attempt currently in flight — the redundancy guard.
   * In-memory only (ADR-0024): no durable grouping entity, no migration. */
  private readonly inFlight = new Set<number>();

  /** Epic refs whose *automatic* land attempt escalated, keyed by the member-state
   * signature that escalated — the level trigger's terminal guard. `submit` is
   * called every poll, so without this a gated-open Epic that cannot auto-land (a
   * failing whole-Epic Verification, or a land that falls back to a manual PR)
   * would re-run the whole-Epic Verification (minutes of CI) and re-escalate on
   * every poll, forever. Once escalated it stays held until the member state
   * changes or the branch is gone; an operator force-land bypasses it. In-memory
   * only (ADR-0024), mirroring the merge train's in-memory `healAttempted`. */
  private readonly settledEscalated = new Map<number, string>();

  /** The last whole-Epic Verification status per Epic ref (issue #178), retained
   * so the operator read model surfaces the real verdict instead of the former
   * always-`null` placeholder: `'pending'` set right before the verify runs,
   * then `'pass'`/`'fail'` from the verdict. Cleared when the integration branch
   * is gone (alongside {@link settledEscalated}) so a re-cut Epic reusing the ref
   * starts `null` again. In-memory only (ADR-0024); an absent key reads as `null`. */
  private readonly lastVerification = new Map<number, Exclude<EpicVerificationStatus, null>>();

  constructor(deps: {
    /** The base repo owning `epic/<ref>` — the Workspace's working directory. */
    repoDir: string;
    git?: EpicLandGit;
    /** Whole-Epic Verification against the integration tip (default {@link verifyEpicIntegration} at the wire). */
    verify: EpicVerify;
    /** Default = real {@link landBranch}. */
    land?: (args: LandBranchArgs) => Promise<LandBranchOutcome>;
    /** Retire the integration branch after a successful land — wired to
     * `EpicIntegrationCoordinator.retireIntegrationBranch`. */
    retire: (epicRef: number) => Promise<void>;
    /** Epic-level escalation surface (verify fail/inconclusive or land failure). */
    escalate: (epicRef: number, reason: string) => void;
    /** Whether an exclusive clean lease is asserted over a checked-out default
     * branch, permitting a coherent in-place land (#153). Default `false`: a
     * checked-out target with no lease falls back to PR/manual → escalate. */
    landLeaseHeld?: boolean;
    onError?: (msg: string) => void;
  }) {
    this.repoDir = deps.repoDir;
    this.git = deps.git ?? Git;
    this.verify = deps.verify;
    this.land = deps.land ?? landBranch;
    this.retire = deps.retire;
    this.escalateFn = deps.escalate;
    this.landLeaseHeld = deps.landLeaseHeld ?? false;
    this.onError = deps.onError ?? ((msg) => console.error(msg));
  }

  /**
   * Attempt a whole-Epic land for `target`. `force` is the operator's explicit
   * force-land-the-ready-subset override (issue #161) — set only by the operator
   * action, never by the automatic poll trigger. Idempotent and re-entrancy-safe:
   * an in-flight attempt for the same Epic returns `busy`.
   */
  async submit(target: EpicLandTarget, opts?: { force?: boolean }): Promise<EpicLandOutcome> {
    const force = opts?.force ?? false;
    if (this.inFlight.has(target.ref)) return { status: 'busy' };
    this.inFlight.add(target.ref);
    try {
      return await this.attempt(target, force);
    } finally {
      this.inFlight.delete(target.ref);
    }
  }

  private async attempt(target: EpicLandTarget, force: boolean): Promise<EpicLandOutcome> {
    const branch = integrationBranchName(target.ref);
    const integrationExists = await this.git.branchExists(this.repoDir, branch);
    // Branch gone (a completed land retired it, or it was landed by hand): drop
    // any sticky escalation so a fresh Epic reusing the ref starts clean.
    if (!integrationExists) {
      this.settledEscalated.delete(target.ref);
      this.lastVerification.delete(target.ref);
    }

    // First pass: the gate decision, before any (slow) Verification is run.
    const gate = decideEpicLand({ integrationExists, members: target.members, verification: null, force });
    switch (gate.action) {
      case 'noop':
        return { status: 'noop', reason: gate.reason };
      case 'wait':
        return { status: 'waiting', reason: gate.reason };
      case 'blocked':
        return { status: 'blocked', reason: gate.reason };
      case 'verify':
        break; // gate open — run the whole-Epic Verification below.
      default:
        // 'land'/'escalate' are unreachable with verification === null; total-switch guard.
        return { status: 'noop', reason: gate.reason };
    }

    // Gate open. On the automatic path, an Epic already escalated for this exact
    // member state is held: don't re-burn Verification or re-escalate every poll
    // until its state changes or the branch is gone. An operator force-land (which
    // never sets this) always retries. Checked *after* `branchExists` above so a
    // retired/hand-landed branch clears the hold rather than sticking forever.
    if (!force && this.settledEscalated.get(target.ref) === this.signatureOf(target.members)) {
      return { status: 'escalated', reason: 'already escalated for this member state; awaiting operator or a state change' };
    }

    // Resolve the default branch up front so a detached HEAD (a concurrent
    // afk-direct Run #152) defers *before* burning a minutes-long Verification,
    // and reuse the same value as the land target below.
    const defaultBranch = await this.git.symbolicBranch(this.repoDir);
    if (defaultBranch === null) {
      return { status: 'waiting', reason: 'default branch is detached; deferring the land' };
    }

    // Verify the integrated whole against the integration branch tip.
    const candidateOid = await this.git.revParse(this.repoDir, branch);
    this.lastVerification.set(target.ref, 'pending');
    let verification: VerificationDecision;
    try {
      verification = await this.verify({ repoDir: this.repoDir, candidateOid });
    } catch (err) {
      // A verification-harness failure is genuine infra doubt: fail-safe to
      // escalate, never land (the same direction `inconclusive` folds to).
      this.lastVerification.set(target.ref, 'fail');
      return this.escalate(target, force, `whole-Epic verification could not run: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Second pass: re-decide with the Verification result folded in.
    const verdict = decideEpicLand({ integrationExists: true, members: target.members, verification, force });
    if (verdict.action === 'escalate') {
      this.lastVerification.set(target.ref, 'fail');
      return this.escalate(target, force, verdict.reason);
    }
    if (verdict.action !== 'land') {
      // Truly unreachable: with the gate open and a non-null Verification,
      // decideEpicLand yields only land/escalate. Surface rather than swallow.
      this.onError(`epic ${target.ref} unexpected post-verification decision: ${verdict.action}`);
      return { status: 'noop', reason: `unexpected post-verification decision: ${verdict.action}` };
    }

    // Verification proceeded — record the pass verdict for the read model (issue
    // #178) independent of whether the subsequent land succeeds (a land failure
    // escalates via its own path and surfaces through `held`, not as a verify fail).
    this.lastVerification.set(target.ref, 'pass');

    // Verification passed: land the whole integration branch into the default
    // branch, atomically (#153).
    const landed = await this.land({ repoDir: this.repoDir, baseBranch: defaultBranch, branch, leaseHeld: this.landLeaseHeld });
    if (!landed.ok) {
      return this.escalate(target, force, `whole-Epic land into '${defaultBranch}' failed (${landed.reason}): ${landed.detail}`);
    }

    // Landed: clear any sticky escalation, then retire the integration branch
    // (idempotent). The land already succeeded, so a retire hiccup is logged, not
    // fatal — the branch is stale (a redundant no-op verify+land next poll self-
    // heals it), never corrupting.
    this.settledEscalated.delete(target.ref);
    try {
      await this.retire(target.ref);
    } catch (err) {
      this.onError(`epic ${target.ref} integration branch retire after land failed: ${String(err)}`);
    }
    return { status: 'landed', oid: landed.oid };
  }

  /**
   * Whether `epicRef` currently has a land attempt in flight (issue #167 read
   * model) — exposes the private {@link inFlight} guard for the operator read
   * endpoint's `EpicLandState.inFlight`.
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
   * failed land) and, on the *automatic* path, make it sticky for this member
   * state so the level trigger holds rather than re-escalating every poll. */
  private escalate(target: EpicLandTarget, force: boolean, reason: string): EpicLandOutcome {
    if (!force) this.settledEscalated.set(target.ref, this.signatureOf(target.members));
    this.escalateFn(target.ref, reason);
    return { status: 'escalated', reason };
  }

  /** A stable signature of the members' reduced land states — the key the sticky
   * escalation is held under, so any change in a member's state releases the hold. */
  private signatureOf(members: MemberLandState[]): string {
    return [...members].sort().join(',');
  }
}
