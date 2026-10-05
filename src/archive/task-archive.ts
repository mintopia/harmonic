import type { TrackerRef } from '../tracker/adapter.js';
import { createWriteStream, type WriteStream } from 'node:fs';
import { access, appendFile, copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { TaskRow } from '../db/schema.js';
import { logger } from '../logger.js';
import { yieldToEventLoop } from '../reliability/yield.js';
import { PROMPT_INDEX_FILE, PROMPT_SEPARATOR, parsePromptSpans, promptSpanLine, readPromptSegments, type PromptSpan } from './prompt-spans.js';
import type { VerificationOutputLog } from '../verification/command-verifier.js';

export interface ArchiveDeps {
  dataDir: string;
  ensureArchiveId: (taskId: number) => Promise<string>;
  workspaceName: (workspaceId: number) => Promise<string | null>;
}

export type ExportDestination = 'directory' | 's3';

export interface ExportRecord {
  destination: ExportDestination;
  disposition: string;
  file: string | null;
  status: 'succeeded' | 'failed';
  at: string;
  error?: string;
  retry?: number;
  builtAt?: string;
  name?: string;
  partial?: boolean;
  bytes?: number;
  redactions?: Record<string, number>;
}

interface ArchiveManifest {
  exports?: ExportRecord[];
  dispositions?: { disposition: string; at: string }[];
  deleted?: { at: string; actor: OperatorActor };
  [key: string]: unknown;
}

export interface StepArchiveWriter {
  readonly dir: Promise<string>;
  /** Attempt-relative path of this step's `prompt.md`. */
  readonly promptLocator: string;
  /** Append a Resolved Prompt; resolves to its 0-based index in `prompt.md`, or null when the write failed. */
  appendPrompt(text: string): Promise<number | null>;
  appendUpdate(update: unknown): void;
  copyNative(harness: string, transcriptPath: string | null): Promise<void>;
  close(): Promise<void>;
}

export type ResolutionKind = 'task-conflict' | 'epic-conflict' | 'epic-resolve' | 'epic-refresh';

export type CriticArchiveStage = 'pre-merge' | 'post-merge';

/** Attempt-relative locator of a critic step's Resolved Prompt, matching the directory `criticStep`/`epicCriticStep` write. */
export function criticPromptKey(stage: CriticArchiveStage, stepId: string): string {
  return `verification/${stage}/${stepId}/prompt.md`;
}

export type OperatorAction = 'steer' | 'reject' | 'accept' | 'pause' | 'resume' | 'close' | 'cancel';
export type OperatorActor = 'operator' | 'agent';

export interface OperatorInput {
  actor: OperatorActor;
  action: OperatorAction;
  text: string | null;
}

const PROMPT_READ_CHUNK_BYTES = 64 * 1024;

function warn(message: string, err: unknown, fields: Record<string, unknown> = {}): void {
  logger.warn(message, { ...fields, error: err instanceof Error ? err.message : String(err) });
}

export function workspaceSlug(name: string | null, workspaceId: number | null): string {
  const slug = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `workspace-${workspaceId ?? 'none'}`;
}

function taskTitle(task: TaskRow): string {
  if (task.trackerTitle?.trim()) return task.trackerTitle.trim();
  const line = task.prompt.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.trim().slice(0, 200);
}

export function safeSegment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '-');
  if (cleaned === id && id !== '.' && id !== '..' && id !== '') return id;
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${cleaned.replace(/^\.+/, '') || 'step'}-${hash}`;
}

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

class AppendFile {
  private stream: WriteStream | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private hasContent = false;
  private size = 0;

  constructor(private readonly dir: Promise<string>, private readonly name: string) {}

  /** `onWritten` receives the byte offset and length of `data` itself (excluding the separator). */
  write(data: string, separator = '', onWritten?: (start: number, length: number) => void): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const written = this.chain.then(async (): Promise<boolean> => {
      try {
        if (!this.stream) {
          const path = join(await this.dir, this.name);
          this.size = await stat(path).then((s) => s.size, () => 0);
          this.hasContent = this.size > 0;
          this.stream = createWriteStream(path, { flags: 'a' });
          this.stream.on('error', (err) => warn('archive: append stream failed', err, { file: this.name }));
        }
        const stream = this.stream;
        if (stream.destroyed) return false;
        const lead = this.hasContent ? Buffer.byteLength(separator) : 0;
        const start = this.size + lead;
        const length = Buffer.byteLength(data);
        if (this.hasContent) data = `${separator}${data}`;
        this.hasContent = true;
        this.size += lead + length;
        await new Promise<void>((resolve, reject) => {
          stream.write(data, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        onWritten?.(start, length);
        return true;
      } catch (err) {
        warn('archive: append failed', err, { file: this.name });
        return false;
      }
    });
    this.chain = written.then(() => undefined);
    return written;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.chain;
    const stream = this.stream;
    this.stream = null;
    if (!stream || stream.destroyed) return;
    await new Promise<void>((resolve) => {
      stream.once('error', () => resolve());
      stream.once('close', () => resolve());
      stream.end();
    });
  }
}

export class TaskArchive {
  private readonly ensuring = new Map<string, Promise<string>>();
  private readonly manifestWrites = new Map<string, Promise<void>>();
  private readonly serial = new Map<number, Promise<void>>();

  constructor(private readonly deps: ArchiveDeps) {}

  ensure(task: TaskRow): Promise<string> {
    const key = String(task.id);
    const inflight = this.ensuring.get(key);
    if (inflight) return inflight;
    const promise = this.doEnsure(task).finally(() => this.ensuring.delete(key));
    this.ensuring.set(key, promise);
    return promise;
  }

  private async archiveDir(task: TaskRow, archiveId: string): Promise<{ dir: string; workspaceName: string | null }> {
    const workspaceName = task.workspaceId === null ? null : await this.deps.workspaceName(task.workspaceId);
    return { dir: this.taskDir(task, archiveId, workspaceName), workspaceName };
  }

  private enqueue(taskId: number, work: () => Promise<void>): Promise<void> {
    const prev = this.serial.get(taskId) ?? Promise.resolve();
    const next = prev.then(work, work);
    this.serial.set(taskId, next);
    return next.finally(() => {
      if (this.serial.get(taskId) === next) this.serial.delete(taskId);
    });
  }

  recordOperatorInput(task: TaskRow, input: OperatorInput): Promise<void> {
    return this.enqueue(task.id, async () => {
      try {
        const dir = await this.ensure(task);
        const line = JSON.stringify({ ts: new Date().toISOString(), actor: input.actor, action: input.action, text: input.text });
        await appendFile(join(dir, 'operator-inputs.jsonl'), `${line}\n`);
      } catch (err) {
        warn('archive: operator input record failed', err, { taskId: task.id, action: input.action });
      }
    });
  }

  async existingDir(task: TaskRow): Promise<string | null> {
    if (!task.archiveId) return null;
    try {
      const { dir } = await this.archiveDir(task, task.archiveId);
      return (await pathExists(join(dir, 'archive.json'))) ? dir : null;
    } catch (err) {
      warn('archive: directory lookup failed', err, { taskId: task.id });
      return null;
    }
  }

  async markDeleted(dir: string, actor: OperatorActor, taskId: number): Promise<void> {
    try {
      await this.updateManifest(dir, (body) => {
        body.deleted = { at: new Date().toISOString(), actor };
      });
    } catch (err) {
      warn('archive: deletion mark failed', err, { taskId });
    }
  }

  async recordDeletion(task: TaskRow, actor: OperatorActor): Promise<void> {
    const dir = await this.existingDir(task);
    if (dir) await this.markDeleted(dir, actor, task.id);
  }

  private async doEnsure(task: TaskRow): Promise<string> {
    const archiveId = task.archiveId ?? (await this.deps.ensureArchiveId(task.id));
    const { dir, workspaceName } = await this.archiveDir(task, archiveId);
    await mkdir(dir, { recursive: true });
    await this.writeManifestIfAbsent(dir, {
      taskId: task.id,
      archiveId,
      trackerRef: task.trackerRef,
      title: taskTitle(task),
      workspace: workspaceName,
      workspaceId: task.workspaceId,
      createdAt: new Date(task.createdAt).toISOString(),
      dispositions: [],
      exports: [],
    });
    return dir;
  }

  private taskDir(task: TaskRow, archiveId: string, workspaceName: string | null): string {
    return join(this.deps.dataDir, 'archive', workspaceSlug(workspaceName, task.workspaceId), `${task.id}-${archiveId}`);
  }

  async exportHistory(task: TaskRow): Promise<ExportRecord[]> {
    if (task.archiveId === null) return [];
    try {
      const workspaceName = task.workspaceId === null ? null : await this.deps.workspaceName(task.workspaceId);
      return await this.readExports(this.taskDir(task, task.archiveId, workspaceName));
    } catch (err) {
      warn('archive: export history unreadable', err, { taskId: task.id });
      return [];
    }
  }

  async epicExportHistory(workspaceId: number, epicRef: TrackerRef): Promise<ExportRecord[]> {
    try {
      const workspaceName = await this.deps.workspaceName(workspaceId);
      return await this.readExports(join(this.deps.dataDir, 'archive', workspaceSlug(workspaceName, workspaceId), `epic-${safeSegment(epicRef)}`));
    } catch (err) {
      warn('archive: epic export history unreadable', err, { workspaceId, epicRef });
      return [];
    }
  }

  private async readExports(dir: string): Promise<ExportRecord[]> {
    try {
      const body = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8')) as { exports?: ExportRecord[] };
      return body.exports ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async writeManifestIfAbsent(dir: string, body: Record<string, unknown>): Promise<void> {
    const manifest = join(dir, 'archive.json');
    if (await pathExists(manifest)) return;
    const tmp = `${manifest}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`);
      await rename(tmp, manifest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async recordExport(task: TaskRow, entry: ExportRecord): Promise<void> {
    await this.updateManifest(await this.ensure(task), (body) => {
      body.exports = [...(body.exports ?? []), entry];
    });
  }

  async recordEpicExport(workspaceId: number, epicRef: TrackerRef, entry: ExportRecord): Promise<void> {
    await this.updateManifest(await this.ensureEpic(workspaceId, epicRef), (body) => {
      body.exports = [...(body.exports ?? []), entry];
    });
  }

  async recordEpicDisposition(workspaceId: number, epicRef: TrackerRef, disposition: string): Promise<void> {
    await this.updateManifest(await this.ensureEpic(workspaceId, epicRef), (body) => {
      body.dispositions = [...(body.dispositions ?? []), { disposition, at: new Date().toISOString() }];
    });
  }

  private async updateManifest(dir: string, mutate: (body: ArchiveManifest) => void): Promise<void> {
    const previous = this.manifestWrites.get(dir) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.rewriteManifest(dir, mutate));
    this.manifestWrites.set(dir, next);
    try {
      await next;
    } finally {
      if (this.manifestWrites.get(dir) === next) this.manifestWrites.delete(dir);
    }
  }

  private async rewriteManifest(dir: string, mutate: (body: ArchiveManifest) => void): Promise<void> {
    const manifest = join(dir, 'archive.json');
    const body = JSON.parse(await readFile(manifest, 'utf8')) as ArchiveManifest;
    mutate(body);
    const tmp = `${manifest}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`);
      await rename(tmp, manifest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private async implementationDir(task: TaskRow, attemptNumber: number): Promise<string> {
    const dir = join(await this.ensure(task), 'attempts', String(attemptNumber), 'implementation');
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async createOutputLog(root: string, attemptNumber: number, stage: 'pre-merge' | 'post-merge', stepId: string): Promise<VerificationOutputLog> {
    const key = `verification/${stage}/${safeSegment(stepId)}/output.log`;
    const path = join(root, 'attempts', String(attemptNumber), key);
    await mkdir(dirname(path), { recursive: true });
    return { path, key };
  }

  async verificationOutputLog(
    task: TaskRow,
    attemptNumber: number,
    stage: 'pre-merge' | 'post-merge',
    stepId: string,
  ): Promise<VerificationOutputLog | null> {
    try {
      return await this.createOutputLog(await this.ensure(task), attemptNumber, stage, stepId);
    } catch (err) {
      warn('archive: verification output directory failed', err, { taskId: task.id, attemptNumber, stage });
      return null;
    }
  }

  async epicVerificationOutputLog(workspaceId: number, epicRef: TrackerRef, attemptNumber: number, commandId: string, stage: 'pre-merge' | 'post-merge' = 'pre-merge'): Promise<VerificationOutputLog | null> {
    try {
      return await this.createOutputLog(await this.ensureEpic(workspaceId, epicRef), attemptNumber, stage, commandId);
    } catch (err) {
      warn('archive: epic verification output directory failed', err, { workspaceId, epicRef, attemptNumber });
      return null;
    }
  }

  implementationStep(task: TaskRow, attemptNumber: number): StepArchiveWriter {
    return this.stepWriter(this.implementationDir(task, attemptNumber), 'implementation', { taskId: task.id, attemptNumber });
  }

  /**
   * Archive a conflict- or Epic-resolution turn's Resolved Prompt at `<attempt>/resolution/<kind>-<turn>/prompt.md`
   * before it is sent. Best-effort: resolves null (never throws) when the Archive write fails.
   */
  async appendResolutionPrompt(
    owner: TaskRow | { workspaceId: number; epicRef: TrackerRef },
    attemptNumber: number,
    kind: ResolutionKind,
    turn: number,
    prompt: string,
  ): Promise<{ locator: string; promptIndex: number } | null> {
    const rel = `resolution/${kind}-${turn}`;
    const root = 'epicRef' in owner ? this.ensureEpic(owner.workspaceId, owner.epicRef) : this.ensure(owner);
    const dir = root.then((r) => this.makeDir(join(r, 'attempts', String(attemptNumber), rel)));
    const writer = this.stepWriter(dir, rel, { attemptNumber, kind, turn });
    try {
      const promptIndex = await writer.appendPrompt(prompt);
      await writer.close();
      return promptIndex === null ? null : { locator: writer.promptLocator, promptIndex };
    } catch (err) {
      warn('archive: resolution prompt failed', err, { attemptNumber, kind, turn });
      return null;
    }
  }

  criticStep(task: TaskRow, attemptNumber: number, stage: CriticArchiveStage, stepId: string): StepArchiveWriter {
    const dir = this.ensure(task).then((root) => this.makeDir(join(root, 'attempts', String(attemptNumber), 'verification', stage, stepId)));
    return this.stepWriter(dir, `verification/${stage}/${stepId}`, { taskId: task.id, attemptNumber, stage, stepId });
  }

  epicCriticStep(workspaceId: number, epicRef: TrackerRef, attemptNumber: number, stepId: string): StepArchiveWriter {
    const dir = this.ensureEpic(workspaceId, epicRef).then((root) =>
      this.makeDir(join(root, 'attempts', String(attemptNumber), 'verification', 'pre-merge', stepId)),
    );
    return this.stepWriter(dir, `verification/pre-merge/${stepId}`, { workspaceId, epicRef, attemptNumber, stepId });
  }

  ensureEpic(workspaceId: number, epicRef: TrackerRef): Promise<string> {
    const key = `epic:${workspaceId}:${epicRef}`;
    const inflight = this.ensuring.get(key);
    if (inflight) return inflight;
    const promise = this.doEnsureEpic(workspaceId, epicRef).finally(() => this.ensuring.delete(key));
    this.ensuring.set(key, promise);
    return promise;
  }

  private epicDir(workspaceId: number, epicRef: TrackerRef, workspaceName: string | null): string {
    return join(this.deps.dataDir, 'archive', workspaceSlug(workspaceName, workspaceId), `epic-${safeSegment(epicRef)}`);
  }

  private async existingOwnerDir(owner: TaskRow | { workspaceId: number; epicRef: TrackerRef }): Promise<string | null> {
    if (!('epicRef' in owner)) return this.existingDir(owner);
    const dir = this.epicDir(owner.workspaceId, owner.epicRef, await this.deps.workspaceName(owner.workspaceId));
    return (await pathExists(join(dir, 'archive.json'))) ? dir : null;
  }

  /** The locator of a critic step's archived `prompt.md`, whichever verification stage wrote it; null when none exists. */
  async archivedCriticPromptKey(
    owner: TaskRow | { workspaceId: number; epicRef: TrackerRef },
    attemptNumber: number,
    stepId: string,
  ): Promise<string | null> {
    const root = await this.existingOwnerDir(owner);
    if (!root) return null;
    for (const stage of ['pre-merge', 'post-merge'] as const) {
      const key = criticPromptKey(stage, stepId);
      if (await pathExists(join(root, 'attempts', String(attemptNumber), key))) return key;
    }
    return null;
  }

  async archivedVerificationOutput(
    owner: TaskRow | { workspaceId: number; epicRef: TrackerRef },
    attemptNumber: number,
    fullOutputKey: string,
  ): Promise<string | null> {
    try {
      const root = await this.existingOwnerDir(owner);
      if (!root) return null;
      const attemptDir = join(root, 'attempts', String(attemptNumber));
      const file = resolve(attemptDir, fullOutputKey);
      if (!file.startsWith(attemptDir + sep)) return null;
      return (await pathExists(file)) ? file : null;
    } catch (err) {
      warn('archive: verification output lookup failed', err, { attemptNumber, fullOutputKey });
      return null;
    }
  }

  /** Read an archived Resolved Prompt (`prompt.md`) by its Attempt-relative locator, in chunks that yield the event loop; null when the locator is not a prompt file under the Attempt or the file is absent. */
  async readArchivedPrompt(
    owner: TaskRow | { workspaceId: number; epicRef: TrackerRef },
    attemptNumber: number,
    locator: string,
    yieldNow: () => Promise<void> = yieldToEventLoop,
  ): Promise<string | null> {
    try {
      const root = await this.existingOwnerDir(owner);
      if (!root) return null;
      return await this.readPromptFile(join(root, 'attempts', String(attemptNumber)), locator, yieldNow);
    } catch (err) {
      warn('archive: resolved prompt read failed', err, { attemptNumber, locator });
      return null;
    }
  }

  /** Each prompt of a step's `prompt.md`, position = prompt index. */
  async readArchivedPromptSegments(
    owner: TaskRow | { workspaceId: number; epicRef: TrackerRef },
    attemptNumber: number,
    locator: string,
    yieldNow: () => Promise<void> = yieldToEventLoop,
  ): Promise<string[] | null> {
    try {
      const root = await this.existingOwnerDir(owner);
      if (!root) return null;
      const attemptDir = join(root, 'attempts', String(attemptNumber));
      const body = await this.readPromptFile(attemptDir, locator, yieldNow, { raw: true });
      if (!body) return null;
      return readPromptSegments(body, await this.readPromptSpans(attemptDir, locator, body.length, yieldNow));
    } catch (err) {
      warn('archive: resolved prompt segments read failed', err, { attemptNumber, locator });
      return null;
    }
  }

  private async readPromptSpans(attemptDir: string, locator: string, bodyBytes: number, yieldNow: () => Promise<void>): Promise<PromptSpan[] | null> {
    const index = await this.readPromptFile(attemptDir, join(dirname(locator), PROMPT_INDEX_FILE), yieldNow, { raw: true, name: PROMPT_INDEX_FILE });
    return index ? parsePromptSpans(index.toString('utf8'), bodyBytes) : null;
  }

  private async readPromptFile(baseDir: string, locator: string, yieldNow: () => Promise<void>): Promise<string | null>;
  private async readPromptFile(baseDir: string, locator: string, yieldNow: () => Promise<void>, options: { raw: true; name?: string; range?: { start: number; length: number } }): Promise<Buffer | null>;
  private async readPromptFile(
    baseDir: string,
    locator: string,
    yieldNow: () => Promise<void>,
    options: { raw?: boolean; name?: string; range?: { start: number; length: number } } = {},
  ): Promise<string | Buffer | null> {
    const file = resolve(baseDir, locator);
    if (!file.startsWith(baseDir + sep) || basename(file) !== (options.name ?? 'prompt.md')) return null;
    try {
      const handle = await open(file, 'r');
      try {
        const chunks: Buffer[] = [];
        let position = options.range?.start ?? 0;
        const end = options.range ? options.range.start + options.range.length : Number.POSITIVE_INFINITY;
        while (position < end) {
          const buffer = Buffer.allocUnsafe(Math.min(PROMPT_READ_CHUNK_BYTES, end - position));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          chunks.push(buffer.subarray(0, bytesRead));
          position += bytesRead;
          await yieldNow();
        }
        const all = Buffer.concat(chunks);
        return options.raw ? all : all.toString('utf8');
      } finally {
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EISDIR') return null;
      throw err;
    }
  }

  /** The whole archived prompt file, or only its `index`-th prompt; null when absent or out of range. */
  async readResolvedPrompt(
    owner: TaskRow | { workspaceId: number; epicRef: TrackerRef },
    attemptNumber: number,
    locator: string,
    index?: number,
    yieldNow: () => Promise<void> = yieldToEventLoop,
  ): Promise<string | null> {
    if (index === undefined) return this.readArchivedPrompt(owner, attemptNumber, locator, yieldNow);
    try {
      const root = await this.existingOwnerDir(owner);
      if (!root) return null;
      const attemptDir = join(root, 'attempts', String(attemptNumber));
      const file = resolve(attemptDir, locator);
      const bodyBytes = await stat(file).then((s) => s.size, () => null);
      if (bodyBytes === null) return null;
      const span = (await this.readPromptSpans(attemptDir, locator, bodyBytes, yieldNow))?.find((candidate) => candidate.index === index);
      if (span) return await this.readPromptFile(attemptDir, locator, yieldNow, { raw: true, range: span }).then((buf) => buf?.toString('utf8') ?? null);
      return (await this.readArchivedPromptSegments(owner, attemptNumber, locator, yieldNow))?.[index] || null;
    } catch (err) {
      warn('archive: resolved prompt read failed', err, { attemptNumber, locator, index });
      return null;
    }
  }

  async archivedTranscript(
    owner: TaskRow | { workspaceId: number; epicRef: TrackerRef },
    attemptNumber: number,
    kind: 'implementation' | 'verification',
    nativePath: string | null,
  ): Promise<string | null> {
    try {
      const root = await this.existingOwnerDir(owner);
      if (!root) return null;
      const attemptDir = join(root, 'attempts', String(attemptNumber), kind);
      const name = nativePath ? basename(nativePath) : null;
      if (kind === 'implementation') {
        const native = join(attemptDir, 'native');
        if (name) return (await pathExists(join(native, name))) ? join(native, name) : null;
        const files = (await readdir(native, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
        return files.length === 1 ? join(native, files[0]!.name) : null;
      }
      if (!name) return null;
      const subdirs = async (dir: string) => (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
      for (const stage of await subdirs(attemptDir)) {
        for (const step of await subdirs(join(attemptDir, stage))) {
          const candidate = join(attemptDir, stage, step, 'native', name);
          if (await pathExists(candidate)) return candidate;
        }
      }
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') {
        warn('archive: transcript lookup failed', err, { attemptNumber, kind });
      }
      return null;
    }
  }

  private async doEnsureEpic(workspaceId: number, epicRef: TrackerRef): Promise<string> {
    const workspaceName = await this.deps.workspaceName(workspaceId);
    const dir = this.epicDir(workspaceId, epicRef, workspaceName);
    await mkdir(dir, { recursive: true });
    await this.writeManifestIfAbsent(dir, {
      epicRef,
      workspace: workspaceName,
      workspaceId,
      title: `Epic #${epicRef}`,
      createdAt: new Date().toISOString(),
      dispositions: [],
      exports: [],
    });
    return dir;
  }

  private async makeDir(dir: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** Prompts already archived in a step directory; a resumed step appends, so new prompts must not reuse an index. */
  private async archivedPromptCount(dir: Promise<string>): Promise<number> {
    try {
      const root = await dir;
      const bodyBytes = await stat(join(root, 'prompt.md')).then((s) => s.size, () => 0);
      if (bodyBytes === 0) return 0;
      const sidecar = await readFile(join(root, PROMPT_INDEX_FILE), 'utf8').catch(() => null);
      const spans = sidecar === null ? null : parsePromptSpans(sidecar, bodyBytes);
      const last = spans?.at(-1);
      if (last && last.start + last.length === bodyBytes) return last.index + 1;
      return readPromptSegments(await readFile(join(root, 'prompt.md')), spans).length;
    } catch {
      return 0;
    }
  }

  private stepWriter(dir: Promise<string>, relDir: string, fields: Record<string, unknown>): StepArchiveWriter {
    dir.catch((err) => warn('archive: step directory failed', err, fields));
    const prompts = new AppendFile(dir, 'prompt.md');
    const promptIndex = new AppendFile(dir, PROMPT_INDEX_FILE);
    let promptChain: Promise<unknown> = Promise.resolve();
    let count: number | null = null;
    const updates = new AppendFile(dir, 'acp.jsonl');
    let closing: Promise<void> | null = null;
    let natives: Promise<void> = Promise.resolve();
    return {
      dir,
      promptLocator: `${relDir}/prompt.md`,
      appendPrompt: (text) => {
        const appended = promptChain.then(async () => {
          count ??= await this.archivedPromptCount(dir);
          const index = count;
          if (!(await prompts.write(text, PROMPT_SEPARATOR, (start, length) => { promptIndex.write(promptSpanLine({ index, start, length })); }))) return null;
          count = index + 1;
          return index;
        });
        promptChain = appended;
        return appended;
      },
      appendUpdate: (update) => {
        let line: string;
        try {
          line = JSON.stringify({ ts: Date.now(), update });
        } catch (err) {
          warn('archive: update not serialisable', err, fields);
          return;
        }
        updates.write(`${line}\n`);
      },
      copyNative: (harness, transcriptPath) => {
        natives = natives.then(() => this.copyNativeInto(() => dir, harness, transcriptPath, fields));
        return natives;
      },
      close: () => (closing ??= Promise.all([promptChain.then(() => prompts.close()).then(() => promptIndex.close()), updates.close(), natives]).then(() => undefined)),
    };
  }

  async copyNative(task: TaskRow, attemptNumber: number, harness: string, transcriptPath: string | null): Promise<void> {
    if (!transcriptPath) return;
    await this.copyNativeInto(() => this.implementationDir(task, attemptNumber), harness, transcriptPath, { taskId: task.id });
  }

  private async copyNativeInto(dir: () => Promise<string>, harness: string, transcriptPath: string | null, fields: Record<string, unknown>): Promise<void> {
    if (!transcriptPath || !(await pathExists(transcriptPath))) return;
    try {
      const native = join(await dir(), 'native');
      await mkdir(native, { recursive: true });
      await copyFile(transcriptPath, join(native, basename(transcriptPath)));
      const subagents = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents');
      let entries: string[] = [];
      try {
        entries = (await readdir(subagents, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
      } catch {
        return;
      }
      if (entries.length === 0) return;
      const stem = basename(transcriptPath, '.jsonl');
      await mkdir(join(native, stem, 'subagents'), { recursive: true });
      for (const name of entries) {
        await copyFile(join(subagents, name), join(native, stem, 'subagents', name));
        await yieldToEventLoop();
      }
    } catch (err) {
      warn('archive: native transcript copy failed', err, { ...fields, harness });
    }
  }
}
