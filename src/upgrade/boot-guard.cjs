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
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    // best-effort: the guard must never fail a boot
  }
  fs.symlinkSync(`versions/${version}`, tmpPath);
  fs.renameSync(tmpPath, path.join(appDir, 'current'));
}

function restoreDatabase(dataDir, snapshotPath) {
  const dbPath = path.join(dataDir, 'harmonic.db');
  fs.copyFileSync(snapshotPath, dbPath);
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // best-effort: the guard must never fail a boot
    }
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
  } catch {
    return; // no pending.json, or unreadable: nothing to guard
  }
  if (!isValidPending(pending)) return; // corrupt pending: leave current untouched

  const currentVersion = readCurrentVersion(appDir);
  if (currentVersion !== pending.version) {
    // Stale: current no longer matches what this pending record is guarding.
    try {
      fs.unlinkSync(pendingPath);
    } catch {
      // best-effort: the guard must never fail a boot
    }
    return;
  }

  const boots = (typeof pending.boots === 'number' && pending.boots >= 0 ? pending.boots : 0) + 1;
  if (boots <= 3) {
    writeJsonAtomic(pendingPath, { ...pending, boots });
    return;
  }

  try {
    restoreDatabase(dataDir, pending.snapshot);
  } catch {
    // best-effort: still flip current back even if the DB restore failed
  }
  flipCurrent(appDir, pending.previous);
  writeJsonAtomic(path.join(appDir, 'rollback.json'), {
    fromVersion: pending.version,
    toVersion: pending.previous,
    at: new Date().toISOString(),
    reason: `boot-guard: exceeded 3 restart attempts on ${pending.version}`,
    databaseRestored: true,
  });
  try {
    fs.unlinkSync(pendingPath);
  } catch {
    // best-effort: the guard must never fail a boot
  }
}

try {
  main();
} catch {
}
