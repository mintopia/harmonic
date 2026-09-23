import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearRollback,
  flipCurrent,
  markHealthy,
  pruneVersions,
  readCurrentVersion,
  readPending,
  readRollback,
  snapshotDatabase,
  writePending,
} from '../src/upgrade/boot-state.js';
import { createTempDirTracker } from './helpers/upgrade-fixture.js';

const { tempDir, cleanupAll } = createTempDirTracker();
afterEach(cleanupAll);

function makeAppDir(): string {
  const dataDir = tempDir('boot-state-datadir-');
  const appDir = join(dataDir, 'app');
  mkdirSync(appDir, { recursive: true });
  return appDir;
}

function seedVersion(appDir: string, version: string): void {
  const dir = join(appDir, 'versions', version, 'dist', 'upgrade');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(appDir, 'versions', version, 'dist', 'cli.js'), `// ${version}`);
  writeFileSync(join(dir, 'boot-guard.cjs'), `// guard for ${version}`);
}

describe('flipCurrent / readCurrentVersion', () => {
  it('points current at the target version atomically and is idempotent', () => {
    const appDir = makeAppDir();
    seedVersion(appDir, '1.0.0');
    seedVersion(appDir, '2.0.0');

    flipCurrent({ appDir, version: '1.0.0' });
    expect(readCurrentVersion({ appDir })).toBe('1.0.0');

    flipCurrent({ appDir, version: '2.0.0' });
    expect(readCurrentVersion({ appDir })).toBe('2.0.0');
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/2.0.0');
  });

  it('returns null for a missing or dangling current', () => {
    const appDir = makeAppDir();
    expect(readCurrentVersion({ appDir })).toBeNull();

    symlinkSync('versions/does-not-exist', join(appDir, 'current'));
    expect(readCurrentVersion({ appDir })).toBe('does-not-exist');
  });
});

describe('writePending / readPending', () => {
  it('round-trips a pending upgrade record', () => {
    const appDir = makeAppDir();
    writePending({ appDir, version: '2.0.0', previous: '1.0.0', snapshot: join(appDir, 'pre-2.0.0.db') });

    expect(readPending({ appDir })).toEqual({
      version: '2.0.0',
      previous: '1.0.0',
      snapshot: join(appDir, 'pre-2.0.0.db'),
      boots: 0,
    });
  });

  it('returns null for missing or corrupt pending.json', () => {
    const appDir = makeAppDir();
    expect(readPending({ appDir })).toBeNull();

    writeFileSync(join(appDir, 'pending.json'), 'not json');
    expect(readPending({ appDir })).toBeNull();
  });
});

describe('readRollback / clearRollback', () => {
  it('round-trips a rollback record and clears it idempotently', () => {
    const appDir = makeAppDir();
    const record = { fromVersion: '2.0.0', toVersion: '1.0.0', at: new Date().toISOString(), reason: 'test', databaseRestored: true };
    writeFileSync(join(appDir, 'rollback.json'), JSON.stringify(record));

    expect(readRollback({ appDir })).toEqual(record);

    clearRollback({ appDir });
    expect(readRollback({ appDir })).toBeNull();
    expect(() => clearRollback({ appDir })).not.toThrow();
  });

  it('returns null for corrupt rollback.json', () => {
    const appDir = makeAppDir();
    writeFileSync(join(appDir, 'rollback.json'), '{not json');
    expect(readRollback({ appDir })).toBeNull();
  });
});

describe('markHealthy', () => {
  it('clears pending, copies the running boot-guard into app/, and prunes when the boot matches the pending version', () => {
    const appDir = makeAppDir();
    seedVersion(appDir, '1.0.0');
    seedVersion(appDir, '2.0.0');
    flipCurrent({ appDir, version: '2.0.0' });
    writePending({ appDir, version: '2.0.0', previous: '1.0.0', snapshot: join(appDir, 'pre-2.0.0.db') });
    seedVersion(appDir, '3.0.0'); // a stray old version pruning should remove

    markHealthy({ appDir, runningVersion: '2.0.0' });

    expect(readPending({ appDir })).toBeNull();
    expect(readFileSync(join(appDir, 'boot-guard.cjs'), 'utf8')).toBe('// guard for 2.0.0');
    expect(existsSync(join(appDir, 'versions', '3.0.0'))).toBe(false);
    expect(existsSync(join(appDir, 'versions', '1.0.0'))).toBe(true); // kept as previous
    expect(existsSync(join(appDir, 'versions', '2.0.0'))).toBe(true); // kept as current
  });

  it('leaves pending untouched when the boot does not match the pending version', () => {
    const appDir = makeAppDir();
    seedVersion(appDir, '1.0.0');
    flipCurrent({ appDir, version: '1.0.0' });
    writePending({ appDir, version: '2.0.0', previous: '1.0.0', snapshot: join(appDir, 'pre-2.0.0.db') });

    markHealthy({ appDir, runningVersion: '1.0.0' });

    expect(readPending({ appDir })).not.toBeNull();
  });
});

describe('pruneVersions', () => {
  it('keeps only current and previous, removes stray versions/staging/tgz/stale snapshots, and is idempotent', () => {
    const appDir = makeAppDir();
    for (const version of ['1', '2', '3', '4']) seedVersion(appDir, version);
    mkdirSync(join(appDir, 'versions', '.4.staging'), { recursive: true });
    writeFileSync(join(appDir, 'stray.tgz'), 'tgz');
    writeFileSync(join(appDir, 'pre-1.db'), 'snap1');
    writeFileSync(join(appDir, 'pre-3.db'), 'snap3');
    flipCurrent({ appDir, version: '4' });
    writeFileSync(join(appDir, 'previous.json'), JSON.stringify({ version: '3' }));

    pruneVersions({ appDir });

    expect(existsSync(join(appDir, 'versions', '1'))).toBe(false);
    expect(existsSync(join(appDir, 'versions', '2'))).toBe(false);
    expect(existsSync(join(appDir, 'versions', '.4.staging'))).toBe(false);
    expect(existsSync(join(appDir, 'versions', '3'))).toBe(true);
    expect(existsSync(join(appDir, 'versions', '4'))).toBe(true);
    expect(existsSync(join(appDir, 'stray.tgz'))).toBe(false);
    expect(existsSync(join(appDir, 'pre-1.db'))).toBe(false);
    expect(existsSync(join(appDir, 'pre-3.db'))).toBe(true);

    pruneVersions({ appDir });
    expect(existsSync(join(appDir, 'versions', '3'))).toBe(true);
    expect(existsSync(join(appDir, 'versions', '4'))).toBe(true);
  });

  it('deletes nothing when current is dangling or missing', () => {
    const appDir = makeAppDir();
    for (const version of ['1', '2']) seedVersion(appDir, version);

    pruneVersions({ appDir }); // no current at all
    expect(existsSync(join(appDir, 'versions', '1'))).toBe(true);
    expect(existsSync(join(appDir, 'versions', '2'))).toBe(true);

    symlinkSync('versions/does-not-exist', join(appDir, 'current'));
    pruneVersions({ appDir });
    expect(existsSync(join(appDir, 'versions', '1'))).toBe(true);
    expect(existsSync(join(appDir, 'versions', '2'))).toBe(true);
  });
});

describe('snapshotDatabase', () => {
  it('VACUUMs the live database into a pre-<version> snapshot and is overwrite-safe', async () => {
    const dataDir = tempDir('boot-state-snapshot-');
    mkdirSync(join(dataDir, 'app'), { recursive: true });
    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await client.execute('CREATE TABLE t (label TEXT)');
    await client.execute("INSERT INTO t (label) VALUES ('pre-upgrade')");
    client.close();

    const snapshotPath = await snapshotDatabase({ dataDir, version: '2.0.0' });
    expect(snapshotPath).toBe(join(dataDir, 'app', 'pre-2.0.0.db'));
    expect(existsSync(snapshotPath)).toBe(true);

    const snapshotClient = createClient({ url: `file:${snapshotPath}` });
    const result = await snapshotClient.execute('SELECT label FROM t');
    snapshotClient.close();
    expect(result.rows).toEqual([{ label: 'pre-upgrade' }]);

    await expect(snapshotDatabase({ dataDir, version: '2.0.0' })).resolves.toBe(snapshotPath);
  });
});
