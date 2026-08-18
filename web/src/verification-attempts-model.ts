import { combineVerdicts } from './verification-model.js';
import type { VerifierVerdict, VerificationDecision } from './verification-model.js';
import type { VerificationAttempt } from './types.js';

/**
 * Pure model helpers over a Run's Verification-attempt log (issue #169, part
 * of #109). The log is append-only and `seq`-ordered — a Run's self-heal
 * retries append further attempts for the same `mechanism` rather than
 * replacing the earlier one, so "the current per-verifier verdict set" is a
 * derived view (the latest attempt per mechanism), not the raw list. These
 * helpers keep that derivation in one place so `VerificationCard` only maps
 * and renders (cf. `guardrail-trip-model.ts`'s pure-formatter house style).
 */

/**
 * The latest attempt per `mechanism` — the attempt set that currently governs
 * the Run's Verification outcome. "Latest" is the highest `seq`; the input is
 * expected to already arrive seq-ordered (the server serves it that way), but
 * this picks by max `seq` per mechanism rather than by array position, so it
 * stays correct even if that ever isn't true. Order in the result follows each
 * mechanism's first-seen position in `attempts` — stable across renders for a
 * log that only grows. Whole attempts (not just verdicts) so a caller can show
 * each verifier's verdict *and* its summary from one derivation. Pure: does not
 * mutate `attempts`.
 */
export function latestAttempts(attempts: VerificationAttempt[]): VerificationAttempt[] {
  const latestByMechanism = new Map<string, VerificationAttempt>();
  const order: string[] = [];
  for (const attempt of attempts) {
    const current = latestByMechanism.get(attempt.mechanism);
    if (!current) order.push(attempt.mechanism);
    if (!current || attempt.seq > current.seq) {
      latestByMechanism.set(attempt.mechanism, attempt);
    }
  }
  return order.map((mechanism) => latestByMechanism.get(mechanism)!);
}

/**
 * The latest attempt per `mechanism`, mapped to a {@link VerifierVerdict} —
 * the verdict set that currently governs the Run's Verification outcome. A
 * thin projection of {@link latestAttempts}. Pure.
 */
export function latestVerdicts(attempts: VerificationAttempt[]): VerifierVerdict[] {
  return latestAttempts(attempts).map((attempt) => ({
    verifier: attempt.mechanism,
    verdict: attempt.verdict,
  }));
}

/**
 * The Run's overall Verification outcome right now: {@link combineVerdicts}
 * folded over {@link latestVerdicts} — the current per-verifier verdicts, not
 * the full attempt history (an earlier failed attempt that a later retry
 * fixed no longer counts against the Run). Pure.
 */
export function overallDecision(attempts: VerificationAttempt[]): VerificationDecision {
  return combineVerdicts(latestVerdicts(attempts));
}

/**
 * The `summary` of the latest `critic` attempt, or `null` when the Run has no
 * critic attempt yet (no critic configured, or the Run hasn't reached
 * Verification). Pure.
 */
export function latestCriticSummary(attempts: VerificationAttempt[]): string | null {
  let latest: VerificationAttempt | null = null;
  for (const attempt of attempts) {
    if (attempt.mechanism !== 'critic') continue;
    if (!latest || attempt.seq > latest.seq) latest = attempt;
  }
  return latest?.summary ?? null;
}
