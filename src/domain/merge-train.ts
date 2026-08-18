/**
 * Merge-train land decision (issue #160, parallel-epic tranche). Each Epic's
 * integration branch (`epic/<ref>`, built by #159) is a **single-writer merge
 * train**: ready Task members land onto it one at a time, each rebased onto
 * the current integration tip immediately before landing. This module is the
 * **pure** half of that land step — the same seam as `branch-recovery.ts`
 * (`evaluateReMergeResult`): no git I/O, no database, no clock. The
 * MergeTrainCoordinator gathers the observed git facts (does the integration
 * branch exist, is the member's tip already an ancestor of the integration
 * tip, what did the rebase attempt produce) and passes them in; this function
 * only classifies those facts into the action to execute.
 *
 * Idempotency matters here more than in a single-Task land: a crash or
 * re-submit mid-train must not re-land or fail loudly on a member that is
 * already folded into the integration branch, so `alreadyMerged` is checked
 * — and wins — before any rebase outcome is consulted.
 *
 * The `heal` → `escalate` pair on a rebase conflict mirrors the #155 bounded
 * agent re-merge contract: a conflicting rebase gets exactly **one** corrective
 * turn (`heal`), and if that turn's rebase still conflicts, the train escalates
 * rather than attempting a second mutating turn. `healAttempted` is the
 * caller's record of whether that one turn has already happened for this
 * member.
 */

/**
 * The git facts the decision needs, gathered by the MergeTrainCoordinator so
 * this module stays git-free.
 */
export interface MergeTrainGitFacts {
  /** Does the Epic's integration branch (`epic/<ref>`) exist? */
  integrationExists: boolean;
  /** memberTip is an ancestor-or-equal of integrationTip (already landed). */
  alreadyMerged: boolean;
  /** null only when short-circuited defensively; otherwise the observed rebase result. */
  rebase:
    | { status: 'clean'; rebasedTip: string }
    | { status: 'conflict'; detail: string }
    | null;
}

/**
 * The action the MergeTrainCoordinator must execute for this member's land
 * attempt.
 */
export type MergeTrainDecision =
  | { action: 'ff'; toOid: string }
  | { action: 'already-landed' }
  | { action: 'heal'; reason: string }
  | { action: 'escalate'; reason: string };

/**
 * Decide the merge-train land action for a single ready Task member against
 * its Epic's integration branch (issue #160). Pure and total: the same inputs
 * always yield the same decision, and it never throws. The rules are applied
 * in strict precedence:
 *
 *  1. the integration branch must exist — a missing branch means #159's
 *     lifecycle step never ran, which this module cannot fix → escalate;
 *  2. `alreadyMerged` wins over any rebase evaluation — the idempotent
 *     crash/re-submit path: a member already folded into the integration tip
 *     needs no further action regardless of what a stale/redundant rebase
 *     attempt produced;
 *  3. a clean rebase fast-forwards the integration branch to the rebased tip;
 *  4. a conflicting rebase gets exactly one corrective turn (`heal`) if none
 *     has been attempted yet for this member;
 *  5. a conflicting rebase that persists after that corrective turn escalates
 *     — the #155 "one turn then escalate, no second mutating turn" bound;
 *  6. no rebase observed at all, with the branch present and the member not
 *     already merged, is a defensive/total fallback — the caller should never
 *     reach this in practice, but the decision must still be total.
 */
export function decideMergeTrainLand(input: {
  facts: MergeTrainGitFacts;
  healAttempted: boolean;
}): MergeTrainDecision {
  const { facts, healAttempted } = input;

  if (!facts.integrationExists) {
    return { action: 'escalate', reason: 'integration branch missing' };
  }

  if (facts.alreadyMerged) {
    return { action: 'already-landed' };
  }

  if (facts.rebase?.status === 'clean') {
    return { action: 'ff', toOid: facts.rebase.rebasedTip };
  }

  if (facts.rebase?.status === 'conflict') {
    if (!healAttempted) {
      return { action: 'heal', reason: facts.rebase.detail };
    }
    return { action: 'escalate', reason: 'rebase still conflicts after corrective turn' };
  }

  return { action: 'escalate', reason: 'internal: rebase not observed' };
}
