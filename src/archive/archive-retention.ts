import { trackerRef, type TrackerRef } from '../tracker/adapter.js';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { exportOwnerKey } from './export-owner.js';
import type { ExportRecord } from './task-archive.js';

export interface ArchiveRetention {
  days: number | null;
  maxTotalMB: number | null;
}

export interface ArchivePruneDeps {
  dataDir: string;
  retention: () => ArchiveRetention;
  /** A Workspace's own caps by archive directory slug; a null field inherits the global cap, null result means no override. */
  workspaceRetention?: (slug: string) => ArchiveRetention | null;
  /** Epoch ms the Task reached a terminal state; null while it is non-terminal or unknown. Not consulted for Archives marked deleted. */
  taskTerminalAt: (taskId: number) => Promise<number | null>;
  /** Owner keys (see `exportOwnerKey`) of Exports with a retry still scheduled. */
  pendingExports: () => Promise<ReadonlySet<string>>;
  now?: () => number;
  yieldOptions?: YieldOptions;
}

interface Manifest {
  taskId?: number;
  /** Legacy manifests stored the ref as a number. */
  epicRef?: TrackerRef | number;
  workspaceId?: number | null;
  dispositions?: { at?: string }[];
  deleted?: { at?: string };
  exports?: ExportRecord[];
}

interface Candidate {
  dir: string;
  pool: string;
  bytes: number;
  terminalAt: number | null;
}

const DAY_MS = 24 * 60 * 60_000;
const MB = 1024 * 1024;
/** An Export triggered by the terminal transition may still be in flight and unrecorded; give it time to land. */
const EXPORT_GRACE_MS = 60 * 60_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    await forEachYielding(entries, async (entry) => {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) total += (await stat(path)).size;
    });
  }
  return total;
}

function exportsSettled(exports: ExportRecord[]): boolean {
  const latest = new Map<string, ExportRecord['status']>();
  for (const record of exports) latest.set(record.destination, record.status);
  return [...latest.values()].every((status) => status === 'succeeded');
}

function latestExportAt(exports: ExportRecord[]): number | null {
  const times = exports.map((e) => Date.parse(e.at)).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

function ownerKey(manifest: Manifest): string | null {
  if (manifest.epicRef != null && typeof manifest.workspaceId === 'number') {
    return exportOwnerKey({ kind: 'epic', workspaceId: manifest.workspaceId, epicRef: trackerRef(manifest.epicRef) });
  }
  return typeof manifest.taskId === 'number' ? exportOwnerKey({ kind: 'task', task: { id: manifest.taskId } }) : null;
}

async function terminalAt(manifest: Manifest, deps: ArchivePruneDeps): Promise<number | null> {
  const deletedAt = manifest.deleted ? Date.parse(manifest.deleted.at ?? '') : NaN;
  if (Number.isFinite(deletedAt)) return deletedAt;
  if (typeof manifest.taskId === 'number') return await deps.taskTerminalAt(manifest.taskId);
  if (manifest.epicRef != null) {
    const stamped = Date.parse(manifest.dispositions?.[0]?.at ?? '');
    return Number.isFinite(stamped) ? stamped : null;
  }
  return null;
}

interface ScanEntry {
  dir: string;
  pool: string;
  retention: ArchiveRetention;
}

function hasCap(r: ArchiveRetention): boolean {
  return r.days !== null || r.maxTotalMB !== null;
}

async function scanArchives(deps: ArchivePruneDeps): Promise<ScanEntry[]> {
  const global = deps.retention();
  const root = join(deps.dataDir, 'archive');
  const entries: ScanEntry[] = [];
  try {
    for (const workspace of await readdir(root, { withFileTypes: true })) {
      if (!workspace.isDirectory() || workspace.name.startsWith('.')) continue;
      const own = deps.workspaceRetention?.(workspace.name) ?? null;
      const overridden = own !== null && hasCap(own);
      const retention = { days: own?.days ?? global.days, maxTotalMB: own?.maxTotalMB ?? global.maxTotalMB };
      if (!hasCap(retention)) continue;
      const pool = overridden ? `workspace:${workspace.name}` : 'global';
      for (const child of await readdir(join(root, workspace.name), { withFileTypes: true })) {
        if (child.isDirectory()) entries.push({ dir: join(root, workspace.name, child.name), pool, retention });
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('archive: retention scan failed', { error: errorMessage(err) });
    return [];
  }
  return entries;
}

/**
 * Remove Archives past the configured retention caps; returns the number removed. Caps are off unless configured.
 * A Workspace with its own caps is pruned as its own pool; every other Workspace shares the global pool.
 */
export async function pruneArchives(deps: ArchivePruneDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const entries = await scanArchives(deps);
  if (entries.length === 0) return 0;

  const pending = await deps.pendingExports();
  const candidates: Candidate[] = [];
  await forEachYielding(entries, async ({ dir, pool }) => {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8')) as Manifest;
      const bytes = await directoryBytes(dir);
      const exports = manifest.exports ?? [];
      const key = ownerKey(manifest);
      const awaitingExport = key !== null && pending.has(key);
      const at = exportsSettled(exports) && !awaitingExport ? await terminalAt(manifest, deps) : null;
      const settled = at !== null && now - Math.max(at, latestExportAt(exports) ?? 0) >= EXPORT_GRACE_MS;
      candidates.push({ dir, pool, bytes, terminalAt: settled ? at : null });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('archive: retention skipped unreadable archive', { dir, error: errorMessage(err) });
    }
  }, deps.yieldOptions);

  const retentionByPool = new Map(entries.map((e) => [e.pool, e.retention]));
  let removed = 0;
  for (const [pool, { days, maxTotalMB }] of retentionByPool) {
    const poolCandidates = candidates.filter((c) => c.pool === pool);
    let total = poolCandidates.reduce((sum, c) => sum + c.bytes, 0);
    const eligible = poolCandidates
      .filter((c): c is Candidate & { terminalAt: number } => c.terminalAt !== null)
      .sort((a, b) => a.terminalAt - b.terminalAt);
    const ageCutoff = days === null ? null : now - days * DAY_MS;
    const capBytes = maxTotalMB === null ? null : maxTotalMB * MB;

    await forEachYielding(eligible, async (candidate) => {
      const tooOld = ageCutoff !== null && candidate.terminalAt < ageCutoff;
      const overCap = capBytes !== null && total > capBytes;
      if (!tooOld && !overCap) return;
      try {
        await rm(candidate.dir, { recursive: true, force: true });
        total -= candidate.bytes;
        removed += 1;
      } catch (err) {
        logger.warn('archive: retention prune failed', { dir: candidate.dir, error: errorMessage(err) });
      }
    }, deps.yieldOptions);
  }
  if (removed > 0) logger.info('archive: retention pruned archives', { removed });
  return removed;
}
