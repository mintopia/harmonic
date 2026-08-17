import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { VerificationCommand } from '../config.js';
import { withDetachedWorktree } from '../execution/candidate.js';
import type { Verdict } from './critic-schema.js';
import type { VerificationAttemptInput } from '../domain/verification-attempts.js';

/**
 * The command verifier (issue #135, ADR-0021, reliability-design Unit B): the
 * first real verifier and the first end-to-end proof that broken work never
 * lands unattended. The operator-configured command (`VerificationCommand`,
 * #132) is spawned against the frozen candidate — an argv/args exec with an
 * explicit cwd/env, a hard timeout, an output cap, and cancellation — and its
 * exit code maps to a {@link Verdict} per the table in {@link exitCodeToVerdict}.
 *
 * Like the sibling critic (`verification/critic.ts`, #136) this is a
 * self-contained, fully-tested unit: everything the command sees is bracketed
 * by `withDetachedWorktree` (`execution/candidate.ts`, #134), so the command
 * runs against a stable, detached candidate checkout it can never land, and it
 * never throws for a verdict — every plumbing failure (missing command, spawn
 * error, timeout, cancellation, a checkout that could not be created) folds
 * into `inconclusive`, which the combination function (#133) treats as
 * fail-safe (Escalate). A non-zero exit is an actionable `fail`; only a clean
 * exit 0 is a `pass`.
 *
 * Unlike the critic, a command verifier is *expected* to mutate its checkout
 * (a test runner writes coverage, a build writes artifacts), so the before/
 * after fingerprint is reported for audit but never overrides the verdict —
 * the detached, disposable, removed-after worktree is the containment, not the
 * read-only assumption the critic's mutation fail-safe enforces.
 */

/** The verdict a command run produced, plus the captured output and the
 * candidate OID it ran against. Shaped to map straight onto a persisted
 * {@link VerificationAttemptInput} via {@link commandAttemptToInput}. */
export interface CommandAttempt {
  verifier: 'command';
  verdict: Verdict;
  summary: string;
  /** Combined stdout+stderr, capped at {@link OUTPUT_CHAR_CAP}. */
  output: string;
  /** Whether the command mutated the disposable checkout — informational for a
   * command (a build/test legitimately writes), never a verdict override. */
  mutated: boolean;
  /** The candidate OID this attempt verified. */
  inputOid: string;
}

/** Combined stdout+stderr past this many characters is truncated — a chatty
 * command must not blow the stored `output` size (mirrors `critic.ts`'s
 * `DIFF_CHAR_CAP`; #132's locked config schema carries no per-command cap). */
export const OUTPUT_CHAR_CAP = 200_000;

/** What one spawn of the configured command resolved to — the raw plumbing
 * result {@link exitCodeToVerdict} maps to a {@link Verdict}. Exactly one of the
 * failure flags is set, or none (a clean `code`). */
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
  /** Cancellation: an abort kills the child (mirrors the timeout kill). */
  signal?: AbortSignal | undefined;
}

/**
 * The injectable seam between {@link runCommandVerifier} and a real child
 * process (mirrors the critic's `CriticHarnessDrive`): the unit tests
 * substitute a fake that returns a canned {@link CommandSpawnResult} so the
 * checkout / verdict-mapping / mutation-reporting logic is testable without
 * spawning a process, while the end-to-end Runner test drives the real spawn.
 */
export interface CommandSpawn {
  run(req: CommandSpawnRequest): Promise<CommandSpawnResult>;
}

/**
 * The real spawner: exec the configured argv (never a shell string) with an
 * explicit cwd/env, capping combined stdout+stderr and enforcing the timeout
 * and cancellation by SIGKILL. Never rejects — a spawn failure (`ENOENT`/
 * `EACCES`) resolves with `spawnError` set, so the caller maps it to
 * `inconclusive` rather than catching a throw.
 */
export function createChildProcessSpawn(): CommandSpawn {
  return {
    run(req: CommandSpawnRequest): Promise<CommandSpawnResult> {
      return new Promise<CommandSpawnResult>((resolve) => {
        // The command's env is `process.env` overlaid with its configured env,
        // minus the tracker credentials — belt-and-braces, exactly like the
        // critic (`critic.ts` `criticSpawnEnv`): a verifier command has no
        // legitimate reason to reach the Harmonic MCP server, so those two keys
        // never survive into it whatever it inherits.
        const env: NodeJS.ProcessEnv = { ...process.env, ...req.command.env };
        delete env.HARMONIC_API_KEY;
        delete env.HARMONIC_MCP_URL;

        let output = '';
        let capped = false;
        const append = (chunk: string): void => {
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
            // already gone
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

        // A missing/unspawnable command emits 'error' (ENOENT/EACCES) and never
        // starts — resolve with the error so it maps to inconclusive. 'error'
        // always fires before 'close', and `finish` is idempotent, so the later
        // 'close' (which carries no spawn error) is ignored in that case.
        child.on('error', (err) => finish({ spawnError: err, code: null, signal: null, output }));
        child.on('close', (code, signal) => finish({ timedOut, aborted, code, signal, output }));
      });
    },
  };
}

/**
 * The documented exit-code → verdict table (issue #135 AC, ADR-0021), the one
 * place a raw {@link CommandSpawnResult} becomes a {@link Verdict}:
 *
 * | Command result                              | Verdict      |
 * | ------------------------------------------- | ------------ |
 * | exit code 0                                 | pass         |
 * | exit code non-zero (1–255)                  | fail         |
 * | spawn error (missing command / EACCES)      | inconclusive |
 * | timeout (killed after `timeoutSeconds`)     | inconclusive |
 * | cancelled (AbortSignal)                     | inconclusive |
 * | killed by signal / no exit code             | inconclusive |
 *
 * `inconclusive` is the fail-safe direction (ADR-0021): any infra doubt
 * Escalates rather than being mistaken for a pass or driving a heal loop.
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
  /** The frozen candidate commit (`execution/candidate.ts` `buildCandidate`, #134). */
  candidateOid: string;
  /** Where to check out the disposable detached worktree for this attempt. */
  worktreePath: string;
  command: VerificationCommand;
  /** Cancellation, wired to Runner shutdown; an abort kills the command child. */
  signal?: AbortSignal;
  /** Injectable spawn seam; defaults to {@link createChildProcessSpawn}. */
  spawn?: CommandSpawn;
  /** Override the hard timeout (tests); defaults to `command.timeoutSeconds`. */
  timeoutMs?: number;
}

/**
 * Run the command verifier against a candidate OID and resolve a
 * {@link CommandAttempt} (issue #135, reliability-design Unit B).
 *
 * 1. Checks the candidate out in a disposable detached worktree
 *    (`withDetachedWorktree`, #134), bracketed by the before/after fingerprint.
 * 2. Spawns the configured command at the checkout root (plus the command's
 *    optional relative `cwd`), captures capped output, and enforces the
 *    timeout + cancellation.
 * 3. Maps the spawn result to a verdict via {@link exitCodeToVerdict}.
 * 4. If setting up the worktree itself failed (bad OID, git/FS error), that is a
 *    genuine infra failure folded into `inconclusive`, never a thrown error.
 *
 * Never throws for a verdict outcome. `mutated` is reported for audit but,
 * unlike the critic, never overrides the verdict — a command is expected to
 * write to its disposable checkout.
 */
export async function runCommandVerifier(args: RunCommandVerifierArgs): Promise<CommandAttempt> {
  const spawner = args.spawn ?? createChildProcessSpawn();
  const timeoutMs = args.timeoutMs ?? args.command.timeoutSeconds * 1000;

  let verdict: Verdict = 'inconclusive';
  let summary = '';
  let output = '';

  let proof: { mutated: boolean };
  try {
    proof = await withDetachedWorktree(args.repoDir, args.candidateOid, args.worktreePath, async (dir) => {
      const cwd = args.command.cwd ? join(dir, args.command.cwd) : dir;
      const result = await spawner.run({
        command: args.command,
        cwd,
        timeoutMs,
        outputCap: OUTPUT_CHAR_CAP,
        signal: args.signal,
      });
      output = result.output;
      const mapped = exitCodeToVerdict(result);
      verdict = mapped.verdict;
      summary = mapped.summary;
    });
  } catch (err) {
    // Setting up the disposable worktree failed (bad OID, git/FS error) — a
    // genuine infra failure, folded into inconclusive rather than thrown, same
    // as every other failure mode this function handles.
    return {
      verifier: 'command',
      verdict: 'inconclusive',
      summary: `command verifier could not check out the candidate: ${err instanceof Error ? err.message : String(err)}`,
      output: '',
      mutated: false,
      inputOid: args.candidateOid,
    };
  }

  return { verifier: 'command', verdict, summary, output, mutated: proof.mutated, inputOid: args.candidateOid };
}

/**
 * Map a {@link CommandAttempt} to the persisted {@link VerificationAttemptInput}
 * shape (mirrors the critic's `criticAttemptToInput`): the command's
 * `verifier: 'command'` tag is the store's `mechanism`, every other field maps
 * straight across.
 */
export function commandAttemptToInput(attempt: CommandAttempt): VerificationAttemptInput {
  return {
    mechanism: attempt.verifier,
    inputOid: attempt.inputOid,
    verdict: attempt.verdict,
    summary: attempt.summary,
    output: attempt.output,
    mutated: attempt.mutated,
  };
}
