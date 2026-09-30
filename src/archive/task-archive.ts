import { createWriteStream, type WriteStream } from 'node:fs';
import { access, copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { TaskRow } from '../db/schema.js';
import { logger } from '../logger.js';
import { yieldToEventLoop } from '../reliability/yield.js';

export interface ArchiveDeps {
  dataDir: string;
  ensureArchiveId: (taskId: number) => Promise<string>;
  workspaceName: (workspaceId: number) => Promise<string | null>;
}

export interface StepArchiveWriter {
  readonly dir: Promise<string>;
  appendPrompt(text: string): void;
  appendUpdate(update: unknown): void;
  copyNative(harness: string, transcriptPath: string | null): Promise<void>;
  close(): Promise<void>;
}

export type CriticArchiveStage = 'pre-merge' | 'post-merge';

const PROMPT_SEPARATOR = '\n\n---\n\n';

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

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

class AppendFile {
  private stream: WriteStream | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private hasContent = false;

  constructor(private readonly dir: Promise<string>, private readonly name: string) {}

  write(data: string, separator = ''): void {
    if (this.closed) return;
    this.chain = this.chain.then(async () => {
      try {
        if (!this.stream) {
          const path = join(await this.dir, this.name);
          this.hasContent = await stat(path).then((s) => s.size > 0, () => false);
          this.stream = createWriteStream(path, { flags: 'a' });
          this.stream.on('error', (err) => warn('archive: append stream failed', err, { file: this.name }));
        }
        const stream = this.stream;
        if (stream.destroyed) return;
        if (this.hasContent) data = `${separator}${data}`;
        this.hasContent = true;
        await new Promise<void>((resolve, reject) => {
          stream.write(data, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } catch (err) {
        warn('archive: append failed', err, { file: this.name });
      }
    });
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

  constructor(private readonly deps: ArchiveDeps) {}

  ensure(task: TaskRow): Promise<string> {
    const key = String(task.id);
    const inflight = this.ensuring.get(key);
    if (inflight) return inflight;
    const promise = this.doEnsure(task).finally(() => this.ensuring.delete(key));
    this.ensuring.set(key, promise);
    return promise;
  }

  private async doEnsure(task: TaskRow): Promise<string> {
    const archiveId = task.archiveId ?? (await this.deps.ensureArchiveId(task.id));
    const workspaceName = task.workspaceId === null ? null : await this.deps.workspaceName(task.workspaceId);
    const dir = join(this.deps.dataDir, 'archive', workspaceSlug(workspaceName, task.workspaceId), `${task.id}-${archiveId}`);
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

  private async implementationDir(task: TaskRow, attemptNumber: number): Promise<string> {
    const dir = join(await this.ensure(task), 'attempts', String(attemptNumber), 'implementation');
    await mkdir(dir, { recursive: true });
    return dir;
  }

  implementationStep(task: TaskRow, attemptNumber: number): StepArchiveWriter {
    return this.stepWriter(this.implementationDir(task, attemptNumber), { taskId: task.id, attemptNumber });
  }

  criticStep(task: TaskRow, attemptNumber: number, stage: CriticArchiveStage, stepId: string): StepArchiveWriter {
    const dir = this.ensure(task).then((root) => this.makeDir(join(root, 'attempts', String(attemptNumber), 'verification', stage, stepId)));
    return this.stepWriter(dir, { taskId: task.id, attemptNumber, stage, stepId });
  }

  epicCriticStep(workspaceId: number, epicRef: number, attemptNumber: number, stepId: string): StepArchiveWriter {
    const dir = this.ensureEpic(workspaceId, epicRef).then((root) =>
      this.makeDir(join(root, 'attempts', String(attemptNumber), 'verification', 'pre-merge', stepId)),
    );
    return this.stepWriter(dir, { workspaceId, epicRef, attemptNumber, stepId });
  }

  ensureEpic(workspaceId: number, epicRef: number): Promise<string> {
    const key = `epic:${workspaceId}:${epicRef}`;
    const inflight = this.ensuring.get(key);
    if (inflight) return inflight;
    const promise = this.doEnsureEpic(workspaceId, epicRef).finally(() => this.ensuring.delete(key));
    this.ensuring.set(key, promise);
    return promise;
  }

  private async doEnsureEpic(workspaceId: number, epicRef: number): Promise<string> {
    const workspaceName = await this.deps.workspaceName(workspaceId);
    const dir = join(this.deps.dataDir, 'archive', workspaceSlug(workspaceName, workspaceId), `epic-${epicRef}`);
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

  private stepWriter(dir: Promise<string>, fields: Record<string, unknown>): StepArchiveWriter {
    dir.catch((err) => warn('archive: step directory failed', err, fields));
    const prompts = new AppendFile(dir, 'prompt.md');
    const updates = new AppendFile(dir, 'acp.jsonl');
    let closing: Promise<void> | null = null;
    let natives: Promise<void> = Promise.resolve();
    return {
      dir,
      appendPrompt: (text) => {
        prompts.write(text, PROMPT_SEPARATOR);
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
      close: () => (closing ??= Promise.all([prompts.close(), updates.close(), natives]).then(() => undefined)),
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
      await mkdir(join(native, 'subagents'), { recursive: true });
      for (const name of entries) {
        await copyFile(join(subagents, name), join(native, 'subagents', name));
        await yieldToEventLoop();
      }
    } catch (err) {
      warn('archive: native transcript copy failed', err, { ...fields, harness });
    }
  }
}
