import { STEP_TYPES, type StepType, type VerificationMechanism } from '../db/schema.js';
import type { TaskVerificationStage, EpicVerificationStage } from '../config.js';
import type { Verdict } from '../verification/critic-schema.js';

/** The operator-facing state of one verifier category for an Attempt. */
export type VerifierStatusState = 'passed' | 'failed' | 'inconclusive' | 'skipped' | 'disabled' | 'unrunnable' | 'planned' | 'running';

/** A read-time reconciliation of configured verifiers and their recorded attempts. */
export interface VerifierStatus {
  mechanism: VerificationMechanism;
  verifier?: string;
  state: VerifierStatusState;
  /** Explains a non-verdict state; verdict states need no synthetic explanation. */
  reason: string | null;
  /** The ordered command plan (each label is `command` + args), gate-fail-fast in array order; `command` mechanism only, when at least one command is configured. */
  commands?: string[];
  /** The resolved review harness that will drive the critic; `critic` mechanism
   * only, when a harness resolves. Lets the live view name the reviewing harness
   * before the persisted attempt row exists. */
  harness?: string | null;
}

type RecordedAttempt = Pick<{ mechanism: VerificationMechanism; seq: number; verdict: Verdict }, 'mechanism' | 'seq' | 'verdict'>;

const mechanisms: readonly VerificationMechanism[] = ['command', 'critic'];

const verdictStates: Record<Verdict, Extract<VerifierStatusState, 'passed' | 'failed' | 'inconclusive'>> = {
  pass: 'passed',
  fail: 'failed',
  inconclusive: 'inconclusive',
};

/**
 * Build the always-visible verification read model. Commands reconcile as one
 * category even when more than one is configured (attempts persist only the
 * mechanism). Current Workspace settings decide whether a missing category is
 * skipped or disabled; before the Attempt reaches its Verification Step a
 * configured-but-unattempted verifier is `planned` rather than `skipped`.
 */
export function verifierStatuses({
  verifiers,
  attempts,
  stepType,
}: {
  verifiers: TaskVerificationStage | EpicVerificationStage;
  attempts: readonly RecordedAttempt[];
  /** The Attempt's currently-running Step, or the most recent one; `null` when none has started or is running. */
  stepType?: StepType | null;
}): VerifierStatus[] {
  const latestByMechanism = new Map<VerificationMechanism, RecordedAttempt>();
  for (const attempt of attempts) {
    const previous = latestByMechanism.get(attempt.mechanism);
    if (!previous || attempt.seq > previous.seq) latestByMechanism.set(attempt.mechanism, attempt);
  }

  const commandLabels = verifiers.commands.map((c) => [c.command, ...c.args].join(' ').trim());
  const criticHarness = verifiers.critics[0]?.harness ?? null;

  if (verifiers.commands.length > 1 || verifiers.critics.length > 1) {
    const attemptsFor = (mechanism: VerificationMechanism) => attempts.filter((attempt) => attempt.mechanism === mechanism).sort((a, b) => a.seq - b.seq);
    return [
      ...verifiers.commands.map((_, index): VerifierStatus => {
        const attempt = attemptsFor('command')[index];
        if (attempt) return { mechanism: 'command', verifier: `command:${index}`, state: verdictStates[attempt.verdict], reason: null, commands: [commandLabels[index]!] };
        const pending = stepType == null ? attempts.length === 0 : STEP_TYPES.indexOf(stepType) < STEP_TYPES.indexOf('verification');
        return {
          mechanism: 'command', verifier: `command:${index}`,
          state: stepType === 'verification' ? 'running' : pending ? 'planned' : 'skipped',
          reason: stepType === 'verification' ? 'Running the command check now.' : pending ? 'Configured to run — the attempt has not reached verification yet.' : 'No command verification attempt was recorded for this attempt.',
          commands: [commandLabels[index]!],
        };
      }),
      ...verifiers.critics.map((critic, index): VerifierStatus => {
        const attempt = attemptsFor('critic')[index];
        if (attempt) return { mechanism: 'critic', verifier: `critic:${index}`, state: verdictStates[attempt.verdict], reason: null, ...(critic.harness ? { harness: critic.harness } : {}) };
        const pending = stepType == null ? attempts.length === 0 : STEP_TYPES.indexOf(stepType) < STEP_TYPES.indexOf('review');
        return {
          mechanism: 'critic', verifier: `critic:${index}`,
          state: stepType === 'review' ? 'running' : pending ? 'planned' : 'skipped',
          reason: stepType === 'review' ? 'The critic is reviewing the candidate now.' : pending ? 'Configured to run — the attempt has not reached verification yet.' : 'No critic verification attempt was recorded for this attempt.',
          ...(critic.harness ? { harness: critic.harness } : {}),
        };
      }),
    ];
  }

  return mechanisms.map((mechanism) => {
    const decorate = (base: VerifierStatus): VerifierStatus =>
      mechanism === 'command' && commandLabels.length > 0
        ? { ...base, commands: commandLabels }
        : mechanism === 'critic' && criticHarness
          ? { ...base, harness: criticHarness }
          : base;

    const attempt = latestByMechanism.get(mechanism);
    if (attempt) return decorate({ mechanism, state: verdictStates[attempt.verdict], reason: null });

    const configured = mechanism === 'command' ? verifiers.commands.length > 0 : verifiers.critics.length > 0;
    if (configured) {
      // The verifier's own Step is live: it is running now. Before that Step, a
      // configured verifier hasn't had its chance yet — planned, not skipped
      // (`stepType` null with no attempt at all is the same no-evidence case).
      // Past it, or once verification is over, with nothing recorded: skipped.
      const ownStep: StepType = mechanism === 'command' ? 'verification' : 'review';
      if (stepType === ownStep) {
        return decorate({ mechanism, state: 'running', reason: mechanism === 'command' ? 'Running the command checks now.' : 'The critic is reviewing the candidate now.' });
      }
      const pending = stepType == null ? attempts.length === 0 : STEP_TYPES.indexOf(stepType) < STEP_TYPES.indexOf(ownStep);
      const state = pending ? 'planned' : 'skipped';
      const reason =
        state === 'planned'
          ? 'Configured to run — the attempt has not reached verification yet.'
          : `No ${mechanism} verification attempt was recorded for this attempt.`;
      return decorate({ mechanism, state, reason });
    }
    return {
      mechanism,
      state: 'disabled',
      reason: mechanism === 'command' ? 'No command verifier is configured.' : 'Critic verification is disabled.',
    };
  });
}
