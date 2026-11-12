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
