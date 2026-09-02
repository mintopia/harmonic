import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Attributes, SpanContext } from '@opentelemetry/api';
import type { VerificationCommand } from '../config.js';
import { withDetachedWorktree } from '../execution/detached-worktree.js';
import { startOperation } from '../telemetry/operations.js';
import type { Verdict } from './critic-schema.js';
import type { VerificationAttemptInput } from '../domain/verification-attempts.js';

/** The verdict a command run produced, plus the captured output and the candidate OID. */
export interface CommandAttempt {
  verifier: 'command';
  verdict: Verdict;
  summary: string;
  /** Combined stdout+stderr, capped at {@link OUTPUT_CHAR_CAP}. */
  output: string;
  /** The candidate OID this attempt verified. */
  inputOid: string;
}

/** Combined stdout+stderr past this many characters is truncated. */
export const OUTPUT_CHAR_CAP = 200_000;

/** What one spawn resolved to; exactly one failure flag is set, or none (a clean `code`). */
export interface CommandSpawnResult {
  /** The child could not be spawned at all (missing command, EACCES). */
  spawnError?: Error | undefined;
  /** The command overran its timeout and was killed. */
  timedOut?: boolean | undefined;
  /** The run was cancelled via its `AbortSignal` and the child was killed. */
  aborted?: boolean | undefined;
  /** Process exit code, or `null` when it never exited cleanly (killed/signal). */
  code: number | null;
  /** Signal that killed the process, when there was no exit code. */
  signal: NodeJS.Signals | null;
  /** Combined stdout+stderr, already capped by the spawner. */
  output: string;
}

export interface CommandSpawnRequest {
  command: VerificationCommand;
  /** Absolute working directory the command runs in (candidate checkout root,
   * plus the command's optional relative `cwd`). */
  cwd: string;
  timeoutMs: number;
  outputCap: number;
  /** Each stdout/stderr chunk as it arrives, for a live progress view. */
  onOutput?: (chunk: string) => void;
  /** Cancellation: an abort kills the child (mirrors the timeout kill). */
  signal?: AbortSignal | undefined;
}

/** The injectable seam between {@link runCommandVerifier} and a real child process. */
export interface CommandSpawn {
  run(req: CommandSpawnRequest): Promise<CommandSpawnResult>;
}

/** Exec the configured argv (never a shell string); never rejects — a spawn failure resolves with `spawnError` set. */
export function createChildProcessSpawn(): CommandSpawn {
  return {
    run(req: CommandSpawnRequest): Promise<CommandSpawnResult> {
      return new Promise<CommandSpawnResult>((resolve) => {
        const env: NodeJS.ProcessEnv = { ...process.env, ...req.command.env };
        delete env.HARMONIC_API_KEY;
        delete env.HARMONIC_MCP_URL;

        let output = '';
        let capped = false;
        const append = (chunk: string): void => {
          req.onOutput?.(chunk);
          if (capped) return;
          output += chunk;
          if (output.length > req.outputCap) {
            output = output.slice(0, req.outputCap);
            capped = true;
          }
        };

        let timedOut = false;
        let aborted = false;
        let settled = false;

        const child = spawn(req.command.command, req.command.args, {
          cwd: req.cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const kill = (): void => {
          try {
            if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
          } catch {
          }
        };

        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, req.timeoutMs);

        const onAbort = (): void => {
          aborted = true;
          kill();
        };
        if (req.signal) {
          if (req.signal.aborted) onAbort();
          else req.signal.addEventListener('abort', onAbort, { once: true });
        }

        const finish = (result: CommandSpawnResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', append);
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', append);

        // node emits 'error' (ENOENT/EACCES) before 'close' for an unspawnable command; `finish` is idempotent so the later 'close' is ignored.
        child.on('error', (err) => finish({ spawnError: err, code: null, signal: null, output }));
        child.on('close', (code, signal) => finish({ timedOut, aborted, code, signal, output }));
      });
    },
  };
}

/**
 * The exit-code → verdict table:
 *
 * | Command result                              | Verdict      |
 * | ------------------------------------------- | ------------ |
 * | exit code 0                                 | pass         |
 * | exit code non-zero (1–255)                  | fail         |
 * | spawn error (missing command / EACCES)      | inconclusive |
 * | timeout (killed after `timeoutSeconds`)     | inconclusive |
 * | cancelled (AbortSignal)                     | inconclusive |
 * | killed by signal / no exit code             | inconclusive |
 */
export function exitCodeToVerdict(r: CommandSpawnResult): { verdict: Verdict; summary: string } {
  if (r.spawnError) {
    return { verdict: 'inconclusive', summary: `command could not be spawned: ${r.spawnError.message}` };
  }
  if (r.timedOut) return { verdict: 'inconclusive', summary: 'command timed out' };
  if (r.aborted) return { verdict: 'inconclusive', summary: 'command cancelled' };
  if (r.code === 0) return { verdict: 'pass', summary: 'command exited 0' };
  if (r.code !== null) return { verdict: 'fail', summary: `command exited ${r.code}` };
  return { verdict: 'inconclusive', summary: `command terminated by signal ${r.signal ?? 'unknown'}` };
}

export interface RunCommandVerifierArgs {
  /** The base repo owning the candidate ref and object store. */
  repoDir: string;
  /** The fixed commit the command verifies. */
  verifiedHeadOid: string;
  /** Where to check out the disposable detached worktree for this attempt. */
  worktreePath: string;
  command: VerificationCommand;
  /** Cancellation, wired to Runner shutdown; an abort kills the command child. */
  signal?: AbortSignal;
  /** Injectable spawn seam; defaults to {@link createChildProcessSpawn}. */
  spawn?: CommandSpawn;
  /** Override the hard timeout (tests); defaults to `command.timeoutSeconds`. */
  timeoutMs?: number;
  parent?: SpanContext;
  attributes?: Attributes;
  /** Each output chunk as the command produces it, for a live progress view. */
  onOutput?: (chunk: string) => void;
}

/** Run the command verifier against a candidate OID in a disposable detached worktree and resolve a {@link CommandAttempt}. Never throws for a verdict outcome; a worktree setup failure folds into `inconclusive`. */
export async function runCommandVerifier(args: RunCommandVerifierArgs): Promise<CommandAttempt> {
  const operation = args.parent
    ? startOperation({ type: 'verify.command', parent: args.parent, attributes: { 'verification.mechanism': 'command', ...args.attributes } })
    : undefined;
  try {
    const attempt = operation
      ? await operation.run(() => runCommandVerifierUnchecked(args))
      : await runCommandVerifierUnchecked(args);
    operation?.update({ 'verification.verdict': attempt.verdict });
    if (attempt.verdict === 'pass') operation?.end();
    else operation?.fail(attempt.summary);
    return attempt;
  } catch (error) {
    operation?.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function runCommandVerifierUnchecked(args: RunCommandVerifierArgs): Promise<CommandAttempt> {
  const spawner = args.spawn ?? createChildProcessSpawn();
  const timeoutMs = args.timeoutMs ?? args.command.timeoutSeconds * 1000;

  let verdict: Verdict = 'inconclusive';
  let summary = '';
  let output = '';

  try {
    await withDetachedWorktree(args.repoDir, args.verifiedHeadOid, args.worktreePath, async (dir) => {
      const cwd = args.command.cwd ? join(dir, args.command.cwd) : dir;
      const result = await spawner.run({
        command: args.command,
        cwd,
        timeoutMs,
        outputCap: OUTPUT_CHAR_CAP,
        signal: args.signal,
        ...(args.onOutput ? { onOutput: args.onOutput } : {}),
      });
      output = result.output;
      const mapped = exitCodeToVerdict(result);
      verdict = mapped.verdict;
      summary = mapped.summary;
    });
  } catch (err) {
    return {
      verifier: 'command',
      verdict: 'inconclusive',
      summary: `command verifier could not check out the candidate: ${err instanceof Error ? err.message : String(err)}`,
      output: '',
      inputOid: args.verifiedHeadOid,
    };
  }

  return { verifier: 'command', verdict, summary, output, inputOid: args.verifiedHeadOid };
}

/** Map a {@link CommandAttempt} to the persisted {@link VerificationAttemptInput}. */
export function commandAttemptToInput(attempt: CommandAttempt): VerificationAttemptInput {
  return {
    mechanism: attempt.verifier,
    inputOid: attempt.inputOid,
    verdict: attempt.verdict,
    summary: attempt.summary,
    output: attempt.output,
  };
}
