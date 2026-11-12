import { killProcessGroup, type SpawnProcessGroup } from '../execution/process-groups.js';
import { createWriteStream, type WriteStream } from 'node:fs';
import type { VerificationCommand } from '../config.js';
import { logger } from '../logger.js';
import type { Verdict } from './critic-schema.js';

/** Where a step's full output is written, and the Archive-relative key that locates it later. */
export interface VerificationOutputLog {
  path: string;
  key: string;
}

export const OUTPUT_CHAR_CAP = 200_000;

export function truncationMarker(elided: number): string {
  return `\n…[truncated ${elided} chars]…\n`;
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
  /** Whether more was appended than {@link text} can show. */
  truncated(): boolean;
}

/** Bounded-memory head+tail preview of a stream; total length never exceeds `cap` once truncated. */
export function createOutputPreview(cap: number): OutputPreview {
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
      const avail = Math.max(0, cap - truncationMarker(total).length);
      let headKeep = Math.min(head.length, Math.floor(avail / 2));
      if (isHighSurrogate(head.charCodeAt(headKeep - 1))) headKeep -= 1;
      const tailKeep = avail - headKeep;
      let tailText = tailKeep > 0 ? tail.slice(-tailKeep) : '';
      if (isLowSurrogate(tailText.charCodeAt(0))) tailText = tailText.slice(1);
      return head.slice(0, headKeep) + truncationMarker(total - headKeep - tailText.length) + tailText;
    },
    truncated() {
      return total > cap;
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
  stdout: string;
  /** Output was truncated and the full log was written without error. */
  fullOutputSaved?: boolean | undefined;
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
export function createChildProcessSpawn(spawnProcessGroup: SpawnProcessGroup): CommandSpawn {
  return {
    run(req: CommandSpawnRequest): Promise<CommandSpawnResult> {
      return new Promise<CommandSpawnResult>((resolve) => {
        const env: NodeJS.ProcessEnv = { ...process.env, ...req.command.env };
        delete env.HARMONIC_API_KEY;
        delete env.HARMONIC_MCP_URL;

        const preview = createOutputPreview(req.outputCap);
        const stdoutPreview = createOutputPreview(req.outputCap);
        let file: WriteStream | undefined;
        let logComplete = req.outputLogPath !== undefined;
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
            logComplete = false;
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

        const child = spawnProcessGroup(req.command.command, req.command.args, {
          cwd: req.cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }, `verify command ${req.command.command}`);

        const kill = (): void => killProcessGroup(child);

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
          void fileClosed.then(() => resolve({ ...result, output: preview.text(), stdout: stdoutPreview.text(), fullOutputSaved: logComplete && preview.truncated() }));
        };

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdoutPreview.append(chunk);
          append(chunk);
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', append);

        // node emits 'error' (ENOENT/EACCES) before 'close' for an unspawnable command; `finish` is idempotent so the later 'close' is ignored.
        child.on('error', (err) => finish({ spawnError: err, code: null, signal: null, output: '', stdout: '' }));
        child.on('close', (code, signal) => finish({ timedOut, aborted, code, signal, output: '', stdout: '' }));
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
