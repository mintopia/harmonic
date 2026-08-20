import type { Verdict } from './critic-schema.js';

/**
 * The verdict-combination pure function (issue #133), src-side copy.
 *
 * The canonical implementation lives in `web/src/verification-model.ts` for the
 * board/API to import. `src` cannot import from `web/src` (`rootDir: "src"`),
 * so — exactly like `critic-schema.ts` duplicates the {@link Verdict} alphabet —
 * this is a separate, structurally-identical copy the Runner (`src/execution`)
 * can consume when it folds a Run's per-verifier verdicts into a single
 * Verification outcome. `tests/verification-combine-parity.test.ts` runs under
 * `tsconfig.test.json` (which spans both trees) and asserts the two stay in
 * lock-step, so the copy can never silently drift from the canonical one.
 *
 * See the web module for the full rationale of the locked precedence
 * (escalate > block > proceed) and why `inconclusive` outranks `fail`.
 */

export type VerificationOutcome = 'proceed' | 'block' | 'escalate';

export interface VerifierVerdict {
  verifier: string;
  verdict: Verdict;
}

export interface VerificationDecision {
  outcome: VerificationOutcome;
  reason: string;
}

function namesWith(verdicts: VerifierVerdict[], verdict: Verdict): string[] {
  const names: string[] = [];
  for (const v of verdicts) {
    if (v.verdict === verdict) names.push(v.verifier);
  }
  return names;
}

function label(names: string[]): string {
  return `${names.length === 1 ? 'verifier' : 'verifiers'} ${names.join(', ')}`;
}

/**
 * Combine a Run's per-verifier verdicts into a single Verification outcome
 * (issue #133; ADR-0021; docs/reliability-design.md Unit B). Kept byte-for-byte
 * behaviourally identical to `web/src/verification-model.ts`'s `combineVerdicts`
 * — the parity test enforces it.
 *
 * - Any `inconclusive` verdict present → `escalate` (fail-safe).
 * - Else any `fail` verdict present → `block` (the heal-eligible outcome).
 * - Else, if every verdict is `pass` (including the empty set) → `proceed`.
 * - Else an unrecognized verdict reached us → `escalate` (fail-safe).
 *
 * Pure: does not mutate `verdicts`, has no side effects, total over its input.
 */
export function combineVerdicts(verdicts: VerifierVerdict[]): VerificationDecision {
  const inconclusive = namesWith(verdicts, 'inconclusive');
  if (inconclusive.length > 0) {
    return { outcome: 'escalate', reason: `${label(inconclusive)} inconclusive` };
  }

  const failed = namesWith(verdicts, 'fail');
  if (failed.length > 0) {
    return { outcome: 'block', reason: `${label(failed)} failed` };
  }

  const passed = namesWith(verdicts, 'pass');
  if (passed.length === verdicts.length) {
    if (verdicts.length === 0) {
      return { outcome: 'proceed', reason: 'no verifiers configured' };
    }
    return {
      outcome: 'proceed',
      reason: `all ${verdicts.length} ${verdicts.length === 1 ? 'verifier' : 'verifiers'} passed`,
    };
  }

  return { outcome: 'escalate', reason: 'unrecognized verifier verdict; escalating fail-safe' };
}

/**
 * What an escalated Task's Note-to-critic re-verification (issue #191) does
 * with a re-folded {@link VerificationDecision}: `proceed` parks the Task at
 * `awaiting-review` for the human accept/reject gate; anything else (`block`
 * or `escalate`) leaves the Task escalated — the appended attempt is the only
 * operator-visible change. A human note can steer the critic's *attention*,
 * never force a pass: only a genuine `proceed` decision reaches `park-review`
 * here, and this never auto-lands (the human accept gate still applies).
 * Pure, total over its input.
 */
export function dispositionAfterNote(decision: VerificationDecision): 'park-review' | 'stay-escalated' {
  return decision.outcome === 'proceed' ? 'park-review' : 'stay-escalated';
}
