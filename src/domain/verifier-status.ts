import type { VerificationMechanism } from '../db/schema.js';
import type { ResolvedVerifiers } from './setting-override.js';
import type { Verdict } from '../verification/critic-schema.js';
import { RUN_PHASES, type RunPhase } from './run-phases.js';

/** The operator-facing state of one verifier category for a Run. */
export type VerifierStatusState = 'passed' | 'failed' | 'inconclusive' | 'skipped' | 'disabled' | 'unrunnable' | 'planned';

/** A read-time reconciliation of configured verifiers and their recorded attempts. */
export interface VerifierStatus {
  mechanism: VerificationMechanism;
  state: VerifierStatusState;
  /** Explains a non-verdict state; verdict states need no synthetic explanation. */
  reason: string | null;
  /** The ordered command plan (each label is `command` + args), gate-fail-fast in array order; `command` mechanism only, when at least one command is configured. */
  commands?: string[];
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
 * Before the Run reaches `verifying` a configured-but-unattempted verifier
 * reconciles as `planned` rather than `skipped` (ADR-0044, issue #345).
 */
export function verifierStatuses({
  verifiers,
  attempts,
  phase,
}: {
  verifiers: Pick<ResolvedVerifiers, 'commands' | 'review'>;
  attempts: readonly RecordedAttempt[];
  phase?: RunPhase | null;
}): VerifierStatus[] {
  const latestByMechanism = new Map<VerificationMechanism, RecordedAttempt>();
  for (const attempt of attempts) {
    const previous = latestByMechanism.get(attempt.mechanism);
    if (!previous || attempt.seq > previous.seq) latestByMechanism.set(attempt.mechanism, attempt);
  }

  // Before the run reaches the verifying phase, a configured verifier hasn't had
  // its chance yet: it is planned, not skipped. `phase` null (pre-feature runs) or
  // any attempt already recorded means we've reached verification — keep the
  // reconciled skipped/passed/failed meaning unchanged.
  const verificationPending =
    attempts.length === 0 && phase != null && RUN_PHASES.indexOf(phase) < RUN_PHASES.indexOf('verifying');
  const commandLabels = verifiers.commands.map((c) => [c.command, ...c.args].join(' ').trim());

  return mechanisms.map((mechanism) => {
    // The ordered command plan rides only on the `command` row, and only when
    // some command is configured — the invariant both non-disabled command
    // branches below share.
    const withCommands = (base: VerifierStatus): VerifierStatus =>
      mechanism === 'command' && commandLabels.length > 0 ? { ...base, commands: commandLabels } : base;

    const attempt = latestByMechanism.get(mechanism);
    if (attempt) return withCommands({ mechanism, state: verdictStates[attempt.verdict], reason: null });

    const configured = mechanism === 'command' ? verifiers.commands.length > 0 : verifiers.review.enabled;
    if (configured) {
      const state = verificationPending ? 'planned' : 'skipped';
      const reason =
        state === 'planned'
          ? 'Configured to run — the run has not reached verification yet.'
          : `No ${mechanism} verification attempt was recorded for this run.`;
      return withCommands({ mechanism, state, reason });
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
