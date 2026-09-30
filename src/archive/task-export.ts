import { createWriteStream } from 'node:fs';
import { link, mkdir, readdir, readFile, rm, copyFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { ExportState } from '../config.js';
import type { TaskRow } from '../db/schema.js';
import { fireAndForget } from '../error-handling.js';
import { logger } from '../logger.js';
import { forEachYielding } from '../reliability/yield.js';
import type { ResolvedExportSettings } from './export-settings.js';
import { workspaceSlug, type ExportRecord, type TaskArchive } from './task-archive.js';
import { TarGzWriter, addDirectory } from './tar-gz.js';

export type ExportDisposition = ExportState;

export interface ExportSnapshot {
  ticket: unknown;
  timeline: unknown;
  attemptCount: number;
}

export type ExportDestination = 'directory';

export interface ExportFailure {
  task: TaskRow;
  disposition: ExportDisposition;
  destination: ExportDestination;
  error: string;
  retry: number;
  nextRetryAt: string | null;
}

export const EXPORT_RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;

const MAX_RETRIES_PER_SWEEP = 20;
const PENDING_SUFFIX = '.pending.json';
const TARBALL_SUFFIX = '.tar.gz';

interface PendingDestination {
  destination: ExportDestination;
  dir: string;
  base: string;
  retries: number;
  nextRetryAt: string;
}

interface PendingExport {
  task: TaskRow;
  disposition: ExportDisposition;
  firstFailedAt: string;
  destinations: PendingDestination[];
}

export interface ExportOutcome {
  status: 'succeeded' | 'failed';
  file: string | null;
  error?: string;
}

export interface TaskExporterDeps {
  dataDir: string;
  archive: Pick<TaskArchive, 'ensure' | 'recordExport'>;
  version: string;
  settings: (task: TaskRow) => Promise<ResolvedExportSettings>;
  workspaceName: (workspaceId: number) => Promise<string | null>;
  snapshot: (task: TaskRow) => Promise<ExportSnapshot>;
  recordFact: (taskId: number, payload: unknown) => Promise<void>;
  now?: () => Date;
  onFailure?: (failure: ExportFailure) => void;
}

const OPERATOR_INPUTS_FILE = 'operator-inputs.jsonl';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function exportTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '');
}

function parseOperatorInputs(raw: string): unknown[] {
  const inputs: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      inputs.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return inputs;
}

async function readOperatorInputs(archiveDir: string): Promise<unknown[]> {
  try {
    return parseOperatorInputs(await readFile(join(archiveDir, OPERATOR_INPUTS_FILE), 'utf8'));
  } catch {
    return [];
  }
}

function pendingPath(staged: string): string {
  return `${staged.slice(0, -TARBALL_SUFFIX.length)}${PENDING_SUFFIX}`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readme(args: {
  task: TaskRow;
  ticket: unknown;
  workspace: string | null;
  disposition: string;
  exportedAt: string;
  attemptCount: number;
}): string {
  const { task, ticket, workspace, disposition, exportedAt, attemptCount } = args;
  const title = (ticket as { title?: unknown } | null)?.title;
  const heading = typeof title === 'string' && title.trim() !== '' ? title.trim() : `Task ${task.id}`;
  const url = (ticket as { trackerUrl?: unknown } | null)?.trackerUrl;
  return [
    `# ${heading}`,
    '',
    `- Task: ${task.id}`,
    `- Tracker reference: ${task.trackerRef ?? 'none'}`,
    `- Tracker URL: ${typeof url === 'string' && url !== '' ? url : 'none'}`,
    `- Workspace: ${workspace ?? 'none'}`,
    `- Disposition: ${disposition}`,
    `- Created: ${new Date(task.createdAt).toISOString()}`,
    `- Exported: ${exportedAt}`,
    `- Attempts: ${attemptCount}`,
    '',
    '## Contents',
    '',
    '| Path | Description |',
    '| --- | --- |',
    '| `manifest.json` | Export format, versions, counts and redaction summary |',
    '| `README.md` | This file |',
    '| `ticket.json` | The Task as shown in Harmonic when it was exported |',
    '| `timeline.json` | The Task timeline (Attempts, verification, merge, Facts) |',
    '| `operator-inputs.json` | Guidance and answers the operator gave during the Task |',
    '| `archive.json` | The Archive identity and its Export history |',
    '| `attempts/<n>/implementation/` | Prompt, ACP updates and native transcripts for Attempt n |',
    '',
  ].join('\n');
}

export class TaskExporter {
  private readonly chains = new Map<number, Promise<unknown>>();
  private retrying = false;

  constructor(private readonly deps: TaskExporterDeps) {}

  async sweepStaging(): Promise<void> {
    const stagingDir = join(this.deps.dataDir, 'archive', '.staging');
    let names: string[];
    try {
      names = await readdir(stagingDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('export: staging sweep failed', { error: message(err) });
      return;
    }
    const present = new Set(names);
    const keep = (name: string): boolean => {
      if (name.endsWith(TARBALL_SUFFIX)) return present.has(`${name.slice(0, -TARBALL_SUFFIX.length)}${PENDING_SUFFIX}`);
      if (name.endsWith(PENDING_SUFFIX)) return present.has(`${name.slice(0, -PENDING_SUFFIX.length)}${TARBALL_SUFFIX}`);
      return false;
    };
    await forEachYielding(names, async (name) => {
      if (keep(name)) return;
      try {
        await rm(join(stagingDir, name), { recursive: true, force: true });
      } catch (err) {
        logger.warn('export: staging entry not removed', { entry: name, error: message(err) });
      }
    });
  }

  trigger(task: TaskRow, disposition: ExportDisposition): void {
    const snapshot = this.deps.snapshot(task);
    snapshot.catch(() => undefined);
    this.enqueue(task, disposition, snapshot);
  }

  /** Must be awaited before the Task's rows are removed; never throws. */
  async captureForDelete(task: TaskRow): Promise<void> {
    try {
      const settings = await this.deps.settings(task);
      if (!settings.enabled || !settings.includeStates.includes('deleted') || !settings.directoryPath) return;
      const snapshot = await this.deps.snapshot(task);
      if (snapshot.attemptCount === 0) return;
      this.enqueue(task, 'deleted', Promise.resolve(snapshot));
    } catch (err) {
      logger.warn('export: delete snapshot failed', { taskId: task.id, error: message(err) });
    }
  }

  private enqueue(task: TaskRow, disposition: ExportDisposition, snapshot: Promise<ExportSnapshot>): void {
    const next = this.serialize(task.id, () => this.run(task, disposition, snapshot));
    fireAndForget(() => next, { op: 'export.trigger', level: 'warn', context: { taskId: task.id, disposition } });
  }

  private serialize<T>(taskId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.chains.set(taskId, next);
    const cleanup = (): void => {
      if (this.chains.get(taskId) === next) this.chains.delete(taskId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async run(task: TaskRow, disposition: ExportDisposition, snapshot?: Promise<ExportSnapshot>): Promise<ExportOutcome | null> {
    let settings: ResolvedExportSettings;
    try {
      settings = await this.deps.settings(task);
    } catch (err) {
      logger.warn('export: settings unavailable', { taskId: task.id, error: message(err) });
      return null;
    }
    if (!settings.enabled || !settings.includeStates.includes(disposition) || !settings.directoryPath) return null;

    const at = this.now();
    const stagingDir = join(this.deps.dataDir, 'archive', '.staging');
    let staged: string | null = null;
    let outcome: ExportOutcome;
    let target: { dir: string; base: string } | null = null;
    try {
      const built = await this.stage(task, disposition, stagingDir, at, snapshot);
      staged = built.staged;
      target = { dir: join(settings.directoryPath, built.slug), base: this.fileName(task, disposition, at) };
      outcome = { status: 'succeeded', file: await this.deliver(staged, target.dir, target.base) };
    } catch (err) {
      outcome = { status: 'failed', file: null, error: message(err) };
      logger.warn('export: failed', { taskId: task.id, disposition, error: outcome.error });
    }
    await this.record(task, disposition, outcome, at, 0);
    if (outcome.status === 'succeeded') {
      if (staged) await rm(staged, { force: true });
      return outcome;
    }
    let nextRetryAt: string | null = null;
    if (staged && target) {
      const first = at.toISOString();
      nextRetryAt = new Date(at.getTime() + EXPORT_RETRY_DELAYS_MS[0]).toISOString();
      const pending: PendingExport = {
        task,
        disposition,
        firstFailedAt: first,
        destinations: [{ destination: 'directory', dir: target.dir, base: target.base, retries: 0, nextRetryAt }],
      };
      try {
        await this.writePending(pendingPath(staged), pending);
      } catch (err) {
        logger.warn('export: retry not scheduled', { taskId: task.id, error: message(err) });
        nextRetryAt = null;
        await rm(staged, { force: true });
      }
    } else if (staged) {
      await rm(staged, { force: true });
    }
    this.notifyFailure({ task, disposition, destination: 'directory', error: outcome.error ?? 'export failed', retry: 0, nextRetryAt });
    return outcome;
  }

  async retryDue(): Promise<void> {
    if (this.retrying) return;
    this.retrying = true;
    try {
      const stagingDir = join(this.deps.dataDir, 'archive', '.staging');
      let names: string[];
      try {
        names = (await readdir(stagingDir)).filter((n) => n.endsWith(PENDING_SUFFIX));
      } catch {
        return;
      }
      let budget = MAX_RETRIES_PER_SWEEP;
      await forEachYielding(names, async (name) => {
        if (budget <= 0) return;
        try {
          budget -= await this.retrySidecar(join(stagingDir, name));
        } catch (err) {
          logger.warn('export: retry pass failed', { entry: name, error: message(err) });
        }
      });
    } catch (err) {
      logger.warn('export: retry sweep failed', { error: message(err) });
    } finally {
      this.retrying = false;
    }
  }

  private async retrySidecar(sidecar: string): Promise<number> {
    const pending = await this.readPending(sidecar);
    if (!pending) return 0;
    return this.serialize(pending.task.id, async () => {
      const current = await this.readPending(sidecar);
      if (!current) return 0;
      const staged = `${sidecar.slice(0, -PENDING_SUFFIX.length)}${TARBALL_SUFFIX}`;
      const nowMs = this.now().getTime();
      const first = Date.parse(current.firstFailedAt);
      let attempted = 0;
      const remaining: PendingDestination[] = [];
      for (const dest of current.destinations) {
        if (attempted >= MAX_RETRIES_PER_SWEEP || Date.parse(dest.nextRetryAt) > nowMs) {
          remaining.push(dest);
          continue;
        }
        attempted++;
        const at = this.now();
        const retry = dest.retries + 1;
        let outcome: ExportOutcome;
        try {
          outcome = { status: 'succeeded', file: await this.deliver(staged, dest.dir, dest.base) };
        } catch (err) {
          outcome = { status: 'failed', file: null, error: message(err) };
          logger.warn('export: retry failed', { taskId: current.task.id, retry, error: outcome.error });
        }
        await this.record(current.task, current.disposition, outcome, at, retry);
        if (outcome.status === 'succeeded') continue;
        const nextRetryAt = retry < EXPORT_RETRY_DELAYS_MS.length ? new Date(first + EXPORT_RETRY_DELAYS_MS[retry]!).toISOString() : null;
        if (nextRetryAt) remaining.push({ ...dest, retries: retry, nextRetryAt });
        this.notifyFailure({
          task: current.task,
          disposition: current.disposition,
          destination: dest.destination,
          error: outcome.error ?? 'export failed',
          retry,
          nextRetryAt,
        });
      }
      if (remaining.length === 0) {
        await rm(sidecar, { force: true });
        await rm(staged, { force: true });
      } else if (attempted > 0) {
        await this.writePending(sidecar, { ...current, destinations: remaining });
      }
      return attempted;
    });
  }

  private async readPending(sidecar: string): Promise<PendingExport | null> {
    try {
      const value = JSON.parse(await readFile(sidecar, 'utf8')) as Partial<PendingExport> | null;
      if (!value || typeof value.task?.id !== 'number' || typeof value.firstFailedAt !== 'string' || !Array.isArray(value.destinations)) {
        throw new Error('malformed sidecar');
      }
      return value as PendingExport;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('export: pending sidecar unreadable', { sidecar, error: message(err) });
      return null;
    }
  }

  private async writePending(path: string, pending: PendingExport): Promise<void> {
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(pending));
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private notifyFailure(failure: ExportFailure): void {
    try {
      this.deps.onFailure?.(failure);
    } catch (err) {
      logger.warn('export: failure hook threw', { taskId: failure.task.id, error: message(err) });
    }
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async record(task: TaskRow, disposition: ExportDisposition, outcome: ExportOutcome, at: Date, retry: number): Promise<void> {
    const base = { destination: 'directory' as const, disposition, file: outcome.file, status: outcome.status };
    const extra = { ...(outcome.error === undefined ? {} : { error: outcome.error }), ...(retry > 0 ? { retry } : {}) };
    if (disposition !== 'deleted') {
      try {
        await this.deps.recordFact(task.id, { event: 'export', ...base, ...extra });
      } catch (err) {
        logger.warn('export: fact not recorded', { taskId: task.id, error: message(err) });
      }
    }
    const entry: ExportRecord = { ...base, at: at.toISOString(), ...extra };
    try {
      await this.deps.archive.recordExport(task, entry);
    } catch (err) {
      logger.warn('export: archive history not updated', { taskId: task.id, error: message(err) });
    }
  }

  private async stage(
    task: TaskRow,
    disposition: ExportDisposition,
    stagingDir: string,
    at: Date,
    pending?: Promise<ExportSnapshot>,
  ): Promise<{ staged: string; slug: string }> {
    const snapshot = await (pending ?? this.deps.snapshot(task));
    const archiveDir = await this.deps.archive.ensure(task);
    const workspace = task.workspaceId === null ? null : await this.deps.workspaceName(task.workspaceId);
    const slug = workspaceSlug(workspace, task.workspaceId);
    await mkdir(stagingDir, { recursive: true });
    const staged = join(stagingDir, `${task.id}-${randomBytes(6).toString('hex')}${TARBALL_SUFFIX}`);
    try {
      await this.build(staged, archiveDir, task, disposition, workspace, snapshot, at);
    } catch (err) {
      await rm(staged, { force: true });
      throw err;
    }
    return { staged, slug };
  }

  private fileName(task: TaskRow, disposition: ExportDisposition, at: Date): string {
    const ref = task.trackerRef != null ? `-${task.trackerRef}` : '';
    return `${task.id}${ref}-${disposition}-${exportTimestamp(at)}`;
  }

  private async build(
    staged: string,
    archiveDir: string,
    task: TaskRow,
    disposition: ExportDisposition,
    workspace: string | null,
    snapshot: ExportSnapshot,
    at: Date,
  ): Promise<void> {
    const out = createWriteStream(staged);
    const writer = new TarGzWriter(out);
    const exportedAt = at.toISOString();
    const entries = (await readdir(archiveDir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const hasAttempts = entries.some((e) => e.isDirectory() && e.name === 'attempts');
    let files = 0;
    try {
      await writer.addBuffer('ticket.json', json(snapshot.ticket), at);
      await writer.addBuffer('timeline.json', json(snapshot.timeline), at);
      await writer.addBuffer('operator-inputs.json', json(await readOperatorInputs(archiveDir)), at);
      for (const entry of entries) {
        if (entry.isFile() && entry.name !== OPERATOR_INPUTS_FILE && !entry.name.endsWith('.tmp')) {
          await writer.addFile(entry.name, join(archiveDir, entry.name));
          files++;
        } else if (entry.isDirectory()) {
          files += await addDirectory(writer, join(archiveDir, entry.name), entry.name);
        }
      }
      const manifest = {
        format: 'harmonic-task-export',
        formatVersion: 1,
        harmonicVersion: this.deps.version,
        taskId: task.id,
        archiveId: task.archiveId,
        trackerRef: task.trackerRef,
        workspace,
        disposition,
        exportedAt,
        counts: { archiveFiles: files, attempts: snapshot.attemptCount },
        redaction: { applied: false, matches: {} },
        partial: snapshot.attemptCount > 0 && !hasAttempts,
      };
      await writer.addBuffer('manifest.json', json(manifest), at);
      await writer.addBuffer('README.md', readme({ task, ticket: snapshot.ticket, workspace, disposition, exportedAt, attemptCount: snapshot.attemptCount }), at);
      await writer.finish();
    } catch (err) {
      writer.abort(err instanceof Error ? err : new Error(message(err)));
      throw err;
    }
  }

  private async deliver(staged: string, dir: string, base: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `.${base}.${randomBytes(6).toString('hex')}.partial`);
    try {
      await copyFile(staged, temp);
      for (let n = 0; ; n++) {
        const final = join(dir, `${base}${n === 0 ? '' : `-${n}`}.tar.gz`);
        try {
          await link(temp, final);
          return final;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
}
