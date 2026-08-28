import type { VerificationMechanism } from '../db/schema.js';
import type { ResolvedVerifiers } from './setting-override.js';
import type { Verdict } from '../verification/critic-schema.js';

/** The operator-facing state of one verifier category for a Run. */
export type VerifierStatusState = 'passed' | 'failed' | 'inconclusive' | 'skipped' | 'disabled' | 'unrunnable';

/** A read-time reconciliation of configured verifiers and their recorded attempts. */
export interface VerifierStatus {
  mechanism: VerificationMechanism;
  state: VerifierStatusState;
  /** Explains a non-verdict state; verdict states need no synthetic explanation. */
  reason: string | null;
}

type RecordedAttempt = Pick<{ mechanism: VerificationMechanism; seq: number; verdict: Verdict }, 'mechanism' | 'seq' | 'verdict'>;

const mechanisms: readonly VerificationMechanism[] = ['command', 'critic'];

const verdictStates: Record<Verdict, Extract<VerifierStatusState, 'passed' | 'failed' | 'inconclusive'>> = {
  pass: 'passed',
  fail: 'failed',
  inconclusive: 'inconclusive',
};

/**
 * Build the always-visible verification read model (ADR-0042, issue #327).
 *
 * Verification attempts persist their mechanism but not a configured command
 * identity, so commands deliberately reconcile as one category even when more
 * than one command is configured. This is read-time best effort: current
 * Workspace settings decide whether a missing category is skipped or disabled.
 */
export function verifierStatuses({
  verifiers,
  attempts,
}: {
  verifiers: Pick<ResolvedVerifiers, 'commands' | 'review'>;
  attempts: readonly RecordedAttempt[];
}): VerifierStatus[] {
  const latestByMechanism = new Map<VerificationMechanism, RecordedAttempt>();
  for (const attempt of attempts) {
    const previous = latestByMechanism.get(attempt.mechanism);
    if (!previous || attempt.seq > previous.seq) latestByMechanism.set(attempt.mechanism, attempt);
  }

  return mechanisms.map((mechanism) => {
    const attempt = latestByMechanism.get(mechanism);
    if (attempt) return { mechanism, state: verdictStates[attempt.verdict], reason: null };

    const configured = mechanism === 'command' ? verifiers.commands.length > 0 : verifiers.review.enabled;
    if (configured) {
      return {
        mechanism,
        state: 'skipped',
        reason: `No ${mechanism} verification attempt was recorded for this run.`,
      };
    }
    // The critic has a third case commands don't: toggled on but unrunnable —
    // `reviewEnabled` resolved true yet no prompt/model resolved, so it was never
    // going to run (ADR-0044 §F, issue #340). Distinct from plain 'disabled' so the
    // operator sees the stuck toggle instead of a silent no-op.
    if (mechanism === 'critic' && verifiers.review.requested) {
      return {
        mechanism,
        state: 'unrunnable',
        reason: 'Review is enabled but resolves to no model, so it cannot run. Set a review model or turn review off.',
      };
    }
    return {
      mechanism,
      state: 'disabled',
      reason: mechanism === 'command' ? 'No command verifier is configured.' : 'Critic verification is disabled.',
    };
  });
}
