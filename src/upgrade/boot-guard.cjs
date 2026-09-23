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

function flipCurrent(appDir, version) {
  const tmpPath = path.join(appDir, '.current.tmp');
  removeIfPresent(tmpPath);
  fs.symlinkSync(`versions/${version}`, tmpPath);
  fs.renameSync(tmpPath, path.join(appDir, 'current'));
}

// The WAL must go before the snapshot lands, or SQLite replays the newer release's writes onto it.
function restoreDatabase(dataDir, snapshotPath) {
  const dbPath = path.join(dataDir, 'harmonic.db');
  try {
    if (!fs.existsSync(snapshotPath)) throw new Error(`snapshot ${snapshotPath} is missing`);
    const walRemoved = removeIfPresent(`${dbPath}-wal`);
    const shmRemoved = removeIfPresent(`${dbPath}-shm`);
    if (!walRemoved || !shmRemoved) throw new Error('the database write-ahead log could not be cleared');
    const tmpPath = `${dbPath}.restore.tmp`;
    fs.copyFileSync(snapshotPath, tmpPath);
    fs.renameSync(tmpPath, dbPath);
    return true;
  } catch (error) {
    logError('database was not restored', error);
    return false;
  }
}

function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value), 'utf8');
  fs.renameSync(tmpPath, filePath);
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

  const databaseRestored = restoreDatabase(dataDir, pending.snapshot);
  flipCurrent(appDir, pending.previous);
  writeJsonAtomic(path.join(appDir, 'rollback.json'), {
    fromVersion: pending.version,
    toVersion: pending.previous,
    at: new Date().toISOString(),
    reason: databaseRestored
      ? `${pending.version} failed to start 4 times, so Harmonic rolled back to ${pending.previous} and restored the database from before the upgrade. Changes made after the upgrade started were discarded.`
      : `${pending.version} failed to start 4 times, so Harmonic rolled back to ${pending.previous}. The database could not be restored from before the upgrade; check the service log.`,
    databaseRestored,
  });
  removeIfPresent(pendingPath);
}

try {
  main();
} catch (error) {
  logError('failed', error);
}
