import { combineVerdicts } from '../../src/verification/combine.js';
import type { VerifierVerdict, VerificationDecision } from '../../src/verification/combine.js';
import type { VerificationAttempt, VerificationMechanism, VerifierStatus } from './types.js';

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

/** Every verifier status paired with its latest recorded attempt, if it ran. */
export function verificationRows(
  statuses: VerifierStatus[],
  attempts: VerificationAttempt[],
): { status: VerifierStatus; attempt: VerificationAttempt | undefined }[] {
  const latestByMechanism = new Map(latestAttempts(attempts).map((attempt) => [attempt.mechanism, attempt]));
  return statuses.map((status) => ({ status, attempt: latestByMechanism.get(status.mechanism) }));
}

/**
 * Why a critic's native session transcript isn't showing, driven by
 * the verifier status — not a bare "unavailable". `null` when a transcript
 * is present (nothing to explain). Distinguishes: the verifier is disabled for
 * this workspace; the critic never ran (skipped / no attempt); or it ran but
 * its log wasn't captured. Pure — testable without a DOM.
 */
export function criticUnavailableReason(
  state: VerifierStatus['state'],
  hasAttempt: boolean,
  hasTranscript: boolean,
): string | null {
  if (hasTranscript) return null;
  if (state === 'disabled') return 'Critic disabled for this workspace.';
  if (state === 'unrunnable') return 'Review is enabled but resolves to no model — it cannot run.';
  if (!hasAttempt) return 'Critic did not run.';
  return 'Critic session log was not captured.';
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

/** One `mechanism`'s attempts, seq-ordered and numbered from 1 within that
 * mechanism alone (`attemptNumber`) — the mechanism's own retry count, not
 * the attempt's position in the interleaved log. `isSelfHeal` is
 * `attemptNumber > 1`: the first attempt for a mechanism is its original run
 * against the candidate; every attempt after it is a self-heal retry the
 * same mechanism made against a later candidate. */
export interface AttemptGroup {
  mechanism: VerificationMechanism;
  attempts: (VerificationAttempt & { attemptNumber: number; isSelfHeal: boolean })[];
}

/**
 * Groups a Run's attempt log by `mechanism` so a self-heal
 * retry renders under its mechanism as "attempt N of M", not as an
 * unrelated row in a flat seq-ordered list — the log carries no
 * attempt-number or heal flag of its own (self-heal retries are just
 * further attempts for the same `mechanism` at a higher `seq`), so this is
 * where that structure gets derived. Each group's attempts are seq-ordered
 * and numbered from 1; groups themselves are ordered by each mechanism's
 * first-seen `seq`, the same first-seen ordering {@link latestAttempts} uses
 * — stable across renders for a log that only grows. Pure: does not mutate
 * `attempts`.
 */
export function groupAttemptsByMechanism(attempts: VerificationAttempt[]): AttemptGroup[] {
  const bySeq = [...attempts].sort((a, b) => a.seq - b.seq);
  const order: VerificationMechanism[] = [];
  const byMechanism = new Map<VerificationMechanism, VerificationAttempt[]>();
  for (const attempt of bySeq) {
    let group = byMechanism.get(attempt.mechanism);
    if (!group) {
      group = [];
      byMechanism.set(attempt.mechanism, group);
      order.push(attempt.mechanism);
    }
    group.push(attempt);
  }
  return order.map((mechanism) => ({
    mechanism,
    attempts: byMechanism.get(mechanism)!.map((attempt, index) => ({
      ...attempt,
      attemptNumber: index + 1,
      isSelfHeal: index > 0,
    })),
  }));
}
