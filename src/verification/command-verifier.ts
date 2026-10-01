import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Attributes, SpanContext } from '@opentelemetry/api';
import type { VerificationCommand } from '../config.js';
import { withDetachedWorktree } from '../execution/detached-worktree.js';
import { logger } from '../logger.js';
import { startOperation } from '../telemetry/operations.js';
import type { Verdict } from './critic-schema.js';
import type { VerificationAttemptInput } from '../domain/verification-attempts.js';

/** The verdict a command run produced, plus the captured output and the candidate OID. */
export interface CommandAttempt {
  verifier: 'command';
  verdict: Verdict;
  summary: string;
  /** Combined stdout+stderr preview: head and tail within {@link OUTPUT_CHAR_CAP}, elided middle marked. */
  output: string;
  /** The candidate OID this attempt verified. */
  inputOid: string;
}

/** Combined stdout+stderr past this many characters is truncated. */
export const OUTPUT_CHAR_CAP = 200_000;

export function truncationMarker(elided: number, fullOutputPath?: string): string {
  return fullOutputPath
    ? `\n…[truncated ${elided} chars; full output: ${fullOutputPath}]…\n`
    : `\n…[truncated ${elided} chars]…\n`;
}

const FULL_OUTPUT_MARKER = /(…\[truncated \d+ chars); full output: ([^\n]+?[\\/]output\.log)(\]…)/;

/** Strips the server-side archive path from a truncation marker so it never reaches a client; returns it separately. */
export function splitFullOutputPath(output: string): { output: string; fullOutputPath: string | null } {
  const match = FULL_OUTPUT_MARKER.exec(output);
  if (!match) return { output, fullOutputPath: null };
  return { output: output.replace(FULL_OUTPUT_MARKER, '$1$3'), fullOutputPath: match[2]! };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export interface OutputPreview {
  append(chunk: string): void;
  text(): string;
  /** Stop advertising the full-output file (it failed and is no longer complete). */
  dropFullOutputPath(): void;
}

/** Bounded-memory head+tail preview of a stream; total length never exceeds `cap` once truncated. */
export function createOutputPreview(cap: number, fullOutputPath?: string): OutputPreview {
  let linkPath = fullOutputPath;
  const headCap = Math.floor(cap / 2);
  const tailCap = cap - headCap;
  let head = '';
  let tail = '';
  let total = 0;
  return {
    append(chunk) {
      total += chunk.length;
      if (head.length < headCap) {
        const take = headCap - head.length;
        head += chunk.slice(0, take);
        chunk = chunk.slice(take);
      }
      if (chunk.length === 0) return;
      tail += chunk;
      if (tail.length > tailCap * 2) tail = tail.slice(-tailCap);
    },
    text() {
      if (total <= cap) return head + tail;
      const avail = Math.max(0, cap - truncationMarker(total, linkPath).length);
      let headKeep = Math.min(head.length, Math.floor(avail / 2));
      if (isHighSurrogate(head.charCodeAt(headKeep - 1))) headKeep -= 1;
      const tailKeep = avail - headKeep;
      let tailText = tailKeep > 0 ? tail.slice(-tailKeep) : '';
      if (isLowSurrogate(tailText.charCodeAt(0))) tailText = tailText.slice(1);
      return head.slice(0, headKeep) + truncationMarker(total - headKeep - tailText.length, linkPath) + tailText;
    },
    dropFullOutputPath() {
      linkPath = undefined;
    },
  };
}

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
  /** Combined stdout+stderr preview (head + marker + tail) already capped by the spawner. */
  output: string;
}

export interface CommandSpawnRequest {
  command: VerificationCommand;
  /** Absolute working directory the command runs in (candidate checkout root,
   * plus the command's optional relative `cwd`). */
  cwd: string;
  timeoutMs: number;
  outputCap: number;
  /** Write the full, uncapped combined output here; a file error never affects the verdict. */
  outputLogPath?: string | undefined;
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

        const preview = createOutputPreview(req.outputCap, req.outputLogPath);
        let file: WriteStream | undefined;
        let fileClosed: Promise<void> = Promise.resolve();
        if (req.outputLogPath) {
          const stream = createWriteStream(req.outputLogPath, { flags: 'w' });
          file = stream;
          let closeResolve!: () => void;
          fileClosed = new Promise<void>((r) => {
            closeResolve = r;
          });
          stream.on('close', closeResolve);
          stream.on('drain', () => {
            child.stdout?.resume();
            child.stderr?.resume();
          });
          stream.on('error', (error) => {
            logger.warn('verify output.log write failed; continuing without it', { error: error.message });
            file = undefined;
            preview.dropFullOutputPath();
            stream.destroy();
            child.stdout?.resume();
            child.stderr?.resume();
          });
        }
        const append = (chunk: string): void => {
          req.onOutput?.(chunk);
          preview.append(chunk);
          if (file && !file.write(chunk)) {
            child.stdout?.pause();
            child.stderr?.pause();
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
          const stream = file;
          file = undefined;
          if (stream && !stream.destroyed) stream.end();
          void fileClosed.then(() => resolve({ ...result, output: preview.text() }));
        };

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', append);
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', append);

        // node emits 'error' (ENOENT/EACCES) before 'close' for an unspawnable command; `finish` is idempotent so the later 'close' is ignored.
        child.on('error', (err) => finish({ spawnError: err, code: null, signal: null, output: '' }));
        child.on('close', (code, signal) => finish({ timedOut, aborted, code, signal, output: '' }));
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
  /** An existing checkout to run the command in — the candidate is already
   * materialised here. A Task passes its builder worktree (in place); a surface
   * with no live checkout at the target commit uses
   * {@link runCommandVerifierDetached} to carve a disposable one. */
  cwd: string;
  /** The commit this attempt verifies — recorded as the attempt's `inputOid`. */
  verifiedHeadOid: string;
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
  /** Stream the full uncapped output here; forwarded to the spawner when set. */
  outputLogPath?: string | null | undefined;
}

/** Run the command verifier in {@link RunCommandVerifierArgs.cwd} and resolve a {@link CommandAttempt}. Never throws for a verdict outcome. */
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

  const cwd = args.command.cwd ? join(args.cwd, args.command.cwd) : args.cwd;
  const result = await spawner.run({
    command: args.command,
    cwd,
    timeoutMs,
    outputCap: OUTPUT_CHAR_CAP,
    signal: args.signal,
    ...(args.outputLogPath ? { outputLogPath: args.outputLogPath } : {}),
    ...(args.onOutput ? { onOutput: args.onOutput } : {}),
  });
  const mapped = exitCodeToVerdict(result);
  return { verifier: 'command', verdict: mapped.verdict, summary: mapped.summary, output: result.output, inputOid: args.verifiedHeadOid };
}

export interface RunCommandVerifierDetachedArgs extends Omit<RunCommandVerifierArgs, 'cwd'> {
  /** The base repo owning the target commit and object store. */
  repoDir: string;
  /** Where to carve the disposable detached worktree for this attempt. */
  worktreePath: string;
}

/** Run the command verifier against {@link RunCommandVerifierDetachedArgs.verifiedHeadOid}
 * in a disposable detached worktree carved from `repoDir` — for surfaces with no
 * live checkout at the target commit (Epic integration, crash-recovery
 * post-merge), where the command must not run in a shared checkout. A checkout
 * failure folds into `inconclusive`; never throws for a verdict outcome. */
export async function runCommandVerifierDetached(args: RunCommandVerifierDetachedArgs): Promise<CommandAttempt> {
  const { repoDir, worktreePath, ...rest } = args;
  try {
    return await withDetachedWorktree(repoDir, args.verifiedHeadOid, worktreePath, (dir) =>
      runCommandVerifier({ ...rest, cwd: dir }),
    );
  } catch (err) {
    return {
      verifier: 'command',
      verdict: 'inconclusive',
      summary: `command verifier could not check out the candidate: ${err instanceof Error ? err.message : String(err)}`,
      output: '',
      inputOid: args.verifiedHeadOid,
    };
  }
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
