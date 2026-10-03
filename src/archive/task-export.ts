import { trackerRef, type TrackerRef } from '../tracker/adapter.js';
import { createWriteStream } from 'node:fs';
import { link, mkdir, readdir, readFile, rm, copyFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { basename, join } from 'node:path';
import { EXPORT_STATES, type ExportState } from '../config.js';
import type { TaskRow } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import type { FireAndForget } from '../error-handling.js';
import { logger } from '../logger.js';
import { forEachYielding } from '../reliability/yield.js';
import type { EpicExportStep } from '../domain/epic-merge-events.js';
import { exportOwnerKey, type ExportOwner } from './export-owner.js';
import { hasExportDestination, type ResolvedExportSettings } from './export-settings.js';
import { uploadToS3 } from './s3-destination.js';
import { workspaceSlug, type ExportDestination, type ExportRecord, type TaskArchive } from './task-archive.js';
import { buildExportStatus, type ExportStatus, type PendingRetry } from './export-status.js';
import { Redactor, type RedactionPattern } from './redact.js';
import type { GitProvenance } from './git-provenance.js';
import { TarGzWriter, addDirectory, type TransformFactory } from './tar-gz.js';

export type ExportDisposition = ExportState;

export interface ExportSnapshot {
  ticket: unknown;
  timeline: unknown;
  agentMessages: unknown;
  attemptCount: number;
  git: GitProvenance;
}

export interface EpicExportMember {
  ref: TrackerRef;
  task: TaskRow | null;
}

export interface EpicExportSnapshot extends Omit<ExportSnapshot, 'git'> {
  members: EpicExportMember[];
}

export interface ExportMeta {
  builtAt: string;
  name: string;
  partial: boolean;
  bytes: number;
  redactions: Record<string, number>;
}

interface StagedExport {
  staged: string;
  slug: string;
  base: string;
  meta: ExportMeta;
}

export interface ManualExportOptions {
  forcePartial?: boolean;
}

export interface ExportDownload {
  path: string;
  name: string;
  bytes: number;
}

export type { ExportOwner };

export interface ExportFailure {
  owner: ExportOwner;
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
const REBUILD_SUFFIX = `.rebuild${PENDING_SUFFIX}`;

type PendingDestination = { base: string; retries: number; nextRetryAt: string } & (
  | { destination: 'directory'; dir: string }
  | { destination: 's3'; slug: string }
);

interface PriorAttempt {
  sidecar: string;
  firstFailedAt: string;
  retries: number;
}

export type ExportOutcome =
  | { destination: ExportDestination; status: 'succeeded'; file: string }
  | { destination: ExportDestination; status: 'failed'; file: null; error: string };

const isoTimestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const taskRowSchema = z.custom<TaskRow>((value) => typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'number');
const pendingDestinationSchema = z.discriminatedUnion('destination', [
  z.object({ destination: z.literal('directory'), dir: z.string(), base: z.string(), retries: z.number(), nextRetryAt: isoTimestamp }),
  z.object({ destination: z.literal('s3'), slug: z.string(), base: z.string(), retries: z.number(), nextRetryAt: isoTimestamp }),
]);
const pendingBodySchema = {
  disposition: z.enum(EXPORT_STATES),
  firstFailedAt: isoTimestamp,
  destinations: z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const parsed = pendingDestinationSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
  meta: z
    .object({ builtAt: z.string(), name: z.string(), partial: z.boolean(), bytes: z.number(), redactions: z.record(z.string(), z.number()) })
    .optional()
    .catch(undefined),
  rebuild: z
    .object({ retries: z.number(), nextRetryAt: isoTimestamp, destinations: z.array(z.enum(['directory', 's3'])), forcePartial: z.boolean() })
    .optional(),
};
const ownerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), task: taskRowSchema }),
  z.object({ kind: z.literal('epic'), workspaceId: z.number(), epicRef: z.union([z.string(), z.number()]).transform(trackerRef) }),
]);
function upgradeLegacyTaskSidecar<T extends { task: z.output<typeof taskRowSchema> }>({ task, ...rest }: T) {
  return { owner: { kind: 'task' as const, task }, ...rest };
}
const pendingExportSchema = z.union([
  z.object({ owner: ownerSchema, ...pendingBodySchema }),
  z.object({ task: taskRowSchema, ...pendingBodySchema }).transform(upgradeLegacyTaskSidecar),
]);

type PendingExport = z.output<typeof pendingExportSchema>;

/** Individual malformed destinations are dropped; the sidecar is rejected only when its owner is invalid or nothing deliverable remains. */
function parsePending(raw: unknown): PendingExport | null {
  const parsed = pendingExportSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.destinations.length > 0 || parsed.data.rebuild !== undefined ? parsed.data : null;
}
type PendingRebuild = NonNullable<PendingExport['rebuild']>;

function retryScheduleAt(firstFailedMs: number, retry: number): string | null {
  const delay = EXPORT_RETRY_DELAYS_MS[retry];
  return delay === undefined ? null : new Date(firstFailedMs + delay).toISOString();
}

export interface TaskExporterDeps {
  fireAndForget: FireAndForget;
  dataDir: string;
  archive: Pick<TaskArchive, 'ensure' | 'recordExport' | 'ensureEpic' | 'recordEpicExport' | 'exportHistory' | 'epicExportHistory'>;
  version: string;
  settings: (task: TaskRow) => Promise<ResolvedExportSettings>;
  epicSettings: (workspaceId: number) => Promise<ResolvedExportSettings>;
  epicSnapshot: (workspaceId: number, epicRef: TrackerRef) => Promise<EpicExportSnapshot>;
  workspaceName: (workspaceId: number) => Promise<string | null>;
  snapshot: (task: TaskRow) => Promise<ExportSnapshot>;
  recordFact: (taskId: number, payload: unknown) => Promise<void>;
  recordEpicStep: (workspaceId: number, epicRef: TrackerRef, step: EpicExportStep) => Promise<void>;
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

function manualDisposition(task: TaskRow): ExportDisposition {
  if (task.state !== 'done' && task.state !== 'cancelled') throw new DomainError('invalid_state', `Task ${task.id} is ${task.state}; only a finished Task can be exported`);
  return task.state;
}

function exportRecord(disposition: ExportDisposition, outcome: ExportOutcome, at: Date, meta?: ExportMeta): ExportRecord {
  return {
    ...(meta === undefined ? {} : { builtAt: meta.builtAt, name: meta.name, partial: meta.partial, bytes: meta.bytes, redactions: meta.redactions }),
    destination: outcome.destination,
    disposition,
    file: outcome.file,
    status: outcome.status,
    at: at.toISOString(),
    ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
  };
}

function ownerContext(owner: ExportOwner): Record<string, number | string> {
  return owner.kind === 'task' ? { taskId: owner.task.id } : { workspaceId: owner.workspaceId, epicRef: owner.epicRef };
}

function destinationLocations(settings: ResolvedExportSettings | null): Map<ExportDestination, string> {
  const locations = new Map<ExportDestination, string>();
  if (settings?.directoryPath) locations.set('directory', settings.directoryPath);
  if (settings?.s3) locations.set('s3', `s3://${settings.s3.bucket}/${settings.s3.prefix}`);
  return locations;
}

function pendingPath(staged: string): string {
  return `${staged.slice(0, -TARBALL_SUFFIX.length)}${PENDING_SUFFIX}`;
}

function stagedPath(sidecar: string): string {
  return `${sidecar.slice(0, -PENDING_SUFFIX.length)}${TARBALL_SUFFIX}`;
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
    '| `agent-messages.json` | Agent Messages the Task sent or received, with recipients and receipts |',
    '| `archive.json` | The Archive identity and its Export history |',
    '| `attempts/<n>/implementation/` | Prompt, ACP updates and native transcripts for Attempt n |',
    '',
  ].join('\n');
}

interface EpicMemberEntry {
  ref: TrackerRef;
  taskId: number | null;
  status: string | null;
  export: string | null;
}

function epicReadme(args: { epicRef: TrackerRef; ticket: unknown; workspace: string | null; disposition: string; exportedAt: string; attemptCount: number; members: EpicMemberEntry[] }): string {
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
    '| `agent-messages.json` | Agent Messages the Epic Members sent or received, with recipients and receipts |',
    '| `archive.json` | The Epic Archive identity and its Export history |',
    '| `attempts/<n>/verification/` | Verification command output and Critic transcripts for Epic Attempt n |',
    '',
  ].join('\n');
}

export class TaskExporter {
  private readonly chains = new Map<string, Promise<unknown>>();
  private retrying = false;

  private readonly startedAtMs = Date.now();

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
      if (name.endsWith(TARBALL_SUFFIX)) return present.has(basename(pendingPath(name)));
      if (name.endsWith(REBUILD_SUFFIX)) return true;
      if (name.endsWith(PENDING_SUFFIX)) return present.has(basename(stagedPath(name)));
      return false;
    };
    await forEachYielding(names, async (name) => {
      if (keep(name)) return;
      try {
        if ((await stat(join(stagingDir, name))).mtimeMs >= this.startedAtMs) return;
        await rm(join(stagingDir, name), { recursive: true, force: true });
      } catch (err) {
        logger.warn('export: staging entry not removed', { entry: name, error: message(err) });
      }
    });
  }

  private enqueue(key: string, work: () => Promise<unknown>, context: Record<string, string | number>): void {
    const next = this.serialize(key, work);
    this.deps.fireAndForget(() => next, { op: 'export.trigger', level: 'warn', context });
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.chains.set(key, next);
    const cleanup = (): void => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  trigger(task: TaskRow, disposition: ExportDisposition): void {
    const snapshot = this.deps.snapshot(task);
    snapshot.catch(() => undefined);
    this.enqueue(exportOwnerKey({ kind: 'task', task }), () => this.run(task, disposition, snapshot), { taskId: task.id, disposition });
  }

  exportAgain(task: TaskRow, options: ManualExportOptions = {}): Promise<ExportOutcome[] | null> {
    const disposition = manualDisposition(task);
    return this.serialize(exportOwnerKey({ kind: 'task', task }), () => this.run(task, disposition, undefined, options));
  }

  buildDownload(task: TaskRow, options: ManualExportOptions = {}): Promise<ExportDownload> {
    const disposition = manualDisposition(task);
    return this.serialize(exportOwnerKey({ kind: 'task', task }), async () => {
      const settings = await this.deps.settings(task);
      const built = await this.stage(task, disposition, settings.redactPatterns, this.now(), undefined, options);
      return { path: built.staged, name: built.meta.name, bytes: built.meta.bytes };
    });
  }

  async status(task: TaskRow): Promise<ExportStatus> {
    await this.chains.get(exportOwnerKey({ kind: 'task', task }))?.catch(() => undefined);
    const [history, pending, settings] = await Promise.all([
      this.deps.archive.exportHistory(task),
      this.pendingRetries({ kind: 'task', task }),
      this.deps.settings(task).catch(() => null),
    ]);
    return buildExportStatus(history, destinationLocations(settings), pending);
  }

  async epicStatus(workspaceId: number, epicRef: TrackerRef): Promise<ExportStatus> {
    const owner: ExportOwner = { kind: 'epic', workspaceId, epicRef };
    await this.chains.get(exportOwnerKey(owner))?.catch(() => undefined);
    const [history, pending, settings] = await Promise.all([
      this.deps.archive.epicExportHistory(workspaceId, epicRef),
      this.pendingRetries(owner),
      this.deps.epicSettings(workspaceId).catch(() => null),
    ]);
    return buildExportStatus(history, destinationLocations(settings), pending);
  }

  private async pendingRetries(owner: ExportOwner<{ id: number }>): Promise<PendingRetry[]> {
    const key = exportOwnerKey(owner);
    const found: PendingRetry[] = [];
    for (const { owner: pendingOwner, destinations, rebuild } of await this.readAllPending()) {
      if (exportOwnerKey(pendingOwner) !== key) continue;
      for (const d of destinations) found.push({ destination: d.destination, base: d.base, retries: d.retries, nextRetryAt: d.nextRetryAt });
      if (rebuild) for (const destination of rebuild.destinations) found.push({ destination, base: '', retries: rebuild.retries, nextRetryAt: rebuild.nextRetryAt });
    }
    return found;
  }

  async pendingOwnerKeys(): Promise<Set<string>> {
    return new Set((await this.readAllPending()).map(({ owner }) => exportOwnerKey(owner)));
  }

  private async readAllPending(): Promise<PendingExport[]> {
    const stagingDir = join(this.deps.dataDir, 'archive', '.staging');
    let names: string[];
    try {
      names = (await readdir(stagingDir)).filter((n) => n.endsWith(PENDING_SUFFIX));
    } catch {
      return [];
    }
    const found: PendingExport[] = [];
    await forEachYielding(names, async (name) => {
      try {
        const parsed = parsePending(JSON.parse(await readFile(join(stagingDir, name), 'utf8')));
        if (parsed) found.push(parsed);
      } catch {
        return;
      }
    });
    return found;
  }

  /** Must be awaited before the Task's rows are removed; never throws. */
  async captureForDelete(task: TaskRow): Promise<void> {
    try {
      const settings = await this.deps.settings(task);
      if (!settings.enabled || !settings.includeStates.includes('deleted') || !hasExportDestination(settings)) return;
      const snapshot = await this.deps.snapshot(task);
      if (snapshot.attemptCount === 0) return;
      this.enqueue(exportOwnerKey({ kind: 'task', task }), () => this.run(task, 'deleted', Promise.resolve(snapshot)), { taskId: task.id, disposition: 'deleted' });
    } catch (err) {
      logger.warn('export: delete snapshot failed', { taskId: task.id, error: message(err) });
    }
  }

  triggerEpic(workspaceId: number, epicRef: TrackerRef, disposition: ExportDisposition): void {
    const owner: ExportOwner = { kind: 'epic', workspaceId, epicRef };
    const snapshot = this.deps.epicSnapshot(workspaceId, epicRef);
    snapshot.catch(() => undefined);
    this.enqueue(exportOwnerKey(owner), () => this.runEpic(workspaceId, epicRef, disposition, snapshot), { workspaceId, epicRef, disposition });
  }

  exportEpicAgain(workspaceId: number, epicRef: TrackerRef): Promise<ExportOutcome[] | null> {
    return this.serialize(exportOwnerKey({ kind: 'epic', workspaceId, epicRef }), () => this.runEpic(workspaceId, epicRef, 'done', undefined, {}));
  }

  buildEpicDownload(workspaceId: number, epicRef: TrackerRef): Promise<ExportDownload> {
    return this.serialize(exportOwnerKey({ kind: 'epic', workspaceId, epicRef }), async () => {
      const settings = await this.deps.epicSettings(workspaceId);
      const built = await this.stageEpic(workspaceId, epicRef, 'done', settings.redactPatterns, this.now());
      return { path: built.staged, name: built.meta.name, bytes: built.meta.bytes };
    });
  }

  async runEpic(workspaceId: number, epicRef: TrackerRef, disposition: ExportDisposition, snapshot?: Promise<EpicExportSnapshot>, manual?: ManualExportOptions): Promise<ExportOutcome[] | null> {
    let settings: ResolvedExportSettings;
    try {
      settings = await this.deps.epicSettings(workspaceId);
    } catch (err) {
      logger.warn('export: epic settings unavailable', { workspaceId, epicRef, error: message(err) });
      return null;
    }
    if (!settings.enabled || (manual === undefined && !settings.includeStates.includes(disposition)) || !hasExportDestination(settings)) return null;
    if (manual === undefined) {
      const prior = await this.deps.archive.epicExportHistory(workspaceId, epicRef);
      if (prior.some((e) => e.status === 'succeeded' && e.disposition === disposition)) return null;
    }
    return this.execute({ kind: 'epic', workspaceId, epicRef }, disposition, settings, (at) =>
      this.stageEpic(workspaceId, epicRef, disposition, settings.redactPatterns, at, snapshot, manual), manual,
    );
  }

  private async memberEntries(members: EpicExportMember[]): Promise<EpicMemberEntry[]> {
    const entries: EpicMemberEntry[] = [];
    await forEachYielding(members, async ({ ref, task }) => {
      if (!task) {
        entries.push({ ref, taskId: null, status: null, export: null });
        return;
      }
      await this.chains.get(exportOwnerKey({ kind: 'task', task }))?.catch(() => undefined);
      const history = await this.deps.archive.exportHistory(task);
      const latest = [...history].reverse().find((e) => e.status === 'succeeded' && e.file !== null);
      entries.push({ ref, taskId: task.id, status: task.state, export: latest?.file ? basename(latest.file) : null });
    });
    return entries;
  }

  async run(task: TaskRow, disposition: ExportDisposition, snapshot?: Promise<ExportSnapshot>, manual?: ManualExportOptions): Promise<ExportOutcome[] | null> {
    let settings: ResolvedExportSettings;
    try {
      settings = await this.deps.settings(task);
    } catch (err) {
      logger.warn('export: settings unavailable', { taskId: task.id, error: message(err) });
      return null;
    }
    if (!settings.enabled || (manual === undefined && !settings.includeStates.includes(disposition)) || !hasExportDestination(settings)) return null;
    return this.execute({ kind: 'task', task }, disposition, settings, (at) => this.stage(task, disposition, settings.redactPatterns, at, snapshot, manual), manual);
  }

  private async execute(
    owner: ExportOwner,
    disposition: ExportDisposition,
    settings: ResolvedExportSettings,
    build: (at: Date) => Promise<StagedExport>,
    manual: ManualExportOptions | undefined,
    prior?: PriorAttempt,
  ): Promise<ExportOutcome[]> {
    const at = this.now();
    const { directoryPath, s3 } = settings;
    const where = ownerContext(owner);
    const retry = prior === undefined ? 0 : prior.retries + 1;
    const firstFailedAt = prior?.firstFailedAt ?? at.toISOString();
    const retryAt = retryScheduleAt(Date.parse(firstFailedAt), retry);
    const destinations: { destination: ExportDestination; deliver: (built: StagedExport) => Promise<string>; pending: (built: StagedExport, nextRetryAt: string) => PendingDestination }[] = [];
    if (directoryPath !== null) {
      destinations.push({
        destination: 'directory',
        deliver: (b) => this.deliver(b.staged, join(directoryPath, b.slug), b.base),
        pending: (b, nextRetryAt) => ({ destination: 'directory', dir: join(directoryPath, b.slug), base: b.base, retries: retry, nextRetryAt }),
      });
    }
    if (s3 !== null) {
      destinations.push({
        destination: 's3',
        deliver: (b) => uploadToS3(s3, b.staged, b.slug, b.base),
        pending: (b, nextRetryAt) => ({ destination: 's3', slug: b.slug, base: b.base, retries: retry, nextRetryAt }),
      });
    }
    const outcomes: ExportOutcome[] = [];
    const retryable: PendingDestination[] = [];
    let built: StagedExport | null = null;
    try {
      built = await build(at);
    } catch (err) {
      for (const { destination } of destinations) {
        outcomes.push({ destination, status: 'failed', file: null, error: message(err) });
      }
      logger.warn('export: failed', { ...where, disposition, error: message(err) });
    }
    if (built !== null) {
      const { name, bytes, partial } = built.meta;
      await this.recordEpicStep(owner, { step: 'export-built', disposition, name, bytes, partial });
      for (const { destination, deliver, pending } of destinations) {
        let outcome: ExportOutcome;
        try {
          outcome = { destination, status: 'succeeded', file: await deliver(built) };
        } catch (err) {
          outcome = { destination, status: 'failed', file: null, error: message(err) };
          logger.warn('export: failed', { ...where, disposition, destination, error: outcome.error });
          if (retryAt !== null) retryable.push(pending(built, retryAt));
        }
        outcomes.push(outcome);
      }
    }
    let nextRetryAt: string | null = null;
    let written: string | null = null;
    try {
      if (built !== null && retryable.length > 0) {
        written = pendingPath(built.staged);
        await this.writePending(written, { owner, disposition, firstFailedAt, destinations: retryable, meta: built.meta });
        nextRetryAt = retryAt;
      } else if (built === null && retryAt !== null) {
        written = prior?.sidecar ?? (await this.rebuildSidecarPath(owner));
        const rebuild = { retries: retry, nextRetryAt: retryAt, destinations: destinations.map((d) => d.destination), forcePartial: manual?.forcePartial === true };
        await this.writePending(written, { owner, disposition, firstFailedAt, destinations: [], rebuild });
        nextRetryAt = retryAt;
      }
    } catch (err) {
      logger.warn('export: retry not scheduled', { ...where, error: message(err) });
    }
    if (built !== null && nextRetryAt === null) await rm(built.staged, { force: true }).catch(() => undefined);
    if (prior !== undefined && (nextRetryAt === null || written !== prior.sidecar)) await rm(prior.sidecar, { force: true }).catch(() => undefined);
    for (const outcome of outcomes) await this.record(owner, disposition, outcome, at, retry, built?.meta, nextRetryAt);
    for (const outcome of outcomes) {
      if (outcome.status !== 'failed') continue;
      this.notifyFailure({ owner, disposition, destination: outcome.destination, error: outcome.error, retry, nextRetryAt });
    }
    return outcomes;
  }

  private async rebuildSidecarPath(owner: ExportOwner): Promise<string> {
    const stagingDir = join(this.deps.dataDir, 'archive', '.staging');
    await mkdir(stagingDir, { recursive: true });
    const stem = owner.kind === 'task' ? String(owner.task.id) : `epic-${owner.epicRef}`;
    return join(stagingDir, `${stem}-${randomBytes(6).toString('hex')}${REBUILD_SUFFIX}`);
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
    return this.serialize(exportOwnerKey(pending.owner), async () => {
      const current = await this.readPending(sidecar);
      if (!current) return 0;
      if (current.rebuild) return this.retryRebuild(sidecar, current, current.rebuild);
      const staged = stagedPath(sidecar);
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
          outcome = { destination: dest.destination, status: 'succeeded', file: await this.redeliver(current.owner, staged, dest) };
        } catch (err) {
          outcome = { destination: dest.destination, status: 'failed', file: null, error: message(err) };
          logger.warn('export: retry failed', { ...ownerContext(current.owner), destination: dest.destination, retry, error: outcome.error });
        }
        const nextRetryAt = outcome.status === 'failed' ? retryScheduleAt(first, retry) : null;
        await this.record(current.owner, current.disposition, outcome, at, retry, current.meta, nextRetryAt);
        if (outcome.status === 'succeeded') continue;
        if (nextRetryAt) remaining.push({ ...dest, retries: retry, nextRetryAt });
        this.notifyFailure({
          owner: current.owner,
          disposition: current.disposition,
          destination: dest.destination,
          error: outcome.error,
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

  private async retryRebuild(sidecar: string, current: PendingExport, rebuild: PendingRebuild): Promise<number> {
    if (Date.parse(rebuild.nextRetryAt) > this.now().getTime()) return 0;
    const { owner, disposition } = current;
    const manual = { forcePartial: rebuild.forcePartial };
    let settings: ResolvedExportSettings;
    try {
      settings = owner.kind === 'task' ? await this.deps.settings(owner.task) : await this.deps.epicSettings(owner.workspaceId);
    } catch (err) {
      logger.warn('export: settings unavailable for retry', { ...ownerContext(owner), error: message(err) });
      const retries = rebuild.retries + 1;
      const nextRetryAt = retryScheduleAt(Date.parse(current.firstFailedAt), retries);
      if (nextRetryAt === null) await rm(sidecar, { force: true });
      else await this.writePending(sidecar, { ...current, rebuild: { ...rebuild, retries, nextRetryAt } });
      return 1;
    }
    if (!settings.enabled || !hasExportDestination(settings)) {
      await rm(sidecar, { force: true });
      return 0;
    }
    const build = (at: Date): Promise<StagedExport> =>
      owner.kind === 'task'
        ? this.stage(owner.task, disposition, settings.redactPatterns, at, undefined, manual)
        : this.stageEpic(owner.workspaceId, owner.epicRef, disposition, settings.redactPatterns, at, undefined, manual);
    await this.execute(owner, disposition, settings, build, manual, { sidecar, firstFailedAt: current.firstFailedAt, retries: rebuild.retries });
    return 1;
  }

  private async redeliver(owner: ExportOwner, staged: string, dest: PendingDestination): Promise<string> {
    if (dest.destination === 'directory') return this.deliver(staged, dest.dir, dest.base);
    const { s3 } = owner.kind === 'task' ? await this.deps.settings(owner.task) : await this.deps.epicSettings(owner.workspaceId);
    if (s3 === null) throw new Error('S3 destination is no longer configured');
    return uploadToS3(s3, staged, dest.slug, dest.base);
  }

  private async readPending(sidecar: string): Promise<PendingExport | null> {
    try {
      const parsed = parsePending(JSON.parse(await readFile(sidecar, 'utf8')));
      if (!parsed) throw new Error('malformed sidecar');
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      logger.warn('export: pending sidecar unreadable, discarding', { sidecar, error: message(err) });
      await rm(sidecar, { force: true }).catch(() => undefined);
      await rm(stagedPath(sidecar), { force: true }).catch(() => undefined);
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
      logger.warn('export: failure hook threw', { ...ownerContext(failure.owner), error: message(err) });
    }
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async record(owner: ExportOwner, disposition: ExportDisposition, outcome: ExportOutcome, at: Date, retry: number, meta: ExportMeta | undefined, nextRetryAt: string | null): Promise<void> {
    const entry: ExportRecord = { ...exportRecord(disposition, outcome, at, meta), ...(retry > 0 ? { retry } : {}) };
    const where = ownerContext(owner);
    if (owner.kind === 'epic') {
      await this.recordEpicStep(
        owner,
        outcome.status === 'succeeded'
          ? { step: 'export-delivered', destination: outcome.destination, file: outcome.file, retry }
          : { step: 'export-failed', destination: outcome.destination, error: outcome.error, retry, nextRetryAt },
      );
      try {
        await this.deps.archive.recordEpicExport(owner.workspaceId, owner.epicRef, entry);
      } catch (err) {
        logger.warn('export: epic archive history not updated', { ...where, error: message(err) });
      }
      return;
    }
    const { task } = owner;
    if (disposition !== 'deleted') {
      const { at: _at, ...fact } = entry;
      try {
        await this.deps.recordFact(task.id, { event: 'export', ...fact, ...(outcome.status === 'failed' ? { nextRetryAt } : {}) });
      } catch (err) {
        logger.warn('export: fact not recorded', { ...where, error: message(err) });
      }
    }
    try {
      await this.deps.archive.recordExport(task, entry);
    } catch (err) {
      logger.warn('export: archive history not updated', { ...where, error: message(err) });
    }
  }

  private async recordEpicStep(owner: ExportOwner, step: EpicExportStep): Promise<void> {
    if (owner.kind !== 'epic') return;
    try {
      await this.deps.recordEpicStep(owner.workspaceId, owner.epicRef, step);
    } catch (err) {
      logger.warn('export: epic timeline step not recorded', { ...ownerContext(owner), error: message(err) });
    }
  }

  private async stageEpic(
    workspaceId: number,
    epicRef: TrackerRef,
    disposition: ExportDisposition,
    patterns: readonly RedactionPattern[],
    at: Date,
    pending?: Promise<EpicExportSnapshot>,
    manual?: ManualExportOptions,
  ): Promise<StagedExport> {
    const snapshot = await (pending ?? this.deps.epicSnapshot(workspaceId, epicRef));
    const members = await this.memberEntries(snapshot.members);
    const archiveDir = await this.deps.archive.ensureEpic(workspaceId, epicRef);
    const workspace = await this.deps.workspaceName(workspaceId);
    let partial = false;
    let redactions: Record<string, number> = {};
    const staged = await this.stageTarball(`epic-${epicRef}`, (target) =>
      this.buildTarball(target, archiveDir, snapshot, patterns, at, (result) => {
        partial = result.partial || manual?.forcePartial === true;
        redactions = { ...result.redaction.matches };
        return {
          manifest: {
            format: 'harmonic-epic-export',
            formatVersion: 1,
            harmonicVersion: this.deps.version,
            epicRef,
            workspaceId,
            workspace,
            disposition,
            exportedAt: at.toISOString(),
            counts: { archiveFiles: result.files, attempts: snapshot.attemptCount, members: members.length },
            redaction: result.redaction,
            partial,
            members,
          },
          readme: epicReadme({ epicRef, ticket: snapshot.ticket, workspace, disposition, exportedAt: at.toISOString(), attemptCount: snapshot.attemptCount, members }),
        };
      }),
    );
    return this.measure(staged, workspaceSlug(workspace, workspaceId), `epic-${epicRef}-${disposition}-${exportTimestamp(at)}`, at, partial, redactions);
  }

  private async stage(
    task: TaskRow,
    disposition: ExportDisposition,
    patterns: readonly RedactionPattern[],
    at: Date,
    pending?: Promise<ExportSnapshot>,
    manual?: ManualExportOptions,
  ): Promise<StagedExport> {
    const snapshot = await (pending ?? this.deps.snapshot(task));
    const archiveDir = await this.deps.archive.ensure(task);
    const workspace = task.workspaceId === null ? null : await this.deps.workspaceName(task.workspaceId);
    let partial = false;
    let redactions: Record<string, number> = {};
    const staged = await this.stageTarball(String(task.id), (target) =>
      this.buildTarball(target, archiveDir, snapshot, patterns, at, (result) => {
        partial = result.partial || manual?.forcePartial === true;
        redactions = { ...result.redaction.matches };
        return {
          manifest: {
            format: 'harmonic-task-export',
            formatVersion: 2,
            harmonicVersion: this.deps.version,
            taskId: task.id,
            archiveId: task.archiveId,
            trackerRef: task.trackerRef,
            workspace,
            disposition,
            exportedAt: at.toISOString(),
            counts: { archiveFiles: result.files, attempts: snapshot.attemptCount },
            git: result.git,
            redaction: result.redaction,
            partial,
          },
          readme: readme({ task, ticket: snapshot.ticket, workspace, disposition, exportedAt: at.toISOString(), attemptCount: snapshot.attemptCount }),
        };
      }),
    );
    return this.measure(staged, workspaceSlug(workspace, task.workspaceId), this.fileName(task, disposition, at), at, partial, redactions);
  }

  private async measure(staged: string, slug: string, base: string, at: Date, partial: boolean, redactions: Record<string, number>): Promise<StagedExport> {
    let bytes = 0;
    try {
      bytes = (await stat(staged)).size;
    } catch (err) {
      await rm(staged, { force: true });
      throw err;
    }
    return { staged, slug, base, meta: { builtAt: at.toISOString(), name: `${base}${TARBALL_SUFFIX}`, partial, bytes, redactions } };
  }

  private async stageTarball(name: string, build: (staged: string) => Promise<void>): Promise<string> {
    const stagingDir = join(this.deps.dataDir, 'archive', '.staging');
    await mkdir(stagingDir, { recursive: true });
    const staged = join(stagingDir, `${name}-${randomBytes(6).toString('hex')}${TARBALL_SUFFIX}`);
    try {
      await build(staged);
    } catch (err) {
      await rm(staged, { force: true });
      throw err;
    }
    return staged;
  }

  private fileName(task: TaskRow, disposition: ExportDisposition, at: Date): string {
    const ref = task.trackerRef != null ? `-${task.trackerRef}` : '';
    return `${task.id}${ref}-${disposition}-${exportTimestamp(at)}`;
  }

  private async buildTarball(
    staged: string,
    archiveDir: string,
    snapshot: Omit<ExportSnapshot, 'git'> & { git?: GitProvenance },
    patterns: readonly RedactionPattern[],
    at: Date,
    describe: (result: { files: number; partial: boolean; git: GitProvenance | null; redaction: { applied: true; matches: Record<string, number> } }) => { manifest: unknown; readme: string },
  ): Promise<void> {
    const redactor = new Redactor(patterns);
    const redacted: TransformFactory = (pass) => redactor.stream({ count: pass === 'write' });
    const writer = new TarGzWriter(createWriteStream(staged));
    const entries = (await readdir(archiveDir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const hasAttempts = entries.some((e) => e.isDirectory() && e.name === 'attempts');
    let files = 0;
    try {
      await writer.addBuffer('ticket.json', redactor.redactText(json(snapshot.ticket)), at);
      await writer.addBuffer('timeline.json', redactor.redactText(json(snapshot.timeline)), at);
      await writer.addBuffer('operator-inputs.json', redactor.redactText(json(await readOperatorInputs(archiveDir))), at);
      await writer.addBuffer('agent-messages.json', redactor.redactText(json(snapshot.agentMessages)), at);
      for (const entry of entries) {
        if (entry.isFile() && entry.name !== OPERATOR_INPUTS_FILE && !entry.name.endsWith('.tmp')) {
          await writer.addFile(entry.name, join(archiveDir, entry.name), redacted);
          files++;
        } else if (entry.isDirectory()) {
          files += await addDirectory(writer, join(archiveDir, entry.name), entry.name, redacted);
        }
      }
      const git = snapshot.git ? (JSON.parse(redactor.redactText(json(snapshot.git))) as GitProvenance) : null;
      const described = describe({ files, git, partial: snapshot.attemptCount > 0 && !hasAttempts, redaction: { applied: true, matches: redactor.counts } });
      const readmeText = redactor.redactText(described.readme);
      await writer.addBuffer('manifest.json', json(described.manifest), at);
      await writer.addBuffer('README.md', readmeText, at);
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
