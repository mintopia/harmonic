#!/usr/bin/env node
'use strict';

// Dependency-free and unversioned: runs before every start (systemd ExecStartPre, init.d, the
// relauncher) using whatever copy is on disk, which may predate the release it's guarding.
// Always exits 0 so it never blocks a start attempt.

const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function isValidPending(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.version === 'string' &&
    typeof value.previous === 'string' &&
    typeof value.snapshot === 'string'
  );
}

function logError(message, error) {
  process.stderr.write(`harmonic boot-guard: ${message}: ${error && error.message ? error.message : String(error)}\n`);
}

function removeIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    logError(`could not remove ${filePath}`, error);
    return false;
  }
}

function readCurrentVersion(appDir) {
  try {
    const target = fs.readlinkSync(path.join(appDir, 'current'));
    const parts = target.split('/');
    return parts[parts.length - 1] || null;
  } catch {
    return null;
  }
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dirPath) {
  const fd = fs.openSync(dirPath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function flipCurrent(appDir, version) {
  const tmpPath = path.join(appDir, '.current.tmp');
  removeIfPresent(tmpPath);
  fs.symlinkSync(`versions/${version}`, tmpPath);
  fs.renameSync(tmpPath, path.join(appDir, 'current'));
  fsyncDir(appDir);
}

// Moves the live db/-wal/-shm aside instead of deleting them, so a snapshot copy failure
// (ENOSPC/EIO) can never destroy committed-but-uncheckpointed writes: the originals are still on
// disk, just renamed out of the way, and get moved back if the copy fails.
function moveAside(dbPath, preservedDir) {
  const moved = [];
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const from = `${dbPath}${suffix}`;
      if (!fs.existsSync(from)) continue;
      fs.renameSync(from, path.join(preservedDir, `harmonic.db${suffix}`));
      moved.push(suffix);
    }
  } catch (error) {
    // Undo whatever this call already moved before the caller sees the failure, so a partial
    // move (e.g. the db renamed but -wal failing) never strands the live database mid-flight.
    moveBack(dbPath, preservedDir, moved);
    throw error;
  }
  return moved;
}

function moveBack(dbPath, preservedDir, moved) {
  let ok = true;
  for (const suffix of moved) {
    try {
      fs.renameSync(path.join(preservedDir, `harmonic.db${suffix}`), `${dbPath}${suffix}`);
    } catch (error) {
      logError(`could not move harmonic.db${suffix} back from ${preservedDir}`, error);
      ok = false;
    }
  }
  return ok;
}

// Returns { restored, preservedDir }. preservedDir is set whenever the pre-rollback database is
// sitting somewhere other than its original path, so operators can recover it either way.
function restoreDatabase(dataDir, appDir, snapshotPath, fromVersion) {
  const dbPath = path.join(dataDir, 'harmonic.db');
  if (!fs.existsSync(snapshotPath)) {
    logError('database was not restored', new Error(`snapshot ${snapshotPath} is missing`));
    return { restored: false, preservedDir: null };
  }

  // Preserved on the same filesystem as harmonic.db (dataDir, not appDir), so moving the live
  // files aside is a same-filesystem rename and can't fail with EXDEV.
  const preservedDir = path.join(dataDir, 'rolled-back', `${fromVersion}-${Date.now()}`);
  let moved;
  try {
    fs.mkdirSync(preservedDir, { recursive: true });
    moved = moveAside(dbPath, preservedDir);
    // moveAside() undoes its own partial failures, so reaching here means every db/-wal/-shm
    // file that existed made it into preservedDir intact. Fsync destination then source so the
    // move survives a crash before the copy below even starts.
    fsyncDir(preservedDir);
    fsyncDir(dataDir);
  } catch (error) {
    logError('database was not restored', error);
    try {
      fs.rmdirSync(preservedDir);
    } catch {
      // best-effort cleanup; moveAside() already reverted any files it moved
    }
    return { restored: false, preservedDir: null };
  }

  try {
    const tmpPath = `${dbPath}.restore.tmp`;
    fs.copyFileSync(snapshotPath, tmpPath);
    fsyncFile(tmpPath);
    fs.renameSync(tmpPath, dbPath);
    fsyncDir(dataDir);
    return { restored: true, preservedDir };
  } catch (error) {
    logError('database was not restored', error);
    const revertedOk = moveBack(dbPath, preservedDir, moved);
    if (revertedOk) {
      try {
        fs.rmdirSync(preservedDir);
      } catch {
        // best-effort cleanup of the now-empty preserved dir
      }
      return { restored: false, preservedDir: null };
    }
    logError('original database files could not be moved back; they remain preserved', new Error(preservedDir));
    return { restored: false, preservedDir };
  }
}

function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value), 'utf8');
  fsyncFile(tmpPath);
  fs.renameSync(tmpPath, filePath);
  fsyncDir(path.dirname(filePath));
}

function main() {
  const dataDir = process.argv[2];
  if (!dataDir) return;
  const appDir = path.join(dataDir, 'app');
  const pendingPath = path.join(appDir, 'pending.json');

  let pending;
  try {
    pending = readJson(pendingPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') logError('could not read pending.json', error);
    return;
  }
  if (!isValidPending(pending)) {
    logError('ignoring pending.json', new Error('unexpected shape'));
    return;
  }

  const currentVersion = readCurrentVersion(appDir);
  if (currentVersion !== pending.version) {
    removeIfPresent(pendingPath);
    return;
  }

  const boots = (typeof pending.boots === 'number' && pending.boots >= 0 ? pending.boots : 0) + 1;
  if (boots <= 3) {
    writeJsonAtomic(pendingPath, { ...pending, boots });
    return;
  }

  const { restored: databaseRestored, preservedDir } = restoreDatabase(dataDir, appDir, pending.snapshot, pending.version);

  // The database could not be restored (missing snapshot, failed copy, or failed preservation):
  // rolling back now would open the previous release against a database the failed release may
  // have already migrated. Leave `current` and `pending.json` exactly as they are — the live
  // db/-wal/-shm are already back in their original place (restoreDatabase()/moveAside() never
  // leave a failed attempt half-moved) — so every subsequent boot retries the restore, and a
  // later attempt that succeeds falls through to the normal flip below.
  if (!databaseRestored) {
    const reason =
      `Rollback to ${pending.previous} is blocked: the database from before the ${pending.version} upgrade could not be restored` +
      (preservedDir ? ` (the pre-rollback files are preserved at ${preservedDir})` : '') +
      `. Harmonic will retry the restore on every start. Check the service log, available disk space, and that the snapshot at ${pending.snapshot} exists.`;
    logError('rollback blocked', new Error(reason));
    writeJsonAtomic(pendingPath, { ...pending, boots }); // keep counting so every later boot retries the restore
    writeJsonAtomic(path.join(appDir, 'rollback.json'), {
      rolledBack: false,
      blockedReason: 'database-not-restored',
      fromVersion: pending.version,
      toVersion: pending.previous,
      at: new Date().toISOString(),
      reason,
      ...(preservedDir ? { preservedDatabaseDir: preservedDir } : {}),
    });
    return;
  }

  flipCurrent(appDir, pending.previous);
  const reason = `${pending.version} failed to start 4 times, so Harmonic rolled back to ${pending.previous} and restored the database from before the upgrade. Changes made after the upgrade started were discarded. The database from just before the rollback is preserved at ${preservedDir}.`;
  writeJsonAtomic(path.join(appDir, 'rollback.json'), {
    fromVersion: pending.version,
    toVersion: pending.previous,
    at: new Date().toISOString(),
    reason,
    databaseRestored: true,
    preservedDatabaseDir: preservedDir,
  });
  removeIfPresent(pendingPath);
}

try {
  main();
} catch (error) {
  logError('failed', error);
}
