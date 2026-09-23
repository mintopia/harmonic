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

// Renames instead of deletes, so a failed copy can't destroy the live files; moved back on failure.
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
    // Reverts the partial move before the caller sees the failure; strandedSuffixes names anything the reversal itself couldn't move back.
    error.strandedSuffixes = moveBack(dbPath, preservedDir, moved);
    throw error;
  }
  return moved;
}

// Returns the suffixes that could NOT be moved back (still sitting in preservedDir); empty means
// every one of `moved` is back at dbPath.
function moveBack(dbPath, preservedDir, moved) {
  const stranded = [];
  for (const suffix of moved) {
    try {
      fs.renameSync(path.join(preservedDir, `harmonic.db${suffix}`), `${dbPath}${suffix}`);
    } catch (error) {
      logError(`could not move harmonic.db${suffix} back from ${preservedDir}`, error);
      stranded.push(suffix);
    }
  }
  return stranded;
}

// Only fsyncs once every file is fully moved back; returns any suffixes still stranded in preservedDir.
function moveBackAndSync(dbPath, dataDir, preservedDir, moved) {
  const stranded = moveBack(dbPath, preservedDir, moved);
  if (stranded.length > 0) return stranded;
  try {
    fsyncDir(dataDir);
  } catch (error) {
    logError(`could not fsync ${dataDir} after moving harmonic.db back`, error);
  }
  try {
    fsyncDir(preservedDir);
  } catch (error) {
    logError(`could not fsync ${preservedDir} after moving harmonic.db back`, error);
  }
  return [];
}

// Returns { restored, preservedDir, strandedFiles }; preservedDir is set when the pre-rollback
// database isn't back at its original path, with strandedFiles naming what's stuck there.
function restoreDatabase(dataDir, appDir, snapshotPath, fromVersion) {
  const dbPath = path.join(dataDir, 'harmonic.db');
  if (!fs.existsSync(snapshotPath)) {
    logError('database was not restored', new Error(`snapshot ${snapshotPath} is missing`));
    return { restored: false, preservedDir: null, strandedFiles: [] };
  }

  // Preserved on the same filesystem as harmonic.db (dataDir, not appDir), so moving the live
  // files aside is a same-filesystem rename and can't fail with EXDEV.
  const rolledBackDir = path.join(dataDir, 'rolled-back');
  const preservedDir = path.join(rolledBackDir, `${fromVersion}-${Date.now()}`);
  let moved;
  try {
    fs.mkdirSync(preservedDir, { recursive: true });
    moved = moveAside(dbPath, preservedDir);
    // Fsyncs preservedDir then rolledBackDir then dataDir, in that order, so a crash can't durably remove the originals before the preserved copy is durable.
    fsyncDir(preservedDir);
    fsyncDir(rolledBackDir);
    fsyncDir(dataDir);
  } catch (error) {
    logError('database was not restored', error);
    if (moved !== undefined) {
      // moveAside() already succeeded here; a later step (e.g. fsync) failed, so move the files back rather than stranding them.
      const stranded = moveBackAndSync(dbPath, dataDir, preservedDir, moved);
      if (stranded.length === 0) {
        try {
          fs.rmdirSync(preservedDir);
        } catch {
          // best-effort cleanup of the now-empty preserved dir
        }
        return { restored: false, preservedDir: null, strandedFiles: [] };
      }
      logError('original database files could not be moved back; they remain preserved', new Error(preservedDir));
      return { restored: false, preservedDir, strandedFiles: stranded.map((suffix) => `harmonic.db${suffix}`) };
    }
    // moveAside() failed and already reverted what it could; moved === undefined does not mean nothing is stranded.
    const stranded = Array.isArray(error.strandedSuffixes) ? error.strandedSuffixes : [];
    if (stranded.length === 0) {
      try {
        fs.rmdirSync(preservedDir);
      } catch {
        // best-effort cleanup; moveAside() already reverted any files it moved
      }
      return { restored: false, preservedDir: null, strandedFiles: [] };
    }
    logError('original database files could not be moved back; they remain preserved', new Error(preservedDir));
    return { restored: false, preservedDir, strandedFiles: stranded.map((suffix) => `harmonic.db${suffix}`) };
  }

  try {
    const tmpPath = `${dbPath}.restore.tmp`;
    fs.copyFileSync(snapshotPath, tmpPath);
    fsyncFile(tmpPath);
    fs.renameSync(tmpPath, dbPath);
    fsyncDir(dataDir);
    return { restored: true, preservedDir, strandedFiles: [] };
  } catch (error) {
    logError('database was not restored', error);
    const stranded = moveBackAndSync(dbPath, dataDir, preservedDir, moved);
    if (stranded.length === 0) {
      try {
        fs.rmdirSync(preservedDir);
      } catch {
        // best-effort cleanup of the now-empty preserved dir
      }
      return { restored: false, preservedDir: null, strandedFiles: [] };
    }
    logError('original database files could not be moved back; they remain preserved', new Error(preservedDir));
    return { restored: false, preservedDir, strandedFiles: stranded.map((suffix) => `harmonic.db${suffix}`) };
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

  const { restored: databaseRestored, preservedDir, strandedFiles } = restoreDatabase(dataDir, appDir, pending.snapshot, pending.version);

  // Leaves current/pending.json untouched so every later boot retries the restore, rather than
  // rolling back onto a database the failed release may have already migrated.
  if (!databaseRestored) {
    const reason =
      `Rollback to ${pending.previous} is blocked: the database from before the ${pending.version} upgrade could not be restored` +
      (preservedDir ? ` (the pre-rollback files are preserved at ${preservedDir})` : '') +
      `. Harmonic will retry the restore on every start. Check the service log, available disk space, and that the snapshot at ${pending.snapshot} exists.`;
    logError('rollback blocked', new Error(reason));
    writeJsonAtomic(pendingPath, { ...pending, boots });
    writeJsonAtomic(path.join(appDir, 'rollback.json'), {
      rolledBack: false,
      blockedReason: 'database-not-restored',
      fromVersion: pending.version,
      toVersion: pending.previous,
      at: new Date().toISOString(),
      reason,
      ...(preservedDir ? { preservedDatabaseDir: preservedDir } : {}),
    });
    if (preservedDir) {
      const incompleteReason =
        `Harmonic's live database is incomplete: ${strandedFiles.join(', ')} could not be moved back from ${preservedDir} to ${dataDir} ` +
        `during a blocked rollback of the ${pending.version} upgrade. Any db/-wal/-shm file not listed above may still be at its ` +
        `original path in ${dataDir}. To recover: stop Harmonic, move ${strandedFiles.join(', ')} from ${preservedDir} back to ${dataDir}, ` +
        `delete ${path.join(appDir, 'database-incomplete.json')}, then start Harmonic again.`;
      logError('database incomplete', new Error(incompleteReason));
      writeJsonAtomic(path.join(appDir, 'database-incomplete.json'), {
        dataDir,
        preservedDir,
        strandedFiles,
        reason: incompleteReason,
        at: new Date().toISOString(),
      });
    }
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
