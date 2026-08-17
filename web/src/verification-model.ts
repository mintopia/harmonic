export type Verdict = 'pass' | 'fail' | 'inconclusive';

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

// "verifier X" / "verifiers X, Y" — singular/plural noun in front of the
// (ordered, as-given) list of names driving the decision.
function label(names: string[]): string {
  return `${names.length === 1 ? 'verifier' : 'verifiers'} ${names.join(', ')}`;
}

/**
 * Combine a Run's per-verifier verdicts into a single Verification outcome
 * (issue #133; ADR-0021 "A Verification gate (command and/or agent) replaces
 * the agent-review flag"; docs/reliability-design.md Unit B — Verification).
 *
 * Unit B runs a command and/or a critic agent against the frozen candidate
 * OID and combines their verdicts with a locked precedence — escalate > block
 * > proceed — because *inconclusive* must fail safe: ADR-0021 is explicit
 * that "inconclusive is treated as fail-safe (Escalate) — false-completing is
 * worse than an extra human look", and Unit B repeats that "only actionable
 * fails heal; inconclusive Escalates". That means an inconclusive verdict
 * outranks a fail verdict even when both are present in the same batch — a
 * fail alone drives the cheap, bounded self-heal loop (Aider/SWE-agent style
 * reflection), but self-heal is only safe to attempt when every verifier
 * gave an actionable answer. Mixing in an inconclusive verifier means the
 * batch as a whole cannot be trusted to characterize the candidate, so the
 * whole thing escalates rather than silently blocking (and heal-looping) on
 * the fail alone.
 *
 * - Any `inconclusive` verdict present → `escalate`.
 * - Else any `fail` verdict present → `block` (the heal-eligible outcome).
 * - Else, if every verdict is `pass` (including the empty set — "no verifiers
 *   configured") → `proceed`.
 * - Else a verdict outside the known `Verdict` union reached us at runtime (a
 *   server ahead of this bundle — version skew, cf. task-actions-model.ts).
 *   `proceed` would be the exact fail-unsafe direction this unit exists to
 *   prevent, so an unrecognized verdict `escalate`s rather than silently
 *   passing.
 *
 * Pure: does not mutate `verdicts`, has no side effects, and is total over
 * its input.
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

  // Neither pass/fail/inconclusive: an unrecognized verdict. Fail safe.
  return { outcome: 'escalate', reason: 'unrecognized verifier verdict; escalating fail-safe' };
}
