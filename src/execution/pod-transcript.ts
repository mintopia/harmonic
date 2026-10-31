import type { ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AcpInitializeResult } from '../acp/driver.js';
import type { StepArchiveWriter } from '../archive/task-archive.js';
import type { AttemptRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { SessionStore } from '../domain/sessions.js';
import { errorMessage } from '../error-handling.js';
import { logger } from '../logger.js';
import { adapterFor, adapterVersion } from './harness/registry.js';
import type { PodSession } from './pod-session.js';
import { accumulateUsage, usageFromModels, type AttemptUsage } from './usage.js';

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const LOCATE_DELAYS_MS = [200, 500, 1000, 2000, 3000];
const COPY_TIMEOUT_MS = 120_000;
const TAIL_STOP_TIMEOUT_MS = 5_000;

const LOCATE: Record<string, (sessionId: string) => string> = {
  claude: (id) => `find "$HOME/.claude/projects" -maxdepth 3 -type f -name '${id}.jsonl' 2>/dev/null | head -n 1`,
  codex: (id) => `find "\${CODEX_HOME:-$HOME/.codex}/sessions" -type f -name 'rollout-*-${id}.jsonl' 2>/dev/null | head -n 1`,
};

function sleepUnless(ms: number, stop: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))), stop]).finally(() => clearTimeout(timer));
}

function warn(message: string, error: unknown): void {
  logger.warn(`pod transcript: ${message}: ${errorMessage(error)}`);
}

export class PodTranscriptMirror {
  private file: string | null = null;
  private mirrorPath: string | null = null;
  private tail: ChildProcess | null = null;
  private tailClosed: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly stop: Promise<void>;
  private signalStop: () => void = () => undefined;
  private starting: Promise<void> = Promise.resolve();

  constructor(
    private readonly pod: Pick<PodSession, 'run' | 'streamFile'>,
    private readonly harnessId: string,
    private readonly dir: string,
    private readonly sessionId: string,
    private readonly locateDelaysMs: readonly number[] = LOCATE_DELAYS_MS,
  ) {
    this.stop = new Promise<void>((resolve) => (this.signalStop = resolve));
  }

  start(): void {
    this.starting = this.follow().catch((error: unknown) => warn('following the session file failed', error));
  }

  async finish(): Promise<string | null> {
    this.stopped = true;
    this.signalStop();
    try {
      await this.starting;
      if (this.file === null) await this.attach(await this.locate());
      await this.stopTail();
      if (this.file !== null) await this.copyOut(this.file);
    } catch (error) {
      warn('copying the session file out of the pod failed', error);
    }
    return this.mirrorPath !== null && (await stat(this.mirrorPath).then(() => true, () => false)) ? this.mirrorPath : null;
  }

  private async locate(): Promise<string | null> {
    const script = SAFE_ID.test(this.sessionId) ? LOCATE[this.harnessId]?.(this.sessionId) : undefined;
    if (script === undefined) return null;
    const result = await this.pod.run(script, {}, 15_000);
    const line = result.stdout.trim().split('\n')[0] ?? '';
    return result.code === 0 && line !== '' ? line : null;
  }

  private async follow(): Promise<void> {
    let found = await this.locate();
    for (const delay of this.locateDelaysMs) {
      if (found !== null || this.stopped) break;
      await sleepUnless(delay, this.stop);
      found = await this.locate();
    }
    await this.attach(found);
  }

  private async attach(file: string | null): Promise<void> {
    if (file === null || this.file !== null) return;
    this.file = file;
    this.mirrorPath = join(this.dir, this.harnessId, this.sessionId, basename(file));
    await mkdir(join(this.dir, this.harnessId, this.sessionId), { recursive: true });
    const out = createWriteStream(this.mirrorPath);
    this.tailClosed = new Promise<void>((resolve) => out.on('close', resolve));
    out.on('error', (error) => warn('writing the mirror failed', error));
    if (this.stopped) {
      out.end();
      return;
    }
    const child = await this.pod.streamFile(file, true);
    this.tail = child;
    child.stdout!.pipe(out);
    child.stderr!.resume();
    child.on('error', (error) => warn('the tail stream failed', error));
  }

  private async stopTail(): Promise<void> {
    this.tail?.kill();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.tailClosed, new Promise<void>((resolve) => (timer = setTimeout(resolve, TAIL_STOP_TIMEOUT_MS)))]);
    clearTimeout(timer);
  }

  private async copyOut(file: string): Promise<void> {
    const child = await this.pod.streamFile(file, false);
    const chunks: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    child.stderr!.resume();
    const ended = new Promise<void>((resolve) => {
      child.stdout!.on('end', resolve);
      child.stdout!.on('close', resolve);
      child.stdout!.on('error', resolve);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('close', (code: number | null) => resolve(code));
      child.on('error', () => resolve(null));
    });
    const timer = setTimeout(() => child.kill(), COPY_TIMEOUT_MS);
    const [code] = await Promise.all([exited, ended]);
    clearTimeout(timer);
    if (code !== 0 || this.mirrorPath === null) throw new Error(`reading ${file} exited with ${code ?? 'no status'}`);
    await writeFile(this.mirrorPath, Buffer.concat(chunks));
  }
}

export interface PodTranscriptDeps<S extends { workspaceId: number | null }> {
  dir: string;
  sessions: Pick<SessionStore, 'recordDispatch'>;
  attempts: Pick<AttemptStore, 'get' | 'update' | 'listSteps' | 'updateStep'>;
  archive?: (task: S, run: AttemptRow, kind: PodStepKind, stepId: string) => StepArchiveWriter | undefined;
  locateDelaysMs?: readonly number[];
}

export type PodStepKind = 'agent' | 'critic';

export interface PodStepTranscriptInput<S> {
  pod: Pick<PodSession, 'run' | 'streamFile'>;
  task: S;
  run: AttemptRow;
  harnessId: string;
  model: string;
  cwd: string;
  kind: PodStepKind;
  stepId: string;
}

export class PodStepTranscript<S extends { workspaceId: number | null }> {
  private current: { sessionId: string; mirror: PodTranscriptMirror; initialize: AcpInitializeResult } | null = null;

  constructor(
    private readonly deps: PodTranscriptDeps<S>,
    private readonly input: PodStepTranscriptInput<S>,
  ) {}

  readonly onSessionCreated = async (sessionId: string, initialize: AcpInitializeResult): Promise<void> => {
    if (this.current?.sessionId === sessionId) return;
    await this.finish();
    const mirror = new PodTranscriptMirror(this.input.pod, this.input.harnessId, this.deps.dir, sessionId, this.deps.locateDelaysMs);
    this.current = { sessionId, mirror, initialize };
    mirror.start();
  };

  async finish(): Promise<void> {
    const entry = this.current;
    this.current = null;
    if (!entry) return;
    const path = await entry.mirror.finish();
    if (path === null) return;
    await this.record(entry.sessionId, entry.initialize, path);
  }

  private async record(sessionId: string, initialize: AcpInitializeResult, path: string): Promise<void> {
    const { task, run, harnessId, model, cwd, kind, stepId } = this.input;
    const { attempts } = this.deps;
    const step = async (label: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        warn(label, error);
      }
    };
    let sessionRowId: number | null = null;
    await step('recording the Session failed', async () => {
      const session = await this.deps.sessions.recordDispatch({
        harness: harnessId,
        harnessSessionId: sessionId,
        model,
        cwd,
        workspaceId: task.workspaceId,
        transcriptPath: path,
        mcpTemplates: [],
        capabilities: initialize,
        adapterVersion: adapterVersion(harnessId),
        now: Date.now(),
      });
      sessionRowId = session.id;
    });
    if (kind === 'agent') {
      if (sessionRowId !== null) {
        const bound = sessionRowId;
        await step('binding the Session to the Attempt failed', () => attempts.update(run.id, { sessionId, sessionRowId: bound }));
        await step('linking the step log failed', async () => {
          const implementation = (await attempts.listSteps(run.id)).find((row) => row.type === 'implementation' && row.state === 'running');
          if (implementation) await attempts.updateStep(implementation.id, { logLocator: `session:${bound}` });
        });
      }
      await step('recording Usage failed', async () => {
        const models = adapterFor(harnessId).usage?.modelsFromSessionLog(path, sessionId) ?? {};
        if (Object.keys(models).length === 0) return;
        const stored = (await attempts.get(run.id)).usage;
        const usage = accumulateUsage(stored ? (JSON.parse(stored) as AttemptUsage) : null, usageFromModels(models));
        await attempts.update(run.id, { usage: JSON.stringify(usage) });
      });
    }
    const writer = this.deps.archive?.(task, run, kind, stepId);
    if (writer) {
      await step('copying the transcript into the Archive failed', () => writer.copyNative(harnessId, path));
      await step('closing the Archive writer failed', () => writer.close());
    }
  }
}

export class PodTranscripts<S extends { workspaceId: number | null }> {
  constructor(private readonly deps: PodTranscriptDeps<S>) {}

  begin(input: PodStepTranscriptInput<S>): PodStepTranscript<S> {
    return new PodStepTranscript(this.deps, input);
  }
}
