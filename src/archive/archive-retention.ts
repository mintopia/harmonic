import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import type { ExportRecord } from './task-archive.js';

export interface ArchiveRetention {
  days: number | null;
  maxTotalMB: number | null;
}

export interface ArchivePruneDeps {
  dataDir: string;
  retention: () => ArchiveRetention;
  /** Epoch ms the Task reached a terminal state; null while it is non-terminal or unknown. Not consulted for Archives marked deleted. */
  taskTerminalAt: (taskId: number) => Promise<number | null>;
  now?: () => number;
  yieldOptions?: YieldOptions;
}

interface Manifest {
  taskId?: number;
  epicRef?: number;
  deleted?: { at?: string };
  exports?: ExportRecord[];
}

interface Candidate {
  dir: string;
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

async function terminalAt(manifest: Manifest, deps: ArchivePruneDeps): Promise<number | null> {
  const deletedAt = manifest.deleted ? Date.parse(manifest.deleted.at ?? '') : NaN;
  if (Number.isFinite(deletedAt)) return deletedAt;
  if (typeof manifest.taskId === 'number') return await deps.taskTerminalAt(manifest.taskId);
  if (typeof manifest.epicRef === 'number') return latestExportAt(manifest.exports ?? []);
  return null;
}

/** Remove Archives past the configured retention caps; returns the number removed. Caps are off unless configured. */
export async function pruneArchives(deps: ArchivePruneDeps): Promise<number> {
  const { days, maxTotalMB } = deps.retention();
  if (days === null && maxTotalMB === null) return 0;
  const now = (deps.now ?? Date.now)();
  const root = join(deps.dataDir, 'archive');

  const dirs: string[] = [];
  try {
    for (const workspace of await readdir(root, { withFileTypes: true })) {
      if (!workspace.isDirectory() || workspace.name.startsWith('.')) continue;
      for (const child of await readdir(join(root, workspace.name), { withFileTypes: true })) {
        if (child.isDirectory()) dirs.push(join(root, workspace.name, child.name));
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('archive: retention scan failed', { error: errorMessage(err) });
    return 0;
  }

  const candidates: Candidate[] = [];
  await forEachYielding(dirs, async (dir) => {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8')) as Manifest;
      const bytes = await directoryBytes(dir);
      const exports = manifest.exports ?? [];
      const at = exportsSettled(exports) ? await terminalAt(manifest, deps) : null;
      const settled = at !== null && now - Math.max(at, latestExportAt(exports) ?? 0) >= EXPORT_GRACE_MS;
      candidates.push({ dir, bytes, terminalAt: settled ? at : null });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('archive: retention skipped unreadable archive', { dir, error: errorMessage(err) });
    }
  }, deps.yieldOptions);

  let total = candidates.reduce((sum, c) => sum + c.bytes, 0);
  const eligible = candidates
    .filter((c): c is Candidate & { terminalAt: number } => c.terminalAt !== null)
    .sort((a, b) => a.terminalAt - b.terminalAt);
  const ageCutoff = days === null ? null : now - days * DAY_MS;
  const capBytes = maxTotalMB === null ? null : maxTotalMB * MB;

  let removed = 0;
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
  if (removed > 0) logger.info('archive: retention pruned archives', { removed });
  return removed;
}
