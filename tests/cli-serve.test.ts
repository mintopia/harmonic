import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createShutdownHandler,
  detectSystemdInstallMigration,
  installSystemdUpgrade,
  readSystemdInstalledVersion,
  requiresSystemdInstallMigration,
  type SystemdUpgradeFsDependencies,
} from '../src/cli-serve.js';

const execFileAsync = promisify(execFile);

describe('requiresSystemdInstallMigration', () => {
  it('recognizes an npm-global CLI as a legacy systemd install and accepts the stable application path', () => {
    expect(requiresSystemdInstallMigration({
      managedBy: 'systemd',
      dataDir: '/var/lib/harmonic',
      cliPath: '/usr/lib/node_modules/@mintopia/harmonic/dist/cli-serve.js',
    })).toBe(true);
    expect(requiresSystemdInstallMigration({
      managedBy: 'systemd',
      dataDir: '/var/lib/harmonic',
      cliPath: '/var/lib/harmonic/app/current/dist/cli.js',
    })).toBe(false);
    expect(requiresSystemdInstallMigration({
      managedBy: undefined,
      dataDir: '/var/lib/harmonic',
      cliPath: '/usr/lib/node_modules/@mintopia/harmonic/dist/cli.js',
    })).toBe(false);
  });
});

describe('detectSystemdInstallMigration', () => {
  it('logs the operator notice for an old-style systemd ExecStart path', () => {
    const warnings: string[] = [];

    expect(detectSystemdInstallMigration({
      managedBy: 'systemd',
      dataDir: '/var/lib/harmonic',
      cliPath: '/usr/lib/node_modules/@mintopia/harmonic/dist/cli.js',
      warn: (message) => warnings.push(message),
    })).toBe(true);

    expect(warnings).toEqual([
      "Auto-upgrade is disabled until you re-run sudo harmonic install, which reuses this service's existing port, host, data directory, and password.",
    ]);
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

describe('systemd upgrades', () => {
  const dataDir = '/var/lib/harmonic';
  const target = '2.6.0';
  const versionDir = '/var/lib/harmonic/app/versions/2.6.0';
  const stagingDir = '/var/lib/harmonic/app/versions/.2.6.0.staging';

  function stagedFs(): { fs: SystemdUpgradeFsDependencies; setInstalled: (value: boolean) => void } {
    let installed = false;
    return {
      setInstalled: (value) => { installed = value; },
      fs: {
        mkdir: async () => {},
        rm: async () => {},
        rename: async () => { installed = true; },
        fileExists: (path) => installed && path === join(versionDir, 'dist', 'cli.js'),
        readFile: () => JSON.stringify({ version: target }),
      },
    };
  }

  it('stages the install, then verifies through the final directory before flipping current', async () => {
    const run = vi.fn(async (_command: string, _args: readonly string[]) => ({}));
    const { fs } = stagedFs();

    await installSystemdUpgrade({ dataDir, target, run, fs });

    expect(run.mock.calls).toEqual([
      ['npm', ['pack', '--pack-destination', stagingDir, `@mintopia/harmonic@${target}`]],
      ['tar', ['-xzf', `${stagingDir}/mintopia-harmonic-${target}.tgz`, '--strip-components=1', '-C', stagingDir]],
      ['npm', ['pkg', 'delete', 'devDependencies', 'scripts.prepare', '--prefix', stagingDir]],
      ['npm', ['i', '--prefix', stagingDir, '--omit=dev']],
      ['ln', ['-sfn', `versions/${target}`, '/var/lib/harmonic/app/current']],
    ]);
  });

  it('throws and never flips current when the staged install fails verification', async () => {
    const run = vi.fn(async (_command: string, _args: readonly string[]) => ({}));
    const fs: SystemdUpgradeFsDependencies = {
      mkdir: async () => {},
      rm: async () => {},
      rename: async () => {},
      fileExists: () => false,
      readFile: () => JSON.stringify({ version: target }),
    };

    await expect(installSystemdUpgrade({ dataDir, target, run, fs })).rejects.toThrow('did not produce a valid install');

    expect(run.mock.calls.some(([command]) => command === 'ln')).toBe(false);
  });

  it('skips reinstalling when versions/<v> already holds a valid install for the target', async () => {
    const run = vi.fn(async (_command: string, _args: readonly string[]) => ({}));
    const { fs, setInstalled } = stagedFs();
    setInstalled(true);

    await installSystemdUpgrade({ dataDir, target, run, fs });

    expect(run.mock.calls).toEqual([
      ['ln', ['-sfn', `versions/${target}`, '/var/lib/harmonic/app/current']],
    ]);
  });

  it('reads the installed version straight from app/current/package.json', () => {
    const readFile = vi.fn(() => JSON.stringify({ version: target }));

    expect(readSystemdInstalledVersion({ dataDir, readFile })).toBe(target);
    expect(readFile).toHaveBeenCalledWith('/var/lib/harmonic/app/current/package.json', 'utf8');
  });

  it('reports unknown for a malformed or missing package.json', () => {
    const readFile = vi.fn(() => {
      throw new Error('ENOENT');
    });

    expect(readSystemdInstalledVersion({ dataDir, readFile })).toBe('unknown');
  });
});

describe('installSystemdUpgrade (real filesystem)', () => {
  const cleanup: string[] = [];
  const run = (command: string, args: readonly string[]) => execFileAsync(command, [...args]);

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(dir);
    return dir;
  }

  function readInstalledCurrentCli(dataDir: string): string {
    return readFileSync(join(dataDir, 'app', 'current', 'dist', 'cli.js'), 'utf8');
  }

  // Built by hand, not `npm pack <dir>`: packing a local directory runs its prepare script immediately.
  function packFixtureTarball(version: string): string {
    const source = tempDir('harmonic-upgrade-fixture-src-');
    const packageDir = join(source, 'package');
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(join(packageDir, 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log("fixture-cli");\n');
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: '@mintopia/harmonic',
      version,
      devDependencies: { 'nonexistent-dev-dep': '999.999.999' },
      scripts: { prepare: 'exit 1' },
    }));
    const tarballDir = tempDir('harmonic-upgrade-fixture-tgz-');
    const tarballPath = join(tarballDir, `mintopia-harmonic-${version}.tgz`);
    execFileSync('tar', ['-czf', tarballPath, '-C', source, 'package']);
    return tarballPath;
  }

  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('installs a fixture package into app/current and makes it discoverable, offline and without running its prepare script', async () => {
    const version = '0.0.0-test.1';
    const packageSpec = packFixtureTarball(version);
    const dataDir = tempDir('harmonic-upgrade-datadir-');

    await installSystemdUpgrade({ dataDir, target: version, run, packageSpec });

    expect(readInstalledCurrentCli(dataDir)).toContain('fixture-cli');
    expect(readSystemdInstalledVersion({ dataDir, readFile: (path) => readFileSync(path, 'utf8') })).toBe(version);
  }, 30_000);

  it('repairs a pre-existing broken versions/<v> (old nested node_modules layout) on retry', async () => {
    const version = '0.0.0-test.2';
    const packageSpec = packFixtureTarball(version);
    const dataDir = tempDir('harmonic-upgrade-datadir-');
    const brokenVersionDir = join(dataDir, 'app', 'versions', version);
    mkdirSync(join(brokenVersionDir, 'node_modules', '@mintopia', 'harmonic', 'dist'), { recursive: true });
    writeFileSync(
      join(brokenVersionDir, 'node_modules', '@mintopia', 'harmonic', 'package.json'),
      JSON.stringify({ name: '@mintopia/harmonic', version }),
    );
    writeFileSync(join(brokenVersionDir, 'package.json'), JSON.stringify({ name: 'harmonic-npm-wrapper' }));

    await installSystemdUpgrade({ dataDir, target: version, run, packageSpec });

    expect(readInstalledCurrentCli(dataDir)).toContain('fixture-cli');
    expect(readSystemdInstalledVersion({ dataDir, readFile: (path) => readFileSync(path, 'utf8') })).toBe(version);
  }, 30_000);
});
