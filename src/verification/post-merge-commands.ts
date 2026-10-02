import type { Attributes } from '@opentelemetry/api';
import type { VerificationCommand } from '../config.js';
import type { PostMergeCheckResult } from '../execution/merge-policy.js';
import { runCommandVerifier, splitFullOutputPath, type CommandAttempt } from './command-verifier.js';

/** Runs post-merge verify commands in order against a merged tree, stopping at the first non-pass. */
export async function runPostMergeCommands(args: {
  commands: readonly VerificationCommand[];
  cwd: string;
  mergeOid: string;
  signal?: AbortSignal | undefined;
  attributes?: Attributes;
  /** Where the command's full uncapped output is archived, or null to skip. */
  outputLogPath: (command: VerificationCommand) => Promise<string | null>;
  onAttempt: (attempt: CommandAttempt, command: VerificationCommand) => Promise<void>;
}): Promise<PostMergeCheckResult> {
  for (const command of args.commands) {
    const attempt = await runCommandVerifier({
      outputLogPath: await args.outputLogPath(command),
      cwd: args.cwd,
      verifiedHeadOid: args.mergeOid,
      command,
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.attributes ? { attributes: args.attributes } : {}),
    });
    await args.onAttempt(attempt, command);
    if (attempt.verdict !== 'pass') {
      return { pass: false, output: withoutArchivePath(`${attempt.summary}\n${attempt.output}`.trim()) };
    }
  }
  return { pass: true, output: '' };
}

function withoutArchivePath(output: string): string {
  return splitFullOutputPath(output).output;
}
