/**
 * Branch-contract classifier + recovery decision (issue #150, reliability-design
 * Unit D, ADR-0023). The contract is **"Harmonic owns branching"**: the agent
 * never creates or switches branches, and every ref Harmonic itself moves is
 * *tagged* to the lease/Run that moved it (owned-ref tracking). At `validating`,
 * before landing, Harmonic must decide from the **recorded start-state** (issue
 * #149) plus the **ref-deltas observed during the Run** whether the Run's git
 * outcome is:
 *
 *  - **clean** — the contract held; land normally;
 *  - **recoverable** — only Harmonic's *own* attributed checkout state is out of
 *    place (a direct-mode detached HEAD, a relocated worktree, a re-pointed owned
 *    branch), and recorded OIDs + reachability make the fix-up deterministic;
 *  - **ambiguous** — an *unattributed* ref delta, a diverged branch, or HEAD on a
 *    commit Harmonic cannot name → **escalate** (later: a bounded agent re-merge
 *    fallback, else Escalate; never a blind auto-recover).
 *
 * This module is the **pure** half: no git I/O, no database, no clock — the same
 * seam as `run-disposition.ts` / `run-start-state.ts`, so every branch of the
 * decision is exhaustively unit-testable from plain fixture objects with no live
 * repo. The Runner gathers the observation (`Git.forEachRef` before/after,
 * `Git.isAncestor` for reachability, the owned-ref tracker for attribution) and
 * passes it in; the classification itself touches nothing.
 *
 * Attribution is the caller's responsibility: whoever builds the observation
 * tags each delta with the Run that Harmonic recorded as its author. This
 * classifier only *applies* the invariant — an untagged (or foreign-tagged)
 * delta is never trusted as this Run's own controlled move.
 */

/**
 * Every branch-contract outcome, in strict escalation order (most-benign first).
 * This array is the single source of truth for the outcome set; the derived
 * union is taken straight off it, and a test pins it verbatim so an accidental
 * rename fails loudly.
 */
export const BRANCH_OUTCOMES = ['clean', 'recoverable', 'ambiguous'] as const;

export type BranchOutcome = (typeof BRANCH_OUTCOMES)[number];

/**
 * Why a Run's outcome is **ambiguous** and must escalate rather than
 * auto-recover. Each maps to a distinct, testable condition.
 */
export type AmbiguityReason =
  /** A ref moved that Harmonic never tagged at all (`attributedRunId: null`) —
   * the classic `git checkout -b`/commit by the agent, or an external actor. */
  | 'unattributed-ref-delta'
  /** A ref moved that Harmonic *did* tag, but to a **different** Run than this
   * one — a concurrent Run's move, which this Run's deterministic recovery is
   * not permitted to reason about (ADR-0022: one afk Run per work context). */
  | 'foreign-ref-delta'
  /** The recorded start commit is no longer reachable from the intended branch
   * tip — history was rewritten/diverged, so recorded OIDs no longer describe
   * the branch and deterministic recovery cannot prove it wouldn't drop work. */
  | 'intended-branch-diverged'
  /** HEAD sits on a commit Harmonic cannot name: not the recorded start, not the
   * tip of any owned ref this Run moved, and not already on the intended branch. */
  | 'head-at-unknown-commit';

/**
 * Why a Run's outcome is **recoverable**: only Harmonic's own attributed
 * checkout state is out of place, and the fix is a deterministic re-checkout.
 */
export type RecoveryReason =
  /** Direct-mode isolation footprint (#152): HEAD detached at the recorded start
   * commit or at this Run's own owned candidate ref tip — restore the checkout. */
  | 'head-detached-on-owned-ref'
  /** HEAD is on a *different* branch, but one this Run itself moved (attributed)
   * — re-point HEAD back onto the intended branch. */
  | 'head-off-intended-branch'
  /** Right branch, but HEAD is in a worktree other than the expected one. */
  | 'worktree-relocated';

/**
 * A single ref mutation observed over the Run's lifetime, `from` → `to`. A
 * created ref has `from: null`; a deleted ref has `to: null`.
 *
 * `attributedRunId` is the owned-ref tag: the Run/lease Harmonic recorded as
 * having moved this ref, or `null` when Harmonic never moved it (an *unattributed*
 * delta — the agent or an external actor did). A delta counts as this Run's own
 * owned move **only** when `attributedRunId === observation.runId`; a `null` or a
 * foreign Run's id is untrusted for this Run's deterministic recovery.
 */
export interface RefDelta {
  /** Full ref name, e.g. `refs/heads/develop`, `refs/harmonic/direct/run-42`. */
  ref: string;
  from: string | null;
  to: string | null;
  attributedRunId: number | null;
}

/**
 * The commit-reachability facts the decision needs, computed by the Runner via
 * `git merge-base --is-ancestor` (`Git.isAncestor`) so the classifier stays
 * git-free. Both are phrased as reachability **from the intended branch**.
 */
export interface BranchReachability {
  /** Is the recorded start commit an ancestor-or-equal of the intended branch
   * tip? `false` ⇒ the branch diverged / was rewritten. */
  intendedContainsStart: boolean;
  /** Is HEAD's current commit an ancestor-or-equal of the intended branch tip?
   * `true` ⇒ HEAD's work is already folded into the branch. */
  intendedContainsHead: boolean;
}

/**
 * Everything the classifier needs, gathered by the Runner. The recorded fields
 * (`intendedBranch`, `startCommit`, `expectedWorktreePath`) come from the
 * `run-start-state` fact (issue #149); the observed fields are read at settle.
 */
export interface BranchContractObservation {
  /** This Run — a delta is this Run's own owned move iff tagged to it. */
  runId: number;
  /** The branch the Run started on and must still be on (never `HEAD`). May be
   * short (`develop`) or fully-qualified (`refs/heads/develop`). */
  intendedBranch: string;
  /** The recorded start commit OID. */
  startCommit: string;
  /** The worktree the Run was expected to run in. */
  expectedWorktreePath: string;
  /** HEAD's symbolic branch now, or `null` when detached. Never `HEAD`. */
  headBranch: string | null;
  /** HEAD's current commit OID. */
  headCommit: string;
  /** The worktree HEAD is currently in. */
  worktreePath: string;
  /** Every ref mutation observed during the Run. */
  refDeltas: readonly RefDelta[];
  reachability: BranchReachability;
}

export type BranchClassification =
  | { outcome: 'clean' }
  | { outcome: 'recoverable'; reason: RecoveryReason; detail: string; deltas: readonly RefDelta[] }
  | { outcome: 'ambiguous'; reason: AmbiguityReason; detail: string; deltas: readonly RefDelta[] };

/** Strip a leading `refs/heads/` so a short and a fully-qualified branch compare equal. */
function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/**
 * Classify a Run's git outcome against the branch contract (reliability-design
 * Unit D). Pure and total: the same observation always yields the same verdict,
 * and it never throws. The rules are applied in strict precedence, so an
 * escalation-worthy signal always wins over a mere checkout deviation.
 */
export function classifyBranchOutcome(obs: BranchContractObservation): BranchClassification {
  // A delta is this Run's own owned move only when tagged to this Run. Every
  // other delta is one of two ambiguous kinds, reported distinctly so the
  // escalation evidence is precise: truly *unattributed* (Harmonic never moved
  // it) versus *foreign* (Harmonic moved it, but for a different Run).
  const unattributed = obs.refDeltas.filter((d) => d.attributedRunId === null);
  const foreign = obs.refDeltas.filter(
    (d) => d.attributedRunId !== null && d.attributedRunId !== obs.runId,
  );

  // R1 — owned-ref invariant. A ref move Harmonic never tagged is ambiguous:
  // Harmonic cannot deterministically reason about work it did not place (an
  // agent `checkout -b`, a stray branch, an external mutation). This is the more
  // basic contract break, so it outranks a foreign-Run move below.
  if (unattributed.length > 0) {
    return {
      outcome: 'ambiguous',
      reason: 'unattributed-ref-delta',
      detail: `${unattributed.length} ref delta(s) not attributed to any Run: ${unattributed
        .map((d) => d.ref)
        .join(', ')}`,
      deltas: unattributed,
    };
  }

  // R1b — a ref moved by a *different* Run. Attributed, but not to this Run, so
  // this Run's deterministic recovery may not fold it in.
  if (foreign.length > 0) {
    return {
      outcome: 'ambiguous',
      reason: 'foreign-ref-delta',
      detail: `${foreign.length} ref delta(s) attributed to a different Run than ${obs.runId}: ${foreign
        .map((d) => `${d.ref}@run-${d.attributedRunId}`)
        .join(', ')}`,
      deltas: foreign,
    };
  }

  // R2 — the recorded start OID must still be reachable from the intended
  // branch. If it is not, history was rewritten or the branch diverged, and the
  // recorded artifacts no longer describe the branch → escalate.
  if (!obs.reachability.intendedContainsStart) {
    const deltas = obs.refDeltas.filter((d) => branchName(d.ref) === branchName(obs.intendedBranch));
    return {
      outcome: 'ambiguous',
      reason: 'intended-branch-diverged',
      detail: `recorded start commit ${obs.startCommit} is not reachable from the intended branch ${obs.intendedBranch}`,
      deltas,
    };
  }

  // HEAD is "explained" when it sits on a commit Harmonic can name: the recorded
  // start commit, the tip of one of this Run's own owned refs, or a commit
  // already folded into the intended branch. A deleted owned ref (`to === null`)
  // has no tip HEAD could rest on, so it never explains HEAD.
  const ownedTips = new Set(
    obs.refDeltas
      .filter((d) => d.attributedRunId === obs.runId && d.to !== null)
      .map((d) => d.to as string),
  );
  const headExplained =
    obs.headCommit === obs.startCommit ||
    ownedTips.has(obs.headCommit) ||
    obs.reachability.intendedContainsHead;

  // R3 — HEAD parked on an unknown commit: not the start, not an owned tip, not
  // on the branch. Harmonic cannot deterministically place it → escalate.
  if (!headExplained) {
    return {
      outcome: 'ambiguous',
      reason: 'head-at-unknown-commit',
      detail: `HEAD is at ${obs.headCommit}, which is neither the recorded start, an owned ref tip, nor reachable from ${obs.intendedBranch}`,
      // No ref delta to attribute: the ambiguity is HEAD's position itself, not
      // a specific ref move (every observed delta was already attributed).
      deltas: [],
    };
  }

  const onIntended = obs.headBranch !== null && branchName(obs.headBranch) === branchName(obs.intendedBranch);
  const inExpectedWorktree = obs.worktreePath === obs.expectedWorktreePath;

  // R4 — contract held: HEAD still symbolic on the intended branch, in the
  // expected worktree. Any owned candidate ref off to the side is expected.
  if (onIntended && inExpectedWorktree) {
    return { outcome: 'clean' };
  }

  // R5 — deterministic recovery. Everything that moved is this Run's own, HEAD
  // is on a named commit, and the branch is intact; only the checkout is out of
  // place, which a re-checkout restores.
  if (obs.headBranch === null) {
    return {
      outcome: 'recoverable',
      reason: 'head-detached-on-owned-ref',
      detail: `HEAD is detached at ${obs.headCommit}; restore the checkout onto ${obs.intendedBranch}`,
      deltas: obs.refDeltas,
    };
  }
  if (!onIntended) {
    return {
      outcome: 'recoverable',
      reason: 'head-off-intended-branch',
      detail: `HEAD is on the attributed branch ${obs.headBranch}; re-point onto ${obs.intendedBranch}`,
      deltas: obs.refDeltas,
    };
  }
  return {
    outcome: 'recoverable',
    reason: 'worktree-relocated',
    detail: `HEAD is on ${obs.intendedBranch} but in worktree ${obs.worktreePath}, not the expected ${obs.expectedWorktreePath}`,
    deltas: obs.refDeltas,
  };
}
