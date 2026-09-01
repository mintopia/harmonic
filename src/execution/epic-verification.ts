import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommandVerifier } from '../verification/command-verifier.js';
import { combineVerdicts, type VerificationDecision, type VerifierVerdict } from '../verification/combine.js';
import type { ResolvedVerifiers } from '../domain/setting-override.js';

/**
 * Run a whole-Epic Verification against an integration branch's tip and fold the
 * verifiers' verdicts into a single decision. With no command configured the
 * verdict set is empty and {@link combineVerdicts} returns `proceed`.
 */
export async function verifyEpicIntegration(args: {
  /** The base repo owning the integration branch and object store. */
  repoDir: string;
  /** The integration branch tip OID to Verify. */
  verifiedHeadOid: string;
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
        verifiedHeadOid: args.verifiedHeadOid,
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
