import type { TaskRow } from '../db/schema.js';
import type { VerificationDecision } from '../verification/combine.js';

/**
 * A single member's merge state, reduced by the coordinator from the member's
 * mirrored Task:
 *  - `completed` — the member merged onto the integration branch (Task state
 *    `completed`);
 *  - `blocked` — the member cannot merge (escalated to a human, or its Task is
 *    `failed`/`cancelled`); it holds the whole Epic back;
 *  - `pending` — anything else (still running, not yet started, awaiting review,
 *    or no mirrored Task at all): the Epic is not ready to integrate yet.
 */
export type MemberMergeState = 'completed' | 'blocked' | 'pending';

/** Reduce a member's mirrored Task to its {@link MemberMergeState}; a missing Task is `pending`. */
export function reduceMemberState(task: TaskRow | undefined): MemberMergeState {
  if (!task) return 'pending';
  if (task.state === 'done') return 'completed';
  if (task.state === 'escalated' || task.state === 'cancelled') return 'blocked';
  return 'pending';
}

/** The facts the whole-Epic integrate decision needs, gathered by the coordinator. */
export interface EpicIntegrateFacts {
  /** Does the Epic's integration branch (`epic/<ref>`) still exist? A retired
   * branch (a completed integrate) or one that was never cut means nothing to integrate. */
  integrationExists: boolean;
  /** Each member's reduced merge state (order irrelevant). */
  members: MemberMergeState[];
  /** The whole-Epic Verification outcome, or `null` when it has not been run yet
   * this attempt — the coordinator runs it when the decision says `verify`, then
   * re-decides with the result folded in (a two-pass gate: decide `verify`, run
   * it, decide again). */
  verification: VerificationDecision | null;
  /** Every member is a direct-isolation Task: the Epic completes in place on
   * its base branch instead of merging one, whether or not a leftover
   * `epic/<ref>` still exists (direct mode never isolates and never merges).
   * Takes precedence over `integrationExists`. */
  inPlace: boolean;
}

/** The action the coordinator must execute for this Epic's integrate attempt. */
export type EpicIntegrateDecision =
  /** Nothing to integrate — no integration branch (already integrated/retired, or never
   * cut), or an Epic with no members. */
  | { action: 'noop'; reason: string }
  /** Members are still in progress; wait for the next poll. */
  | { action: 'wait'; reason: string }
  /** A member cannot merge (escalated/failed): the whole Epic is held back until it clears. */
  | { action: 'blocked'; reason: string }
  /** The gate is satisfied (all members completed): run a whole-Epic
   * Verification against the integration branch, then re-decide. */
  | { action: 'verify'; reason: string }
  /** Verification passed: merge the integration branch into the default branch
   * and retire it. */
  | { action: 'integrate'; reason: string }
  /** Verification failed/inconclusive on the integrated whole: block the integrate
   * and escalate, fail-safe. */
  | { action: 'escalate'; reason: string }
  /** An in-place Epic (every member direct, no Integration branch) with every
   * member completed: settle it in place, no merge. */
  | { action: 'complete'; reason: string };

/**
 * Decide the whole-Epic integrate action. Precedence:
 *
 *  1. in-place (every member direct) → the member gate (no members → `noop`;
 *     any `blocked` → `blocked`; any `pending` → `wait`; else `complete`),
 *     regardless of `integrationExists` — a leftover `epic/<ref>` from before
 *     an Epic went (or stayed) direct is never merged, never refreshed, never
 *     deleted;
 *  2. not in-place, no integration branch → `noop`;
 *  3. no members → `noop`; any `blocked` member → `blocked`; any `pending`
 *     member → `wait`; else the gate opens;
 *  4. gate open, Verification not yet run → `verify`;
 *  5. gate open, Verification `proceed` → `integrate`; any other outcome →
 *     `escalate`, fail-safe.
 */
export function decideEpicIntegrate(facts: EpicIntegrateFacts): EpicIntegrateDecision {
  if (facts.inPlace) {
    if (facts.members.length === 0) {
      return { action: 'noop', reason: 'epic has no members to integrate' };
    }
    if (facts.members.some((m) => m === 'blocked')) {
      return { action: 'blocked', reason: 'a member cannot merge; the whole Epic is held back until it clears' };
    }
    if (facts.members.some((m) => m === 'pending')) {
      return { action: 'wait', reason: 'members are still in progress' };
    }
    return { action: 'complete', reason: 'all direct members are done: completing the Epic in place' };
  }

  if (!facts.integrationExists) {
    return { action: 'noop', reason: 'no integration branch to integrate (already integrated, retired, or never cut)' };
  }

  if (facts.members.length === 0) {
    return { action: 'noop', reason: 'epic has no members to integrate' };
  }
  if (facts.members.some((m) => m === 'blocked')) {
    return { action: 'blocked', reason: 'a member cannot merge; the whole Epic is held back until it clears' };
  }
  if (facts.members.some((m) => m === 'pending')) {
    return { action: 'wait', reason: 'members are still in progress' };
  }

  if (facts.verification === null) {
    return { action: 'verify', reason: 'all members completed: verifying the integrated whole' };
  }

  if (facts.verification.outcome === 'proceed') {
    return { action: 'integrate', reason: facts.verification.reason };
  }

  return { action: 'escalate', reason: `whole-Epic verification did not pass: ${facts.verification.reason}` };
}
