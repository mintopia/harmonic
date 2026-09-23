import { createClient } from '@libsql/client';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDirTracker } from './helpers/upgrade-fixture.js';

const { tempDir, cleanupAll } = createTempDirTracker();
afterEach(cleanupAll);

const guardPath = fileURLToPath(new URL('../src/upgrade/boot-guard.cjs', import.meta.url));

function runGuard(dataDir: string): void {
  execFileSync('node', [guardPath, dataDir]);
}

function seedVersion(appDir: string, version: string, cliJsContents: string): void {
  mkdirSync(join(appDir, 'versions', version, 'dist'), { recursive: true });
  writeFileSync(join(appDir, 'versions', version, 'dist', 'cli.js'), cliJsContents);
}

function makeDataDir(): { dataDir: string; appDir: string } {
  const dataDir = tempDir('boot-guard-datadir-');
  const appDir = join(dataDir, 'app');
  mkdirSync(appDir, { recursive: true });
  return { dataDir, appDir };
}

describe('boot-guard.cjs', () => {
  it('exits 0 and does nothing when there is no pending.json', () => {
    const { dataDir, appDir } = makeDataDir();
    seedVersion(appDir, '1.0.0', '');
    symlinkSync('versions/1.0.0', join(appDir, 'current'));

    expect(() => runGuard(dataDir)).not.toThrow();
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/1.0.0');
  });

  it('leaves current untouched when pending.json is corrupt', () => {
    const { dataDir, appDir } = makeDataDir();
    seedVersion(appDir, '1.0.0', '');
    symlinkSync('versions/1.0.0', join(appDir, 'current'));
    writeFileSync(join(appDir, 'pending.json'), 'not json');

    runGuard(dataDir);

    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/1.0.0');
    expect(readFileSync(join(appDir, 'pending.json'), 'utf8')).toBe('not json');
  });

  it('removes a stale pending.json when current no longer matches it', () => {
    const { dataDir, appDir } = makeDataDir();
    seedVersion(appDir, '1.0.0', '');
    symlinkSync('versions/1.0.0', join(appDir, 'current'));
    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '9.9.9', previous: '1.0.0', snapshot: '/nowhere.db', boots: 0 }));

    runGuard(dataDir);

    expect(existsSync(join(appDir, 'pending.json'))).toBe(false);
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/1.0.0');
  });

  it('keeps the pending version through 3 boots, then flips to previous, restores the database, preserves the pre-rollback copy, and writes rollback.json on the 4th', async () => {
    const { dataDir, appDir } = makeDataDir();
    seedVersion(appDir, '1.0.0', '');
    seedVersion(appDir, '2.0.0', '');
    symlinkSync('versions/2.0.0', join(appDir, 'current'));

    const dbPath = join(dataDir, 'harmonic.db');
    const client = createClient({ url: `file:${dbPath}` });
    await client.execute('CREATE TABLE t (label TEXT)');
    await client.execute("INSERT INTO t (label) VALUES ('pre-upgrade')");
    client.close();
    const snapshotPath = join(appDir, 'pre-2.0.0.db');
    const snapshotClient = createClient({ url: `file:${snapshotPath}` });
    await snapshotClient.execute('CREATE TABLE t (label TEXT)');
    await snapshotClient.execute("INSERT INTO t (label) VALUES ('pre-upgrade')");
    snapshotClient.close();

    const liveClient = createClient({ url: `file:${dbPath}` });
    await liveClient.execute("DELETE FROM t WHERE label = 'pre-upgrade'");
    await liveClient.execute("INSERT INTO t (label) VALUES ('post-upgrade')");
    liveClient.close();
    writeFileSync(`${dbPath}-wal`, 'wal');
    writeFileSync(`${dbPath}-shm`, 'shm');

    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: snapshotPath, boots: 0 }));

    runGuard(dataDir);
    expect(JSON.parse(readFileSync(join(appDir, 'pending.json'), 'utf8'))).toMatchObject({ boots: 1 });
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/2.0.0');

    runGuard(dataDir);
    runGuard(dataDir);
    expect(JSON.parse(readFileSync(join(appDir, 'pending.json'), 'utf8'))).toMatchObject({ boots: 3 });
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/2.0.0');

    runGuard(dataDir);

    expect(existsSync(join(appDir, 'pending.json'))).toBe(false);
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/1.0.0');
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const rollback = JSON.parse(readFileSync(join(appDir, 'rollback.json'), 'utf8'));
    expect(rollback).toMatchObject({ fromVersion: '2.0.0', toVersion: '1.0.0', databaseRestored: true });
    expect(rollback.reason).toMatch(/restored the database/);
    expect(typeof rollback.preservedDatabaseDir).toBe('string');
    expect(rollback.reason).toContain(rollback.preservedDatabaseDir);

    const restoredClient = createClient({ url: `file:${dbPath}` });
    const rows = await restoredClient.execute('SELECT label FROM t');
    restoredClient.close();
    expect(rows.rows).toEqual([{ label: 'pre-upgrade' }]);

    const preservedDir = rollback.preservedDatabaseDir;
    expect(existsSync(join(preservedDir, 'harmonic.db'))).toBe(true);
    expect(existsSync(join(preservedDir, 'harmonic.db-wal'))).toBe(true);
    expect(existsSync(join(preservedDir, 'harmonic.db-shm'))).toBe(true);
    expect(readFileSync(join(preservedDir, 'harmonic.db-wal'), 'utf8')).toBe('wal');
  });

  it('preserves an uncheckpointed WAL write as a real, independently openable database', async () => {
    const { dataDir, appDir } = makeDataDir();
    seedVersion(appDir, '1.0.0', '');
    seedVersion(appDir, '2.0.0', '');
    symlinkSync('versions/2.0.0', join(appDir, 'current'));

    const dbPath = join(dataDir, 'harmonic.db');
    const client = createClient({ url: `file:${dbPath}` });
    await client.execute('PRAGMA journal_mode=WAL');
    await client.execute('CREATE TABLE t (label TEXT)');
    await client.execute("INSERT INTO t (label) VALUES ('pre-upgrade')");
    client.close();

    const snapshotPath = join(appDir, 'pre-2.0.0.db');
    const snapshotClient = createClient({ url: `file:${snapshotPath}` });
    await snapshotClient.execute('CREATE TABLE t (label TEXT)');
    await snapshotClient.execute("INSERT INTO t (label) VALUES ('pre-upgrade')");
    snapshotClient.close();

    // A post-upgrade write small enough to stay in the WAL, never checkpointed into harmonic.db.
    const liveClient = createClient({ url: `file:${dbPath}` });
    await liveClient.execute("INSERT INTO t (label) VALUES ('post-upgrade')");
    liveClient.close();
    expect(existsSync(`${dbPath}-wal`)).toBe(true); // sanity: the write really only lives in the WAL

    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: snapshotPath, boots: 3 }));

    runGuard(dataDir);

    const rollback = JSON.parse(readFileSync(join(appDir, 'rollback.json'), 'utf8'));
    expect(rollback.databaseRestored).toBe(true);
    const preservedDir = rollback.preservedDatabaseDir;

    const checkDir = tempDir('boot-guard-preserved-check-');
    const checkDbPath = join(checkDir, 'harmonic.db');
    writeFileSync(checkDbPath, readFileSync(join(preservedDir, 'harmonic.db')));
    writeFileSync(`${checkDbPath}-wal`, readFileSync(join(preservedDir, 'harmonic.db-wal')));
    const preservedClient = createClient({ url: `file:${checkDbPath}` });
    const rows = await preservedClient.execute("SELECT label FROM t WHERE label = 'post-upgrade'");
    preservedClient.close();
    expect(rows.rows).toEqual([{ label: 'post-upgrade' }]);
  });

  it('moves the live database back into place when moving the WAL aside fails partway through', () => {
    const { dataDir, appDir } = makeDataDir();
    seedVersion(appDir, '1.0.0', '');
    seedVersion(appDir, '2.0.0', '');
    symlinkSync('versions/2.0.0', join(appDir, 'current'));
    const snapshotPath = join(appDir, 'pre-2.0.0.db');
    writeFileSync(snapshotPath, 'snapshot');
    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: snapshotPath, boots: 3 }));
    const dbPath = join(dataDir, 'harmonic.db');
    writeFileSync(dbPath, 'live-db');
    writeFileSync(`${dbPath}-wal`, 'wal-before');

    const preloadPath = join(dataDir, 'fail-wal-rename-preload.cjs');
    writeFileSync(
      preloadPath,
      `
      const fs = require('node:fs');
      const original = fs.renameSync;
      let triggered = false;
      fs.renameSync = function (from, to) {
        if (!triggered && String(to).endsWith('harmonic.db-wal')) {
          triggered = true;
          const err = new Error('simulated I/O failure moving wal aside');
          err.code = 'EIO';
          throw err;
        }
        return original.call(this, from, to);
      };
      `,
    );

    const result = spawnSync('node', ['--require', preloadPath, guardPath, dataDir], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(existsSync(dbPath)).toBe(true);
    expect(readFileSync(dbPath, 'utf8')).toBe('live-db');
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(readFileSync(`${dbPath}-wal`, 'utf8')).toBe('wal-before');
    const rollback = JSON.parse(readFileSync(join(appDir, 'rollback.json'), 'utf8'));
    expect(rollback).toMatchObject({ rolledBack: false, blockedReason: 'database-not-restored' });
    expect(rollback.preservedDatabaseDir).toBeUndefined();
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/2.0.0');
    expect(existsSync(join(appDir, 'pending.json'))).toBe(true);
  });

  it('writes app/database-incomplete.json and preserves the stranded db when the reverse move also fails after the forward WAL move fails', () => {
    const { dataDir, appDir } = makeDataDir();
    seedVersion(appDir, '1.0.0', '');
    seedVersion(appDir, '2.0.0', '');
    symlinkSync('versions/2.0.0', join(appDir, 'current'));
    const snapshotPath = join(appDir, 'pre-2.0.0.db');
    writeFileSync(snapshotPath, 'snapshot');
    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: snapshotPath, boots: 3 }));
    const dbPath = join(dataDir, 'harmonic.db');
    writeFileSync(dbPath, 'live-db');
    writeFileSync(`${dbPath}-wal`, 'wal-before');

    const preloadPath = join(dataDir, 'fail-wal-and-reverse-rename-preload.cjs');
    writeFileSync(
      preloadPath,
      `
      const fs = require('node:fs');
      const original = fs.renameSync;
      let forwardWalFailed = false;
      fs.renameSync = function (from, to) {
        if (!forwardWalFailed && String(to).endsWith('harmonic.db-wal') && !String(from).includes('rolled-back')) {
          forwardWalFailed = true;
          const err = new Error('simulated I/O failure moving wal aside');
          err.code = 'EIO';
          throw err;
        }
        if (String(from).includes('rolled-back') && String(to).endsWith('harmonic.db') && !String(to).endsWith('harmonic.db-wal') && !String(to).endsWith('harmonic.db-shm')) {
          const err = new Error('simulated I/O failure moving db back');
          err.code = 'EIO';
          throw err;
        }
        return original.call(this, from, to);
      };
      `,
    );

    const result = spawnSync('node', ['--require', preloadPath, guardPath, dataDir], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(readFileSync(`${dbPath}-wal`, 'utf8')).toBe('wal-before');

    const rollback = JSON.parse(readFileSync(join(appDir, 'rollback.json'), 'utf8'));
    expect(rollback).toMatchObject({ rolledBack: false, blockedReason: 'database-not-restored' });
    expect(typeof rollback.preservedDatabaseDir).toBe('string');

    const incompletePath = join(appDir, 'database-incomplete.json');
    expect(existsSync(incompletePath)).toBe(true);
    const incomplete = JSON.parse(readFileSync(incompletePath, 'utf8'));
    expect(incomplete.preservedDir).toBe(rollback.preservedDatabaseDir);
    expect(incomplete.strandedFiles).toEqual(['harmonic.db']);
    expect(readFileSync(join(incomplete.preservedDir, 'harmonic.db'), 'utf8')).toBe('live-db');

    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/2.0.0');
    expect(existsSync(join(appDir, 'pending.json'))).toBe(true);
  });

  it('preserves the pre-rollback database on the same filesystem as harmonic.db, not under app/', () => {
    const { dataDir, appDir } = makeDataDir();
    seedVersion(appDir, '1.0.0', '');
    seedVersion(appDir, '2.0.0', '');
    symlinkSync('versions/2.0.0', join(appDir, 'current'));
    const snapshotPath = join(appDir, 'pre-2.0.0.db');
    writeFileSync(snapshotPath, 'snapshot');
    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: snapshotPath, boots: 3 }));
    writeFileSync(join(dataDir, 'harmonic.db'), 'live-db');

    runGuard(dataDir);

    const rollback = JSON.parse(readFileSync(join(appDir, 'rollback.json'), 'utf8'));
    expect(rollback.databaseRestored).toBe(true);
    const preservedDir: string = rollback.preservedDatabaseDir;
    expect(dirname(preservedDir)).toBe(join(dataDir, 'rolled-back'));
  });

  it('fsyncs the preserved dir before the data dir after moving the database aside', () => {
    const { dataDir, appDir } = makeDataDir();
    seedVersion(appDir, '1.0.0', '');
    seedVersion(appDir, '2.0.0', '');
    symlinkSync('versions/2.0.0', join(appDir, 'current'));
    const snapshotPath = join(appDir, 'pre-2.0.0.db');
    writeFileSync(snapshotPath, 'snapshot');
    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: snapshotPath, boots: 3 }));
    writeFileSync(join(dataDir, 'harmonic.db'), 'live-db');

    const logPath = join(dataDir, 'fsync-order.log');
    writeFileSync(logPath, '');
    const preloadPath = join(dataDir, 'fsync-order-preload.cjs');
    writeFileSync(
      preloadPath,
      `
      const fs = require('node:fs');
      const origOpen = fs.openSync;
      const origFsync = fs.fsyncSync;
      const fdPaths = new Map();
      fs.openSync = function (path, ...args) {
        const fd = origOpen.call(this, path, ...args);
        fdPaths.set(fd, String(path));
        return fd;
      };
      fs.fsyncSync = function (fd) {
        fs.appendFileSync(${JSON.stringify(logPath)}, (fdPaths.get(fd) || '') + '\\n');
        return origFsync.call(this, fd);
      };
      `,
    );

    const result = spawnSync('node', ['--require', preloadPath, guardPath, dataDir], { encoding: 'utf8' });
    expect(result.status).toBe(0);

    const rollback = JSON.parse(readFileSync(join(appDir, 'rollback.json'), 'utf8'));
    const preservedDir: string = rollback.preservedDatabaseDir;
    const rolledBackDir = join(dataDir, 'rolled-back');

    const calls = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const preservedIndex = calls.indexOf(preservedDir);
    const rolledBackIndex = calls.indexOf(rolledBackDir);
    const dataDirIndex = calls.indexOf(dataDir);
    expect(preservedIndex).toBeGreaterThanOrEqual(0);
    expect(rolledBackIndex).toBeGreaterThan(preservedIndex);
    expect(dataDirIndex).toBeGreaterThan(rolledBackIndex);
  });

  it('moves the live database back into place and reports it unpreserved when fsyncing the preserved dir fails', () => {
    const { dataDir, appDir } = makeDataDir();
    seedVersion(appDir, '1.0.0', '');
    seedVersion(appDir, '2.0.0', '');
    symlinkSync('versions/2.0.0', join(appDir, 'current'));
    const snapshotPath = join(appDir, 'pre-2.0.0.db');
    writeFileSync(snapshotPath, 'snapshot');
    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: snapshotPath, boots: 3 }));
    const dbPath = join(dataDir, 'harmonic.db');
    writeFileSync(dbPath, 'live-db');
    writeFileSync(`${dbPath}-wal`, 'wal-before');

    const preloadPath = join(dataDir, 'fail-preserved-fsync-preload.cjs');
    writeFileSync(
      preloadPath,
      `
      const fs = require('node:fs');
      const origOpen = fs.openSync;
      const origFsync = fs.fsyncSync;
      const fdPaths = new Map();
      fs.openSync = function (path, ...args) {
        const fd = origOpen.call(this, path, ...args);
        fdPaths.set(fd, String(path));
        return fd;
      };
      fs.fsyncSync = function (fd) {
        if (String(fdPaths.get(fd) || '').includes('rolled-back')) {
          const err = new Error('simulated I/O failure fsyncing preserved dir');
          err.code = 'EIO';
          throw err;
        }
        return origFsync.call(this, fd);
      };
      `,
    );

    const result = spawnSync('node', ['--require', preloadPath, guardPath, dataDir], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(existsSync(dbPath)).toBe(true);
    expect(readFileSync(dbPath, 'utf8')).toBe('live-db');
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(readFileSync(`${dbPath}-wal`, 'utf8')).toBe('wal-before');
    const rollback = JSON.parse(readFileSync(join(appDir, 'rollback.json'), 'utf8'));
    expect(rollback).toMatchObject({ rolledBack: false, blockedReason: 'database-not-restored' });
    expect(rollback.preservedDatabaseDir).toBeUndefined();
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/2.0.0');
    expect(existsSync(join(appDir, 'pending.json'))).toBe(true);
  });

  it('fsyncs the data dir before the preserved dir after moving the database back on a copy failure', () => {
    const { dataDir, appDir } = makeDataDir();
    const snapshotPath = join(appDir, 'pre-2.0.0.db');
    mkdirSync(snapshotPath); // a directory where a file is expected makes copyFileSync fail with EISDIR
    seedPendingAtFourthBoot(dataDir, appDir, snapshotPath);
    writeFileSync(join(dataDir, 'harmonic.db-wal'), 'newer-wal');

    const logPath = join(dataDir, 'fsync-moveback-order.log');
    writeFileSync(logPath, '');
    const preloadPath = join(dataDir, 'fsync-moveback-order-preload.cjs');
    writeFileSync(
      preloadPath,
      `
      const fs = require('node:fs');
      const origOpen = fs.openSync;
      const origFsync = fs.fsyncSync;
      const fdPaths = new Map();
      fs.openSync = function (path, ...args) {
        const fd = origOpen.call(this, path, ...args);
        fdPaths.set(fd, String(path));
        return fd;
      };
      fs.fsyncSync = function (fd) {
        fs.appendFileSync(${JSON.stringify(logPath)}, (fdPaths.get(fd) || '') + '\\n');
        return origFsync.call(this, fd);
      };
      `,
    );

    const result = spawnSync('node', ['--require', preloadPath, guardPath, dataDir], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const rolledBackDir = join(dataDir, 'rolled-back');
    if (existsSync(rolledBackDir)) expect(readdirSync(rolledBackDir)).toEqual([]);

    const calls = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const dataDirIndices = calls.reduce<number[]>((acc, call, index) => (call === dataDir ? [...acc, index] : acc), []);
    const rolledBackParentIndices = calls.reduce<number[]>(
      (acc, call, index) => (call.startsWith(join(dataDir, 'rolled-back')) && call !== dataDir ? [...acc, index] : acc),
      [],
    );
    expect(dataDirIndices.length).toBeGreaterThan(0);
    expect(rolledBackParentIndices.length).toBeGreaterThan(0);
    expect(Math.max(...dataDirIndices)).toBeLessThan(Math.max(...rolledBackParentIndices));
  });

  function seedPendingAtFourthBoot(dataDir: string, appDir: string, snapshotPath: string): void {
    seedVersion(appDir, '1.0.0', '');
    seedVersion(appDir, '2.0.0', '');
    symlinkSync('versions/2.0.0', join(appDir, 'current'));
    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: snapshotPath, boots: 3 }));
    writeFileSync(join(dataDir, 'harmonic.db'), 'live-db');
  }

  it('blocks the rollback, keeps pending.json (boots incremented), and leaves current and the live db alone when the snapshot is missing', () => {
    const { dataDir, appDir } = makeDataDir();
    seedPendingAtFourthBoot(dataDir, appDir, join(appDir, 'pre-2.0.0.db'));

    const result = spawnSync('node', [guardPath, dataDir], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/2.0.0');
    expect(readFileSync(join(dataDir, 'harmonic.db'), 'utf8')).toBe('live-db');
    expect(result.stderr).toMatch(/rollback blocked/);
    expect(JSON.parse(readFileSync(join(appDir, 'pending.json'), 'utf8'))).toMatchObject({ version: '2.0.0', previous: '1.0.0', boots: 4 });
    const rollback = JSON.parse(readFileSync(join(appDir, 'rollback.json'), 'utf8'));
    expect(rollback).toMatchObject({ rolledBack: false, blockedReason: 'database-not-restored', fromVersion: '2.0.0', toVersion: '1.0.0' });
    expect(rollback.reason).toMatch(/could not be restored/);
  });

  it('retries on the next boot and restores/flips once the snapshot exists', () => {
    const { dataDir, appDir } = makeDataDir();
    const snapshotPath = join(appDir, 'pre-2.0.0.db');
    seedPendingAtFourthBoot(dataDir, appDir, snapshotPath);
    spawnSync('node', [guardPath, dataDir], { encoding: 'utf8' });
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/2.0.0');

    writeFileSync(snapshotPath, 'snapshot');
    runGuard(dataDir);

    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/1.0.0');
    expect(existsSync(join(appDir, 'pending.json'))).toBe(false);
    const rollback = JSON.parse(readFileSync(join(appDir, 'rollback.json'), 'utf8'));
    expect(rollback).toMatchObject({ databaseRestored: true, fromVersion: '2.0.0', toVersion: '1.0.0' });
  });

  it('leaves the live database and WAL byte-identical to before, blocks the rollback, and keeps pending.json when the snapshot copy fails midway', () => {
    const { dataDir, appDir } = makeDataDir();
    const snapshotPath = join(appDir, 'pre-2.0.0.db');
    mkdirSync(snapshotPath); // a directory where a file is expected makes copyFileSync fail with EISDIR
    seedPendingAtFourthBoot(dataDir, appDir, snapshotPath);
    writeFileSync(join(dataDir, 'harmonic.db-wal'), 'newer-wal');
    const dbBefore = readFileSync(join(dataDir, 'harmonic.db'), 'utf8');
    const walBefore = readFileSync(join(dataDir, 'harmonic.db-wal'), 'utf8');

    const result = spawnSync('node', [guardPath, dataDir], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/2.0.0');
    expect(existsSync(join(appDir, 'pending.json'))).toBe(true);
    expect(readFileSync(join(dataDir, 'harmonic.db'), 'utf8')).toBe(dbBefore);
    expect(readFileSync(join(dataDir, 'harmonic.db-wal'), 'utf8')).toBe(walBefore);
    const rolledBackDir = join(dataDir, 'rolled-back');
    if (existsSync(rolledBackDir)) expect(readdirSync(rolledBackDir)).toEqual([]);
    const rollback = JSON.parse(readFileSync(join(appDir, 'rollback.json'), 'utf8'));
    expect(rollback).toMatchObject({ rolledBack: false, blockedReason: 'database-not-restored' });
    expect(rollback.preservedDatabaseDir).toBeUndefined();
    expect(result.stderr).toMatch(/rollback blocked/);
  });

  it('records fsyncSync calls against the pending/rollback files and their parent directory', () => {
    const { dataDir, appDir } = makeDataDir();
    seedPendingAtFourthBoot(dataDir, appDir, join(appDir, 'pre-2.0.0.db'));

    const logPath = join(dataDir, 'fsync-calls.log');
    writeFileSync(logPath, '');
    const preloadPath = join(dataDir, 'fsync-spy-preload.cjs');
    writeFileSync(
      preloadPath,
      `
      const fs = require('node:fs');
      const original = fs.fsyncSync;
      fs.fsyncSync = function (fd) {
        fs.appendFileSync(${JSON.stringify(logPath)}, 'fsync\\n');
        return original.call(this, fd);
      };
      `,
    );

    const result = spawnSync('node', ['--require', preloadPath, guardPath, dataDir], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    const calls = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    // rollback.json: fsync the tmp file, then fsync app/ after the rename; current's own flip also fsyncs app/.
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('end-to-end: a broken release rolls back across restart attempts and leaves the previous version running', () => {
    const { dataDir, appDir } = makeDataDir();
    seedVersion(appDir, '1.0.0', `
      const fs = require('node:fs');
      fs.writeFileSync(process.env.MARKER_PATH, 'v1-running');
    `);
    seedVersion(appDir, '2.0.0', "throw new Error('v2 is broken');");
    symlinkSync('versions/2.0.0', join(appDir, 'current'));
    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: join(appDir, 'pre-2.0.0.db'), boots: 0 }));
    writeFileSync(join(appDir, 'pre-2.0.0.db'), '');
    writeFileSync(join(dataDir, 'harmonic.db'), '');

    const markerPath = join(dataDir, 'marker.txt');
    for (let attempt = 0; attempt < 4; attempt++) {
      runGuard(dataDir);
      try {
        execFileSync('node', [join(appDir, 'current', 'dist', 'cli.js')], { env: { ...process.env, MARKER_PATH: markerPath }, stdio: 'pipe' });
      } catch {}
    }

    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/1.0.0');
    expect(readFileSync(markerPath, 'utf8')).toBe('v1-running');
  });
});
