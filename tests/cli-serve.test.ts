import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createShutdownHandler,
  createUpgradeReleaseLock,
  installManagedUpgrade,
  readManagedInstalledVersion,
  reconcileSystemdGuardRevision,
  type ManagedUpgradeFsDependencies,
} from '../src/cli-serve.js';
import { createServiceManager } from '../src/service-manager.js';
import { readInstalledVersion } from '../src/upgrade/version-install.js';
import { createTempDirTracker, packFixtureTarball } from './helpers/upgrade-fixture.js';

const execFileAsync = promisify(execFile);

describe('reconcileSystemdGuardRevision (real filesystem)', () => {
  const cleanup: string[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<{ systemUnitPath: string; userUnitPath: string; ensureUserUnitCurrent: () => Promise<unknown> | undefined; warn: (message: string) => void }> = {}) {
    const dir = tempDir('harmonic-guard-revision-');
    return {
      systemUnitPath: join(dir, 'system.service'),
      userUnitPath: join(dir, 'user.service'),
      fileExists: (path: string) => { try { readFileSync(path, 'utf8'); return true; } catch { return false; } },
      readFile: (path: string) => readFileSync(path, 'utf8'),
      ensureUserUnitCurrent: vi.fn(async () => undefined),
      warn: vi.fn(),
      ...overrides,
    };
  }

  it('reports guardMissing for a pre-boot-guard SYSTEM unit without attempting a rewrite, even though the running process is non-root', async () => {
    const d = deps();
    writeFileSync(d.systemUnitPath, 'Environment=HARMONIC_UNIT_REVISION=1\n');
    writeFileSync(d.userUnitPath, 'Environment=HARMONIC_UNIT_REVISION=2\n');

    await expect(reconcileSystemdGuardRevision(d)).resolves.toBe(true);

    expect(d.ensureUserUnitCurrent).not.toHaveBeenCalled();
    expect(d.warn).not.toHaveBeenCalled();
  });

  it('reports no guardMissing for a current SYSTEM unit', async () => {
    const d = deps();
    writeFileSync(d.systemUnitPath, 'Environment=HARMONIC_UNIT_REVISION=2\n');

    await expect(reconcileSystemdGuardRevision(d)).resolves.toBe(false);
    expect(d.ensureUserUnitCurrent).not.toHaveBeenCalled();
  });

  it('self-heals a pre-boot-guard USER unit and reports no guardMissing', async () => {
    const d = deps();
    writeFileSync(d.userUnitPath, 'Environment=HARMONIC_UNIT_REVISION=1\n');

    await expect(reconcileSystemdGuardRevision(d)).resolves.toBe(false);

    expect(d.ensureUserUnitCurrent).toHaveBeenCalledTimes(1);
  });

  it('reports guardMissing and warns when neither unit exists', async () => {
    const d = deps();

    await expect(reconcileSystemdGuardRevision(d)).resolves.toBe(true);

    expect(d.ensureUserUnitCurrent).not.toHaveBeenCalled();
    expect(d.warn).toHaveBeenCalledTimes(1);
  });

  it('reports guardMissing and warns when the user unit self-heal throws', async () => {
    const d = deps({ ensureUserUnitCurrent: vi.fn(async () => { throw new Error('daemon-reload failed'); }) });
    writeFileSync(d.userUnitPath, 'Environment=HARMONIC_UNIT_REVISION=1\n');

    await expect(reconcileSystemdGuardRevision(d)).resolves.toBe(true);

    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('daemon-reload failed'));
  });

  it('reports guardMissing and names the unit path when the real self-heal cannot reconstruct the unit, wired as in production', async () => {
    const dir = tempDir('harmonic-guard-revision-real-');
    const userUnitPath = join(dir, '.config', 'systemd', 'user', 'harmonic.service');
    mkdirSync(join(dir, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(userUnitPath, '[Service]\nEnvironment=HARMONIC_MANAGED_BY=systemd\n');
    const warn = vi.fn();
    const manager = createServiceManager(
      { platform: 'linux', isRoot: false, systemdRunning: false, initdAvailable: false, userSystemdUsable: true },
      {
        nodePath: '/usr/bin/node',
        currentVersion: '2.16.0',
        path: '/usr/local/bin:/usr/bin',
        homeDir: dir,
        userName: 'ada',
        run: async () => { throw new Error('unexpected systemctl call'); },
        mkdir: async () => {},
        writeFile: async () => {},
        chmod: async () => {},
        removeFile: async () => {},
        rename: async () => {},
        fileExists: (path) => path === userUnitPath,
        readFile: (path) => readFileSync(path, 'utf8'),
        readTextFile: async (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
        readlink: () => null,
      },
    );

    await expect(reconcileSystemdGuardRevision({
      systemUnitPath: join(dir, 'system.service'),
      userUnitPath,
      fileExists: (path) => path === userUnitPath,
      readFile: (path) => readFileSync(path, 'utf8'),
      ensureUserUnitCurrent: () => manager.ensureUnitRevisionCurrent?.(),
      warn,
    })).resolves.toBe(true);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(userUnitPath));
  });

  it('reports guardMissing and names the unit path when the real user unit exists but cannot be read, wired as in production', async () => {
    if (process.getuid?.() === 0) return; // root ignores file permissions, so chmod 000 would not reproduce this
    const dir = tempDir('harmonic-guard-revision-unreadable-');
    const userUnitPath = join(dir, '.config', 'systemd', 'user', 'harmonic.service');
    mkdirSync(join(dir, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(userUnitPath, '[Service]\nEnvironment=HARMONIC_MANAGED_BY=systemd\n');
    chmodSync(userUnitPath, 0o000);
    const warn = vi.fn();
    const manager = createServiceManager(
      { platform: 'linux', isRoot: false, systemdRunning: false, initdAvailable: false, userSystemdUsable: true },
      {
        nodePath: '/usr/bin/node',
        currentVersion: '2.16.0',
        path: '/usr/local/bin:/usr/bin',
        homeDir: dir,
        userName: 'ada',
        run: async () => { throw new Error('unexpected systemctl call'); },
        mkdir: async () => {},
        writeFile: async () => {},
        chmod: async () => {},
        removeFile: async () => {},
        rename: async () => {},
        fileExists: (path) => path === userUnitPath,
        readFile: (path) => readFileSync(path, 'utf8'),
        readTextFile: async (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
        readlink: () => null,
      },
    );

    await expect(reconcileSystemdGuardRevision({
      systemUnitPath: join(dir, 'system.service'),
      userUnitPath,
      fileExists: (path) => path === userUnitPath,
      readFile: (path) => readFileSync(path, 'utf8'),
      ensureUserUnitCurrent: () => manager.ensureUnitRevisionCurrent?.(),
      warn,
    })).resolves.toBe(true);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(userUnitPath));
  });
});

describe('createShutdownHandler', () => {
  it('calls release then exit(0), in that order', async () => {
    const calls: string[] = [];
    const release = vi.fn(async () => {
      calls.push('release');
    });
    const exit = vi.fn((code: number) => {
      calls.push(`exit:${code}`);
    });
    const shutdown = createShutdownHandler(release, exit);

    await shutdown();

    expect(calls).toEqual(['release', 'exit:0']);
    expect(release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a second sequential invocation calls neither release nor exit again', async () => {
    const release = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = createShutdownHandler(release, exit);

    await shutdown();
    await shutdown();

    expect(release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('concurrent overlapping invocations call neither release nor exit more than once', async () => {
    let resolveRelease: (() => void) | undefined;
    const release = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRelease = resolve;
        }),
    );
    const exit = vi.fn();
    const shutdown = createShutdownHandler(release, exit);

    const first = shutdown();
    const second = shutdown();
    resolveRelease?.();
    await Promise.all([first, second]);

    expect(release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a production-shaped release composed of close/telemetry.shutdown/releaseLock runs them in exactly that order', async () => {
    const calls: string[] = [];
    const app = {
      close: vi.fn(async () => {
        calls.push('app.close');
      }),
    };
    const telemetry = {
      shutdown: vi.fn(async () => {
        calls.push('telemetry.shutdown');
      }),
    };
    const releaseLock = vi.fn((dataDir: string) => {
      calls.push(`releaseLock:${dataDir}`);
    });
    const release = async () => {
      await app.close();
      await telemetry.shutdown();
      releaseLock('/data');
    };
    const exit = vi.fn();
    const shutdown = createShutdownHandler(release, exit);

    await shutdown();

    expect(calls).toEqual(['app.close', 'telemetry.shutdown', 'releaseLock:/data']);
  });
});

describe('createUpgradeReleaseLock', () => {
  it('releases the lock and exits cleanly, without forcing exit, when close and telemetry shutdown succeed', async () => {
    const calls: string[] = [];
    const releaseLock = createUpgradeReleaseLock({
      close: async () => { calls.push('close'); },
      shutdownTelemetry: async () => { calls.push('telemetry'); },
      releaseLock: () => { calls.push('releaseLock'); },
      exit: (code) => { calls.push(`exit:${code}`); },
      log: () => {},
    });

    await releaseLock();

    expect(calls).toEqual(['close', 'telemetry', 'releaseLock']);
  });

  it('still releases the lock and forces a non-zero exit when app.close throws', async () => {
    const calls: string[] = [];
    const releaseLock = createUpgradeReleaseLock({
      close: async () => { throw new Error('close failed'); },
      shutdownTelemetry: async () => { calls.push('telemetry'); },
      releaseLock: () => { calls.push('releaseLock'); },
      exit: (code) => { calls.push(`exit:${code}`); },
      log: () => {},
    });

    await releaseLock();

    expect(calls).toEqual(['telemetry', 'releaseLock', 'exit:1']);
  });

  it('still releases the lock and forces a non-zero exit when telemetry shutdown throws', async () => {
    const calls: string[] = [];
    const releaseLock = createUpgradeReleaseLock({
      close: async () => { calls.push('close'); },
      shutdownTelemetry: async () => { throw new Error('telemetry failed'); },
      releaseLock: () => { calls.push('releaseLock'); },
      exit: (code) => { calls.push(`exit:${code}`); },
      log: () => {},
    });

    await releaseLock();

    expect(calls).toEqual(['close', 'releaseLock', 'exit:1']);
  });

  it('bounds a hanging app.close with a timeout, still releasing the lock and forcing a non-zero exit', async () => {
    const calls: string[] = [];
    const releaseLock = createUpgradeReleaseLock({
      close: () => new Promise(() => {}),
      shutdownTelemetry: async () => { calls.push('telemetry'); },
      releaseLock: () => { calls.push('releaseLock'); },
      exit: (code) => { calls.push(`exit:${code}`); },
      log: () => {},
      timeoutMs: 20,
    });

    await releaseLock();

    expect(calls).toEqual(['telemetry', 'releaseLock', 'exit:1']);
  }, 2000);
});

describe('systemd upgrades', () => {
  const dataDir = '/var/lib/harmonic';
  const target = '2.6.0';
  const versionDir = '/var/lib/harmonic/app/versions/2.6.0';
  const stagingDir = '/var/lib/harmonic/app/versions/.2.6.0.staging';

  function stagedFs(): { fs: ManagedUpgradeFsDependencies; setInstalled: (value: boolean) => void } {
    let installed = false;
    return {
      setInstalled: (value) => { installed = value; },
      fs: {
        mkdir: async () => {},
        rm: async () => {},
        rename: async () => { installed = true; },
        fileExists: (path) => installed && path === join(versionDir, 'dist', 'cli.js'),
        readFile: () => JSON.stringify({ version: target }),
        readlink: () => null,
      },
    };
  }

  it('stages the install into versions/<v> without touching current', async () => {
    const run = vi.fn(async (_command: string, _args: readonly string[]) => ({}));
    const { fs } = stagedFs();

    await installManagedUpgrade({ dataDir, target, run, fs });

    expect(run.mock.calls).toEqual([
      ['npm', ['pack', '--pack-destination', stagingDir, `@mintopia/harmonic@${target}`]],
      ['tar', ['-xzf', `${stagingDir}/mintopia-harmonic-${target}.tgz`, '--strip-components=1', '-C', stagingDir]],
      ['npm', ['pkg', 'delete', 'devDependencies', 'scripts.prepare', '--prefix', stagingDir]],
      ['npm', ['i', '--prefix', stagingDir, '--omit=dev']],
      ['sync', ['-f', versionDir]],
    ]);
    expect(run.mock.calls.some(([command]) => command === 'ln')).toBe(false);
  });

  it('throws when the staged install fails verification', async () => {
    const run = vi.fn(async (_command: string, _args: readonly string[]) => ({}));
    const fs: ManagedUpgradeFsDependencies = {
      mkdir: async () => {},
      rm: async () => {},
      rename: async () => {},
      fileExists: () => false,
      readFile: () => JSON.stringify({ version: target }),
      readlink: () => null,
    };

    await expect(installManagedUpgrade({ dataDir, target, run, fs })).rejects.toThrow('did not produce a valid install');
  });

  it('skips reinstalling when versions/<v> already holds a valid install for the target', async () => {
    const run = vi.fn(async (_command: string, _args: readonly string[]) => ({}));
    const { fs, setInstalled } = stagedFs();
    setInstalled(true);

    await installManagedUpgrade({ dataDir, target, run, fs });

    expect(run.mock.calls).toEqual([]);
  });

  it('reads the installed version from the app/current symlink target, not its package.json', () => {
    const readlink = vi.fn(() => `versions/${target}`);
    const fileExists = vi.fn(() => true);

    expect(readManagedInstalledVersion({ dataDir, readlink, fileExists })).toBe(target);
    expect(readlink).toHaveBeenCalledWith('/var/lib/harmonic/app/current');
    expect(fileExists).toHaveBeenCalledWith(`/var/lib/harmonic/app/versions/${target}`);
  });

  it('reports unknown when app/current is missing or not a symlink', () => {
    const readlink = vi.fn(() => {
      throw new Error('ENOENT');
    });

    expect(readManagedInstalledVersion({ dataDir, readlink, fileExists: () => true })).toBe('unknown');
  });

  it('reports unknown when the symlink target does not exist under versions/ (dangling rollback target)', () => {
    const readlink = vi.fn(() => `versions/${target}`);

    expect(readManagedInstalledVersion({ dataDir, readlink, fileExists: () => false })).toBe('unknown');
  });
});

describe('installManagedUpgrade (real filesystem)', () => {
  const { tempDir, cleanupAll } = createTempDirTracker();
  const run = (command: string, args: readonly string[]) => execFileAsync(command, [...args]);

  function readInstalledVersionDirCli(dataDir: string, version: string): string {
    return readFileSync(join(dataDir, 'app', 'versions', version, 'dist', 'cli.js'), 'utf8');
  }

  afterEach(cleanupAll);

  it('installs a fixture package into app/versions/<v> without touching current, offline and without running its prepare script', async () => {
    const version = '0.0.0-test.1';
    const packageSpec = packFixtureTarball(tempDir, { version });
    const dataDir = tempDir('harmonic-upgrade-datadir-');

    await installManagedUpgrade({ dataDir, target: version, run, packageSpec });

    expect(readInstalledVersionDirCli(dataDir, version)).toContain('fixture-cli');
    expect(readInstalledVersion({ dir: join(dataDir, 'app', 'versions', version), readFile: (path) => readFileSync(path, 'utf8') })).toBe(version);
    expect(readManagedInstalledVersion({ dataDir, readlink: (path) => readlinkSync(path), fileExists: existsSync })).toBe('unknown');
  }, 30_000);

  it('repairs a pre-existing broken versions/<v> (old nested node_modules layout) on retry', async () => {
    const version = '0.0.0-test.2';
    const packageSpec = packFixtureTarball(tempDir, { version });
    const dataDir = tempDir('harmonic-upgrade-datadir-');
    const brokenVersionDir = join(dataDir, 'app', 'versions', version);
    mkdirSync(join(brokenVersionDir, 'node_modules', '@mintopia', 'harmonic', 'dist'), { recursive: true });
    writeFileSync(
      join(brokenVersionDir, 'node_modules', '@mintopia', 'harmonic', 'package.json'),
      JSON.stringify({ name: '@mintopia/harmonic', version }),
    );
    writeFileSync(join(brokenVersionDir, 'package.json'), JSON.stringify({ name: 'harmonic-npm-wrapper' }));

    await installManagedUpgrade({ dataDir, target: version, run, packageSpec });

    expect(readInstalledVersionDirCli(dataDir, version)).toContain('fixture-cli');
    expect(readInstalledVersion({ dir: join(dataDir, 'app', 'versions', version), readFile: (path) => readFileSync(path, 'utf8') })).toBe(version);
  }, 30_000);
});
