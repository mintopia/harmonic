import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installVersion, type VersionInstallDependencies } from '../src/upgrade/version-install.js';
import { createTempDirTracker } from './helpers/upgrade-fixture.js';

const { tempDir, cleanupAll } = createTempDirTracker();
afterEach(cleanupAll);

function realFsDependencies(run: VersionInstallDependencies['run']): VersionInstallDependencies {
  return {
    run,
    mkdir: async (path) => { mkdirSync(path, { recursive: true }); },
    rm: async (path) => { rmSync(path, { recursive: true, force: true }); },
    rename: async (from, to) => { renameSync(from, to); },
    fileExists: existsSync,
    readFile: (path) => readFileSync(path, 'utf8'),
    readlink: (path) => {
      try {
        return readlinkSync(path);
      } catch {
        return null;
      }
    },
  };
}

describe('installVersion durability (ADR-0042: sync before pending.json can reference the tree)', () => {
  it('syncs the filesystem holding the renamed version directory after the rename and before returning', async () => {
    const appDir = tempDir('version-install-sync-');
    const versionDir = join(appDir, 'versions', '2.0.0');
    const calls: string[][] = [];
    const deps = realFsDependencies(async (command, args) => { calls.push([command, ...args]); });

    await installVersion({ appDir, version: '2.0.0', dependencies: deps });

    const renameIndex = calls.findIndex((call) => call[0] === 'npm' && call[1] === 'i');
    const syncIndex = calls.findIndex((call) => call[0] === 'sync');
    expect(renameIndex).toBeGreaterThanOrEqual(0);
    expect(syncIndex).toBeGreaterThan(renameIndex);
    expect(calls[syncIndex]).toEqual(['sync', '-f', versionDir]);
  });

  it('falls back to a plain sync when -f is unsupported', async () => {
    const appDir = tempDir('version-install-sync-fallback-');
    const calls: string[][] = [];
    const deps = realFsDependencies(async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'sync' && args[0] === '-f') throw new Error('sync: invalid option -- f');
    });

    await expect(installVersion({ appDir, version: '2.0.0', dependencies: deps })).resolves.toBeDefined();
    expect(calls.filter((call) => call[0] === 'sync')).toEqual([['sync', '-f', join(appDir, 'versions', '2.0.0')], ['sync']]);
  });

  it('fails the install when neither sync form succeeds, so commit is never reached', async () => {
    const appDir = tempDir('version-install-sync-fail-');
    const deps = realFsDependencies(async (command, args) => {
      if (command === 'sync') throw new Error(args[0] === '-f' ? 'sync: invalid option -- f' : 'sync: I/O error');
    });

    await expect(installVersion({ appDir, version: '2.0.0', dependencies: deps })).rejects.toThrow('I/O error');
  });
});
