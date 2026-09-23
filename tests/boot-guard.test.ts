import { createClient } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('keeps the pending version through 3 boots, then flips to previous, restores the database, and writes rollback.json on the 4th', async () => {
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

    // Simulate the new version running and mutating live data after the snapshot was taken.
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

    const restoredClient = createClient({ url: `file:${dbPath}` });
    const rows = await restoredClient.execute('SELECT label FROM t');
    restoredClient.close();
    expect(rows.rows).toEqual([{ label: 'pre-upgrade' }]);
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
      } catch {
        // v2-broken throws on import; the loop moves on to the next guard run
      }
    }

    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/1.0.0');
    expect(readFileSync(markerPath, 'utf8')).toBe('v1-running');
  });
});
