import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const pendingSchema = z.object({
  version: z.string(),
  previous: z.string(),
  snapshot: z.string(),
  boots: z.number().int().min(0).default(0),
});

export type PendingUpgrade = z.infer<typeof pendingSchema>;

/** Written when the guard actually flipped `current` back to `previous`. */
const rollbackDoneSchema = z.object({
  fromVersion: z.string(),
  toVersion: z.string(),
  at: z.string(),
  reason: z.string(),
  databaseRestored: z.boolean(),
  /** Where the guard preserved the pre-rollback database files, when it needed to move them aside. */
  preservedDatabaseDir: z.string().optional(),
});

/** Written when the guard could NOT restore the database (missing snapshot, failed copy, or
 * failed preservation) and therefore did not flip `current` — flipping onto a database the
 * failed release may have already migrated is worse than staying put. `pending.json` is left in
 * place so every later boot retries the restore. */
const rollbackBlockedSchema = z.object({
  rolledBack: z.literal(false),
  blockedReason: z.literal('database-not-restored'),
  fromVersion: z.string(),
  toVersion: z.string(),
  at: z.string(),
  reason: z.string(),
  preservedDatabaseDir: z.string().optional(),
});

const rollbackSchema = z.union([rollbackDoneSchema, rollbackBlockedSchema]);

export type RollbackRecord = z.infer<typeof rollbackSchema>;

const previousSchema = z.object({ version: z.string() });

const pendingPath = (appDir: string): string => join(appDir, 'pending.json');
const rollbackPath = (appDir: string): string => join(appDir, 'rollback.json');
const previousPath = (appDir: string): string => join(appDir, 'previous.json');

function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dirPath: string): void {
  const fd = fs.openSync(dirPath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Atomically and durably overwrite `path`: write to a sibling tmp file, fsync it, rename over the
 * target, then fsync the parent directory so the rename survives a power loss. */
function writeFileAtomic(path: string, contents: string): void {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, contents, 'utf8');
  fsyncFile(tmpPath);
  renameSync(tmpPath, path);
  fsyncDir(dirname(path));
}

function readJson<T>(path: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(path)) return null;
  try {
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Snapshots the database into `<dataDir>/app/pre-<version>.db` via `VACUUM INTO`; overwrite-safe. Returns the snapshot path. */
export async function snapshotDatabase({ dataDir, version }: { dataDir: string; version: string }): Promise<string> {
  const snapshotPath = join(dataDir, 'app', `pre-${version}.db`);
  rmSync(snapshotPath, { force: true });
  const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
  try {
    await client.execute(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
  } finally {
    client.close();
  }
  return snapshotPath;
}

/** Writes `app/pending.json` atomically, recording the upgrade target, its predecessor, and the pre-upgrade DB snapshot. */
export function writePending({
  appDir,
  version,
  previous,
  snapshot,
}: {
  appDir: string;
  version: string;
  previous: string;
  snapshot: string;
}): void {
  mkdirSync(appDir, { recursive: true });
  writeFileAtomic(pendingPath(appDir), JSON.stringify({ version, previous, snapshot, boots: 0 } satisfies PendingUpgrade));
}

export function readPending({ appDir }: { appDir: string }): PendingUpgrade | null {
  return readJson(pendingPath(appDir), pendingSchema);
}

export function clearPending({ appDir }: { appDir: string }): void {
  rmSync(pendingPath(appDir), { force: true });
}

/** Flips `app/current` to `versions/<version>` atomically: a temporary symlink, then `rename` over `current`. */
export function flipCurrent({ appDir, version }: { appDir: string; version: string }): void {
  const tmpPath = join(appDir, '.current.tmp');
  rmSync(tmpPath, { force: true });
  symlinkSync(`versions/${version}`, tmpPath);
  renameSync(tmpPath, join(appDir, 'current'));
  fsyncDir(appDir);
}

/** Reads the version `app/current` points at, or null if it's missing or dangling. */
export function readCurrentVersion({ appDir }: { appDir: string }): string | null {
  const currentPath = join(appDir, 'current');
  try {
    const target = readlinkSync(currentPath);
    return target.split('/').pop() ?? null;
  } catch {
    return null;
  }
}

export function readRollback({ appDir }: { appDir: string }): RollbackRecord | null {
  return readJson(rollbackPath(appDir), rollbackSchema);
}

export function clearRollback({ appDir }: { appDir: string }): void {
  rmSync(rollbackPath(appDir), { force: true });
}

function readPreviousVersion({ appDir }: { appDir: string }): string | null {
  return readJson(previousPath(appDir), previousSchema)?.version ?? null;
}

function writePreviousVersion({ appDir, version }: { appDir: string; version: string }): void {
  writeFileAtomic(previousPath(appDir), JSON.stringify({ version } satisfies z.infer<typeof previousSchema>));
}

/**
 * Marks the running version healthy: clears `pending.json` only if it names the version that's
 * actually running (the caller's own version, not whatever `current` currently points to — those
 * can disagree if `current` was flipped by a later upgrade attempt this process hasn't picked up
 * yet), then copies the caller's own boot-guard over `app/boot-guard.cjs` (so a pending boot always
 * runs a guard shipped by a release that has already booted), then prunes old versions.
 */
export function markHealthy({ appDir, runningVersion, guardSource }: { appDir: string; runningVersion: string; guardSource: string }): void {
  const pending = readPending({ appDir });
  if (pending && pending.version === runningVersion) {
    writePreviousVersion({ appDir, version: pending.previous });
    clearPending({ appDir });
  }
  if (existsSync(guardSource)) {
    writeFileAtomic(join(appDir, 'boot-guard.cjs'), readFileSync(guardSource, 'utf8'));
  }
  pruneVersions({ appDir });
}

/** Deletes every `<dataDir>/rolled-back/*` entry except the 2 most recently modified. The boot
 * guard only ever adds entries here on rollback; it never deletes, so this is the sole place
 * that bounds how many preserved pre-rollback database copies accumulate. */
function pruneRolledBack({ dataDir }: { dataDir: string }): void {
  const rolledBackDir = join(dataDir, 'rolled-back');
  if (!existsSync(rolledBackDir)) return;
  const entries = readdirSync(rolledBackDir)
    .map((name) => ({ name, mtimeMs: statSync(join(rolledBackDir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of entries.slice(2)) {
    rmSync(join(rolledBackDir, entry.name), { recursive: true, force: true });
  }
}

/** Keeps `current`, `previous` and any pending version; deletes every other `versions/*` entry, stray `.tgz` files, and stale DB snapshots; keeps only the 2 most recent `rolled-back/*` preserved-database copies. Runs only when no upgrade is in flight is the caller's responsibility. */
export function pruneVersions({ appDir }: { appDir: string }): void {
  const current = readCurrentVersion({ appDir });
  if (current === null || !existsSync(join(appDir, 'versions', current))) return; // missing or dangling current: nothing is provably safe to delete
  const pending = readPending({ appDir });
  const previous = readPreviousVersion({ appDir });
  const keep = new Set([current, pending?.version, pending?.previous, previous].filter((v): v is string => v !== null && v !== undefined));

  const versionsDir = join(appDir, 'versions');
  if (existsSync(versionsDir)) {
    for (const entry of readdirSync(versionsDir)) {
      if (keep.has(entry)) continue;
      rmSync(join(versionsDir, entry), { recursive: true, force: true });
    }
  }

  for (const entry of readdirSync(appDir)) {
    const fullPath = join(appDir, entry);
    if (entry.endsWith('.tgz')) {
      rmSync(fullPath, { force: true });
      continue;
    }
    const snapshotMatch = /^pre-(.+)\.db$/.exec(entry);
    if (snapshotMatch && !keep.has(snapshotMatch[1]!)) {
      rmSync(fullPath, { force: true });
    }
  }

  pruneRolledBack({ dataDir: dirname(appDir) });
}
