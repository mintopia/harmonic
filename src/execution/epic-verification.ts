import { runCommandVerifier } from '../verification/command-verifier.js';
import { combineVerdicts, type VerificationDecision, type VerifierVerdict } from '../verification/combine.js';
import type { EpicVerificationStage } from '../config.js';

/** Executes one configured Epic critic against the checked-out integration tree. */
export type EpicCriticRunner = (args: {
  cwd: string;
  verifiedHeadOid: string;
  critic: EpicVerificationStage['critics'][number];
}) => Promise<VerifierVerdict & { summary?: string; output?: string }>;

/**
 * Run a whole-Epic Verification against an integration branch's tip and fold the
 * verifiers' verdicts into a single decision. With no command configured the
 * verdict set is empty and {@link combineVerdicts} returns `proceed`.
 */
export async function verifyEpicIntegration(args: {
  /** The existing checkout of `epic/<ref>` at the candidate revision. */
  worktreePath: string;
  /** The integration branch tip OID to Verify. */
  verifiedHeadOid: string;
  verifiers: EpicVerificationStage;
  /** Runs a configured critic in the same live Epic worktree as the commands. */
  runCritic: EpicCriticRunner;
  /** Cancellation, wired to server shutdown; an abort kills the verifier child. */
  signal?: AbortSignal;
}): Promise<VerificationDecision> {
  const verdicts: VerifierVerdict[] = [];

  for (const command of args.verifiers.commands) {
    const attempt = await runCommandVerifier({
      cwd: args.worktreePath,
      verifiedHeadOid: args.verifiedHeadOid,
      command,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    verdicts.push({ verifier: attempt.verifier, verdict: attempt.verdict });
    if (attempt.verdict !== 'pass') {
      const decision = combineVerdicts(verdicts);
      const feedback = [`Epic command (${attempt.verdict}): ${attempt.summary}`, attempt.output]
        .filter(Boolean)
        .join('\n');
      return { ...decision, reason: `${decision.reason}\n\n${feedback}` };
    }
  }

  const critics = await Promise.all(args.verifiers.critics.map((critic) => args.runCritic({
    cwd: args.worktreePath,
    verifiedHeadOid: args.verifiedHeadOid,
    critic,
  })));
  verdicts.push(...critics);

  const decision = combineVerdicts(verdicts);
  if (decision.outcome === 'proceed') return decision;

  const feedback = critics
    .map((critic, index) => [
      `Epic critic ${index + 1} (${critic.verdict}): ${critic.summary ?? ''}`,
      critic.output ?? '',
    ].filter(Boolean).join('\n'))
    .join('\n\n');
  return feedback ? { ...decision, reason: `${decision.reason}\n\n${feedback}` } : decision;
}
