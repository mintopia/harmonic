import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommandVerifier } from '../verification/command-verifier.js';
import { combineVerdicts, type VerificationDecision, type VerifierVerdict } from '../verification/combine.js';
import type { ResolvedVerifiers } from '../domain/setting-override.js';

/**
 * Run a whole-Epic Verification against an integration branch's tip and fold the
 * verifiers' verdicts into a single decision (issue #161). The concrete
 * {@link EpicVerify} implementation the {@link EpicIntegrateCoordinator} injects.
 *
 * The command verifier (#135) is branch-agnostic — it checks a candidate OID out
 * into a disposable detached worktree and runs the configured command there — so
 * the whole-Epic Verification is the *same* primitive pointed at the integration
 * branch's tip OID instead of a single Run's frozen candidate. The union of every
 * member's work can break even when each member passed alone, which is exactly
 * what this catches before the atomic integrate.
 *
 * `resolveVerifiers` is workspace-scoped, so the same config applies at Epic
 * scope. With no command configured the verdict set is empty and
 * {@link combineVerdicts} returns `proceed` ("no verifiers configured") — an Epic
 * with no Verification integrates once its members complete, exactly as an unverified
 * Run merges today. The agent critic (#136) plugs in here as a second verdict
 * feeding the same combination, the same way the per-Run path (runner.ts) plans
 * it; today, like that path, only the command verifier is wired.
 */
export async function verifyEpicIntegration(args: {
  /** The base repo owning the integration branch and object store. */
  repoDir: string;
  /** The integration branch tip OID to Verify. */
  candidateOid: string;
  verifiers: ResolvedVerifiers;
  /** Cancellation, wired to server shutdown; an abort kills the verifier child. */
  signal?: AbortSignal;
  /** Parent dir for the disposable verification worktree; defaults to the OS temp dir. */
  worktreeParent?: string;
}): Promise<VerificationDecision> {
  const verdicts: VerifierVerdict[] = [];

  for (const [index, command] of args.verifiers.commands.entries()) {
    const parent = mkdtempSync(join(args.worktreeParent ?? tmpdir(), 'harmonic-epic-verify-'));
    try {
      const attempt = await runCommandVerifier({
        repoDir: args.repoDir,
        candidateOid: args.candidateOid,
        worktreePath: join(parent, `command-${index}`),
        command,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      verdicts.push({ verifier: 'command', verdict: attempt.verdict });
      if (attempt.verdict !== 'pass') break;
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }

  return combineVerdicts(verdicts);
}
