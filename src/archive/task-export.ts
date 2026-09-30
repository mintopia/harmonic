import { createWriteStream } from 'node:fs';
import { link, mkdir, readdir, readFile, rm, copyFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
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

export interface EpicExportMember {
  ref: number;
  task: TaskRow | null;
}

export interface EpicExportSnapshot extends ExportSnapshot {
  members: EpicExportMember[];
}

export interface ExportOutcome {
  status: 'succeeded' | 'failed';
  file: string | null;
  error?: string;
}

export interface TaskExporterDeps {
  dataDir: string;
  archive: Pick<TaskArchive, 'ensure' | 'recordExport' | 'ensureEpic' | 'recordEpicExport' | 'exportHistory' | 'epicExportHistory'>;
  version: string;
  settings: (task: TaskRow) => Promise<ResolvedExportSettings>;
  epicSettings: (workspaceId: number) => Promise<ResolvedExportSettings>;
  epicSnapshot: (workspaceId: number, epicRef: number) => Promise<EpicExportSnapshot>;
  workspaceName: (workspaceId: number) => Promise<string | null>;
  snapshot: (task: TaskRow) => Promise<ExportSnapshot>;
  recordFact: (taskId: number, payload: unknown) => Promise<void>;
  now?: () => Date;
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

const taskChainKey = (taskId: number): string => `task:${taskId}`;
const epicChainKey = (workspaceId: number, epicRef: number): string => `epic:${workspaceId}:${epicRef}`;

function exportRecord(disposition: ExportDisposition, outcome: ExportOutcome, at: Date): ExportRecord {
  return {
    destination: 'directory',
    disposition,
    file: outcome.file,
    status: outcome.status,
    at: at.toISOString(),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  };
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

interface EpicMemberEntry {
  ref: number;
  taskId: number | null;
  status: string | null;
  export: string | null;
}

function epicReadme(args: { epicRef: number; ticket: unknown; workspace: string | null; disposition: string; exportedAt: string; attemptCount: number; members: EpicMemberEntry[] }): string {
  const { epicRef, ticket, workspace, disposition, exportedAt, attemptCount, members } = args;
  const title = (ticket as { title?: unknown } | null)?.title;
  const heading = typeof title === 'string' && title.trim() !== '' ? title.trim() : `Epic #${epicRef}`;
  return [
    `# ${heading}`,
    '',
    `- Epic: #${epicRef}`,
    `- Workspace: ${workspace ?? 'none'}`,
    `- Disposition: ${disposition}`,
    `- Exported: ${exportedAt}`,
    `- Epic Attempts: ${attemptCount}`,
    '',
    '## Members',
    '',
    'Each Member has its own Export; it is referenced here, not copied.',
    '',
    '| Member | Status | Export |',
    '| --- | --- | --- |',
    ...members.map((m) => `| #${m.ref} | ${m.status ?? 'unknown'} | ${m.export === null ? 'none' : `\`${m.export}\``} |`),
    '',
    '## Contents',
    '',
    '| Path | Description |',
    '| --- | --- |',
    '| `manifest.json` | Export format, versions, counts, redaction summary and Members |',
    '| `README.md` | This file |',
    '| `ticket.json` | The Epic as shown in Harmonic when it was exported |',
    '| `timeline.json` | The Epic timeline and Epic Attempts |',
    '| `operator-inputs.json` | Guidance and answers the operator gave during the Epic |',
    '| `archive.json` | The Epic Archive identity and its Export history |',
    '| `attempts/<n>/verification/` | Verification command output and Critic transcripts for Epic Attempt n |',
    '',
  ].join('\n');
}

export class TaskExporter {
  private readonly chains = new Map<string, Promise<unknown>>();

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
    await forEachYielding(names, async (name) => {
      try {
        await rm(join(stagingDir, name), { recursive: true, force: true });
      } catch (err) {
        logger.warn('export: staging entry not removed', { entry: name, error: message(err) });
      }
    });
  }

  private enqueue(key: string, work: () => Promise<unknown>, context: Record<string, string | number>): void {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.chains.set(key, next);
    fireAndForget(
      async () => {
        try {
          await next;
        } finally {
          if (this.chains.get(key) === next) this.chains.delete(key);
        }
      },
      { op: 'export.trigger', level: 'warn', context },
    );
  }

  trigger(task: TaskRow, disposition: ExportDisposition): void {
    const snapshot = this.deps.snapshot(task);
    snapshot.catch(() => undefined);
    this.enqueue(taskChainKey(task.id), () => this.run(task, disposition, snapshot), { taskId: task.id, disposition });
  }

  /** Must be awaited before the Task's rows are removed; never throws. */
  async captureForDelete(task: TaskRow): Promise<void> {
    try {
      const settings = await this.deps.settings(task);
      if (!settings.enabled || !settings.includeStates.includes('deleted') || !settings.directoryPath) return;
      const snapshot = await this.deps.snapshot(task);
      if (snapshot.attemptCount === 0) return;
      this.enqueue(taskChainKey(task.id), () => this.run(task, 'deleted', Promise.resolve(snapshot)), { taskId: task.id, disposition: 'deleted' });
    } catch (err) {
      logger.warn('export: delete snapshot failed', { taskId: task.id, error: message(err) });
    }
  }

  triggerEpic(workspaceId: number, epicRef: number, disposition: ExportDisposition): void {
    const snapshot = this.deps.epicSnapshot(workspaceId, epicRef);
    snapshot.catch(() => undefined);
    this.enqueue(epicChainKey(workspaceId, epicRef), () => this.runEpic(workspaceId, epicRef, disposition, snapshot), { workspaceId, epicRef, disposition });
  }

  async runEpic(workspaceId: number, epicRef: number, disposition: ExportDisposition, snapshot?: Promise<EpicExportSnapshot>): Promise<ExportOutcome | null> {
    let settings: ResolvedExportSettings;
    try {
      settings = await this.deps.epicSettings(workspaceId);
    } catch (err) {
      logger.warn('export: epic settings unavailable', { workspaceId, epicRef, error: message(err) });
      return null;
    }
    if (!settings.enabled || !settings.includeStates.includes(disposition) || !settings.directoryPath) return null;

    const prior = await this.deps.archive.epicExportHistory(workspaceId, epicRef);
    if (prior.some((e) => e.status === 'succeeded' && e.disposition === disposition)) return null;

    const at = (this.deps.now ?? (() => new Date()))();
    let outcome: ExportOutcome;
    try {
      outcome = { status: 'succeeded', file: await this.epicToDirectory(workspaceId, epicRef, disposition, settings.directoryPath, at, snapshot) };
    } catch (err) {
      outcome = { status: 'failed', file: null, error: message(err) };
      logger.warn('export: epic failed', { workspaceId, epicRef, disposition, error: outcome.error });
    }
    const entry = exportRecord(disposition, outcome, at);
    try {
      await this.deps.archive.recordEpicExport(workspaceId, epicRef, entry);
    } catch (err) {
      logger.warn('export: epic archive history not updated', { workspaceId, epicRef, error: message(err) });
    }
    return outcome;
  }

  private async memberEntries(members: EpicExportMember[]): Promise<EpicMemberEntry[]> {
    const entries: EpicMemberEntry[] = [];
    await forEachYielding(members, async ({ ref, task }) => {
      if (!task) {
        entries.push({ ref, taskId: null, status: null, export: null });
        return;
      }
      await this.chains.get(taskChainKey(task.id))?.catch(() => undefined);
      const history = await this.deps.archive.exportHistory(task);
      const latest = [...history].reverse().find((e) => e.status === 'succeeded' && e.file !== null);
      entries.push({ ref, taskId: task.id, status: task.state, export: latest?.file ? basename(latest.file) : null });
    });
    return entries;
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

    const at = (this.deps.now ?? (() => new Date()))();
    let outcome: ExportOutcome;
    try {
      outcome = { status: 'succeeded', file: await this.exportToDirectory(task, disposition, settings.directoryPath, at, snapshot) };
    } catch (err) {
      outcome = { status: 'failed', file: null, error: message(err) };
      logger.warn('export: failed', { taskId: task.id, disposition, error: outcome.error });
    }
    await this.record(task, disposition, outcome, at);
    return outcome;
  }

  private async record(task: TaskRow, disposition: ExportDisposition, outcome: ExportOutcome, at: Date): Promise<void> {
    const entry = exportRecord(disposition, outcome, at);
    if (disposition !== 'deleted') {
      const { at: _at, ...fact } = entry;
      try {
        await this.deps.recordFact(task.id, { event: 'export', ...fact });
      } catch (err) {
        logger.warn('export: fact not recorded', { taskId: task.id, error: message(err) });
      }
    }
    try {
      await this.deps.archive.recordExport(task, entry);
    } catch (err) {
      logger.warn('export: archive history not updated', { taskId: task.id, error: message(err) });
    }
  }

  private async epicToDirectory(workspaceId: number, epicRef: number, disposition: ExportDisposition, root: string, at: Date, pending?: Promise<EpicExportSnapshot>): Promise<string> {
    const snapshot = await (pending ?? this.deps.epicSnapshot(workspaceId, epicRef));
    const members = await this.memberEntries(snapshot.members);
    const archiveDir = await this.deps.archive.ensureEpic(workspaceId, epicRef);
    const workspace = await this.deps.workspaceName(workspaceId);
    return this.stageAndDeliver({
      stagedName: `epic-${epicRef}`,
      root: join(root, workspaceSlug(workspace, workspaceId)),
      base: `epic-${epicRef}-${disposition}-${exportTimestamp(at)}`,
      build: (staged) =>
        this.buildTarball(staged, archiveDir, snapshot, at, ({ files, partial }) => ({
          manifest: {
            format: 'harmonic-epic-export',
            formatVersion: 1,
            harmonicVersion: this.deps.version,
            epicRef,
            workspaceId,
            workspace,
            disposition,
            exportedAt: at.toISOString(),
            counts: { archiveFiles: files, attempts: snapshot.attemptCount, members: members.length },
            redaction: { applied: false, matches: {} },
            partial,
            members,
          },
          readme: epicReadme({ epicRef, ticket: snapshot.ticket, workspace, disposition, exportedAt: at.toISOString(), attemptCount: snapshot.attemptCount, members }),
        })),
    });
  }

  private async exportToDirectory(task: TaskRow, disposition: ExportDisposition, root: string, at: Date, pending?: Promise<ExportSnapshot>): Promise<string> {
    const snapshot = await (pending ?? this.deps.snapshot(task));
    const archiveDir = await this.deps.archive.ensure(task);
    const workspace = task.workspaceId === null ? null : await this.deps.workspaceName(task.workspaceId);
    return this.stageAndDeliver({
      stagedName: String(task.id),
      root: join(root, workspaceSlug(workspace, task.workspaceId)),
      base: this.fileName(task, disposition, at),
      build: (staged) =>
        this.buildTarball(staged, archiveDir, snapshot, at, ({ files, partial }) => ({
          manifest: {
            format: 'harmonic-task-export',
            formatVersion: 1,
            harmonicVersion: this.deps.version,
            taskId: task.id,
            archiveId: task.archiveId,
            trackerRef: task.trackerRef,
            workspace,
            disposition,
            exportedAt: at.toISOString(),
            counts: { archiveFiles: files, attempts: snapshot.attemptCount },
            redaction: { applied: false, matches: {} },
            partial,
          },
          readme: readme({ task, ticket: snapshot.ticket, workspace, disposition, exportedAt: at.toISOString(), attemptCount: snapshot.attemptCount }),
        })),
    });
  }

  private async stageAndDeliver(args: { stagedName: string; root: string; base: string; build: (staged: string) => Promise<void> }): Promise<string> {
    const stagingDir = join(this.deps.dataDir, 'archive', '.staging');
    await mkdir(stagingDir, { recursive: true });
    const staged = join(stagingDir, `${args.stagedName}-${randomBytes(6).toString('hex')}.tar.gz`);
    try {
      await args.build(staged);
      return await this.deliver(staged, args.root, args.base);
    } finally {
      await rm(staged, { force: true });
    }
  }

  private fileName(task: TaskRow, disposition: ExportDisposition, at: Date): string {
    const ref = task.trackerRef != null ? `-${task.trackerRef}` : '';
    return `${task.id}${ref}-${disposition}-${exportTimestamp(at)}`;
  }

  private async buildTarball(
    staged: string,
    archiveDir: string,
    snapshot: ExportSnapshot,
    at: Date,
    describe: (result: { files: number; partial: boolean }) => { manifest: unknown; readme: string },
  ): Promise<void> {
    const writer = new TarGzWriter(createWriteStream(staged));
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
      const described = describe({ files, partial: snapshot.attemptCount > 0 && !hasAttempts });
      await writer.addBuffer('manifest.json', json(described.manifest), at);
      await writer.addBuffer('README.md', described.readme, at);
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
