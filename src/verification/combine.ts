import type { Verdict } from './critic-schema.js';

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
 * Combine per-verifier verdicts: any `inconclusive` → `escalate`; else any `fail` → `block`; else all `pass`
 * (including the empty set) → `proceed`; else `escalate`. Shared by `src` and `web` (imported directly by
 * `web/src/verification-attempts-model.ts`).
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
