import { createClient } from '@libsql/client';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { installManagedUpgrade, readManagedInstalledVersion } from '../src/cli-serve.js';
import { flipCurrent, readPending, snapshotDatabase, writePending } from '../src/upgrade/boot-state.js';
import { UpgradeSwap, type UpgradeSwapDependencies } from '../src/upgrade/upgrade-swap.js';
import { UpgradeCancellation } from '../src/upgrade/upgrade-coordinator.js';
import { verifyInstall } from '../src/upgrade/version-install.js';
import { createTempDirTracker, packFixtureTarball } from './helpers/upgrade-fixture.js';

const execFileAsync = promisify(execFile);
const run = (command: string, args: readonly string[]) => execFileAsync(command, [...args]);
const readFileUtf8 = (path: string): string => readFileSync(path, 'utf8');

const { tempDir, cleanupAll } = createTempDirTracker();
afterEach(cleanupAll);

async function setupRunningV1(dataDir: string): Promise<void> {
  const v1Spec = packFixtureTarball(tempDir, { version: '1.0.0' });
  await installManagedUpgrade({ dataDir, target: '1.0.0', run, packageSpec: v1Spec });
  flipCurrent({ appDir: join(dataDir, 'app'), version: '1.0.0' });
}

function seedDatabase(dataDir: string): Promise<void> {
  return (async () => {
    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await client.execute('CREATE TABLE t (label TEXT)');
    await client.execute("INSERT INTO t (label) VALUES ('v1-row')");
    client.close();
  })();
}

function buildSwap(
  dataDir: string,
  packageSpec: string,
  extra: Partial<UpgradeSwapDependencies> = {},
): { swap: UpgradeSwap; calls: string[] } {
  const calls: string[] = [];
  const dependencies: UpgradeSwapDependencies = {
    install: async (version) => { await installManagedUpgrade({ dataDir, target: version, run, packageSpec }); },
    verify: async (version) => {
      await verifyInstall({
        dir: join(dataDir, 'app', 'versions', version),
        version,
        dependencies: {
          fileExists: existsSync,
          readFile: readFileUtf8,
          readlink: (path) => {
            try {
              return readlinkSync(path);
            } catch {
              return null;
            }
          },
        },
      });
    },
    commit: async (version) => {
      const appDir = join(dataDir, 'app');
      const previous = readManagedInstalledVersion({ dataDir, readlink: readlinkSync, fileExists: existsSync });
      const snapshot = await snapshotDatabase({ dataDir, version });
      writePending({ appDir, version, previous, snapshot });
      flipCurrent({ appDir, version });
    },
    spawnRelauncher: async () => { calls.push('relauncher'); },
    releaseLock: async () => { calls.push('release-lock'); },
    exit: () => { calls.push('exit'); },
    abort: async () => { calls.push('abort'); },
    operation: async (_input, work) => work(),
    log: () => {},
    ...extra,
  };
  return { swap: new UpgradeSwap(dependencies), calls };
}

describe('UpgradeSwap commit order (real fixtures, real SQLite)', () => {
  it('aborts on a broken release: current, pending.json, and the database are all untouched', async () => {
    const dataDir = tempDir('upgrade-swap-broken-');
    await setupRunningV1(dataDir);
    await seedDatabase(dataDir);
    const dbBefore = readFileSync(join(dataDir, 'harmonic.db'));

    const v2BrokenSpec = packFixtureTarball(tempDir, { version: '2.0.0', cliServeJs: "throw new Error('v2 is broken');\n" });
    const { swap, calls } = buildSwap(dataDir, v2BrokenSpec);

    const result = await swap.execute({ version: '2.0.0' });

    expect(result.kind).toBe('aborted');
    expect(readlinkSync(join(dataDir, 'app', 'current'))).toBe('versions/1.0.0');
    expect(existsSync(join(dataDir, 'app', 'pending.json'))).toBe(false);
    expect(readFileSync(join(dataDir, 'harmonic.db'))).toEqual(dbBefore);
    expect(calls).not.toContain('release-lock');
    expect(calls).not.toContain('exit');
  }, 30_000);

  it('commits a good release: current flips, pending.json records the snapshot, and the snapshot is a valid SQLite copy of the pre-upgrade DB', async () => {
    const dataDir = tempDir('upgrade-swap-good-');
    await setupRunningV1(dataDir);
    await seedDatabase(dataDir);

    const v2Spec = packFixtureTarball(tempDir, { version: '2.0.0' });
    const { swap, calls } = buildSwap(dataDir, v2Spec);

    const result = await swap.execute({ version: '2.0.0' });

    expect(result).toEqual({ kind: 'swapped' });
    expect(readlinkSync(join(dataDir, 'app', 'current'))).toBe('versions/2.0.0');
    const pending = readPending({ appDir: join(dataDir, 'app') });
    expect(pending).toMatchObject({ version: '2.0.0', previous: '1.0.0' });
    expect(existsSync(pending!.snapshot)).toBe(true);

    const snapshotClient = createClient({ url: `file:${pending!.snapshot}` });
    const rows = await snapshotClient.execute('SELECT label FROM t');
    snapshotClient.close();
    expect(rows.rows).toEqual([{ label: 'v1-row' }]);
    expect(calls).toContain('release-lock');
    expect(calls).toContain('exit');
  }, 30_000);

  it('aborts without flipping current when the DB snapshot fails, e.g. an unwritable app directory', async () => {
    const dataDir = tempDir('upgrade-swap-snapshot-fail-');
    await setupRunningV1(dataDir);
    const v2Spec = packFixtureTarball(tempDir, { version: '2.0.0' });
    // Pre-install while writable so the install step is a no-op retry under the read-only app/ below.
    await installManagedUpgrade({ dataDir, target: '2.0.0', run, packageSpec: v2Spec });
    const { swap, calls } = buildSwap(dataDir, v2Spec);

    chmodSync(join(dataDir, 'app'), 0o555);
    try {
      const result = await swap.execute({ version: '2.0.0' });
      expect(result.kind).toBe('aborted');
    } finally {
      chmodSync(join(dataDir, 'app'), 0o755);
    }

    expect(readlinkSync(join(dataDir, 'app', 'current'))).toBe('versions/1.0.0');
    expect(existsSync(join(dataDir, 'app', 'pending.json'))).toBe(false);
    expect(calls).not.toContain('release-lock');
    expect(calls).not.toContain('exit');
  }, 30_000);

  it('reports cancelled, not idle-timeout, and never touches disk when a cancellation lands while waitForIdle is still draining', async () => {
    const dataDir = tempDir('upgrade-swap-cancel-idle-');
    await setupRunningV1(dataDir);
    await seedDatabase(dataDir);
    const dbBefore = readFileSync(join(dataDir, 'harmonic.db'));

    const v2Spec = packFixtureTarball(tempDir, { version: '2.0.0' });
    const cancellation = new UpgradeCancellation();
    const { swap, calls } = buildSwap(dataDir, v2Spec, {
      cancellation,
      waitForIdle: async () => {
        cancellation.requestCancel();
        return false;
      },
    });

    const result = await swap.execute({ version: '2.0.0' });

    expect(result.kind).toBe('cancelled');
    expect(readlinkSync(join(dataDir, 'app', 'current'))).toBe('versions/1.0.0');
    expect(existsSync(join(dataDir, 'app', 'pending.json'))).toBe(false);
    expect(readFileSync(join(dataDir, 'harmonic.db'))).toEqual(dbBefore);
    expect(calls).not.toContain('release-lock');
    expect(calls).not.toContain('exit');
  }, 30_000);
});
