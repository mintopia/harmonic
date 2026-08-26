/**
 * Merge-train land decision (issue #160, ADR-0024; freshness gate ADR-0041).
 * Each Epic's integration branch (`epic/<ref>`) is a **single-writer merge
 * train**: ready Task members land onto it one at a time. Rebasing is the
 * Attempt's Rebase Task, run and verified by the Runner *before* the member
 * is submitted; the train itself only asserts freshness and fast-forwards, so
 * what lands is exactly the tip verification inspected. This module is the
 * **pure** half of that land step — no git I/O, no database, no clock.
 *
 * Idempotency matters here more than in a single-Task land: a crash or
 * re-submit mid-train must not re-land or fail loudly on a member that is
 * already folded into the integration branch, so `alreadyMerged` is checked
 * — and wins — before any freshness check.
 */

export interface MergeTrainGitFacts {
  /** Does the Epic's integration branch (`epic/<ref>`) exist? */
  integrationExists: boolean;
  /** memberTip is an ancestor-or-equal of integrationTip (already landed). */
  alreadyMerged: boolean;
  /** The member branch's current tip. */
  memberTip: string;
  /** The tip verification recorded for this member. */
  verifiedTip: string;
  /** integrationTip is an ancestor-or-equal of memberTip: the fast-forward is
   * exactly the verified tree. */
  basedOnIntegrationTip: boolean;
}

export type MergeTrainDecision =
  | { action: 'ff'; toOid: string }
  | { action: 'already-landed' }
  /** The member must re-enter Rebase → Verification before it can land. */
  | { action: 'stale'; reason: string }
  | { action: 'escalate'; reason: string };

/**
 * Pure and total. Precedence: a missing integration branch escalates
 * (#159's lifecycle step never ran); `alreadyMerged` wins next (the idempotent
 * crash/re-submit path); a member whose tip moved off its verified tip, or
 * whose verified tip is not based on the current integration tip, is stale;
 * otherwise the integration branch fast-forwards to the verified tip.
 */
export function decideMergeTrainLand(facts: MergeTrainGitFacts): MergeTrainDecision {
  if (!facts.integrationExists) {
    return { action: 'escalate', reason: 'integration branch missing' };
  }
  if (facts.alreadyMerged) {
    return { action: 'already-landed' };
  }
  if (facts.memberTip !== facts.verifiedTip) {
    return { action: 'stale', reason: 'member branch moved after verification' };
  }
  if (!facts.basedOnIntegrationTip) {
    return { action: 'stale', reason: 'integration branch advanced after verification' };
  }
  return { action: 'ff', toOid: facts.verifiedTip };
}
