import type { Attributes } from '@opentelemetry/api';
import type { VerificationCommand } from '../config.js';
import type { PostMergeCheckResult } from '../execution/merge-policy.js';
import { runCommandVerifier, type CommandAttempt, type CommandSpawn, type VerificationOutputLog } from './command-verifier.js';

/** Runs post-merge verify commands in order against a merged tree, stopping at the first non-pass. */
export async function runPostMergeCommands(args: {
  commands: readonly VerificationCommand[];
  cwd: string;
  mergeOid: string;
  commandSpawn: CommandSpawn;
  signal?: AbortSignal | undefined;
  attributes?: Attributes;
  /** Where the command's full uncapped output is archived, or null to skip. */
  outputLog: (command: VerificationCommand) => Promise<VerificationOutputLog | null>;
  onAttempt: (attempt: CommandAttempt, command: VerificationCommand) => Promise<void>;
}): Promise<PostMergeCheckResult> {
  for (const command of args.commands) {
    const attempt = await runCommandVerifier({
      outputLog: await args.outputLog(command),
      cwd: args.cwd,
      verifiedHeadOid: args.mergeOid,
      command,
      spawn: args.commandSpawn,
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.attributes ? { attributes: args.attributes } : {}),
    });
    await args.onAttempt(attempt, command);
    if (attempt.verdict !== 'pass') {
      return { pass: false, output: `${attempt.summary}\n${attempt.output}`.trim() };
    }
  }
  return { pass: true, output: '' };
}
