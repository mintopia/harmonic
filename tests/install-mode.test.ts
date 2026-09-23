import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultIsWritable, detectSystemdInstallMigration, requiresSystemdInstallMigration, resolveInstallMode } from '../src/upgrade/install-mode.js';

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
      "Upgrading from the app is off until you re-run sudo harmonic install, which reuses this service's existing port, host, data directory, and password.",
    ]);
  });
});

describe('resolveInstallMode (real temp filesystem)', () => {
  const cleanup: string[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(dir);
    return dir;
  }

  afterEach(() => {
    const dirs = cleanup.splice(0);
    for (const dir of dirs) chmodSync(dir, 0o755);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('recognizes a systemd install with a symlinked app/current', () => {
    const dataDir = tempDir('harmonic-install-mode-systemd-');
    mkdirSync(join(dataDir, 'app', 'versions', '2.6.0', 'dist'), { recursive: true });
    symlinkSync(join(dataDir, 'app', 'versions', '2.6.0'), join(dataDir, 'app', 'current'));
    const cliPath = join(dataDir, 'app', 'current', 'dist', 'cli.js');

    const mode = resolveInstallMode({
      env: { HARMONIC_MANAGED_BY: 'systemd' },
      dataDir,
      cliPath,
      realpath: realpathSync,
      isWritable: () => true,
    });

    expect(mode).toEqual({ kind: 'systemd' });
  });

  it('flags a legacy systemd install (cli.js outside app/current) as migration-required', () => {
    const dataDir = tempDir('harmonic-install-mode-migration-');

    const mode = resolveInstallMode({
      env: { HARMONIC_MANAGED_BY: 'systemd' },
      dataDir,
      cliPath: '/usr/lib/node_modules/@mintopia/harmonic/dist/cli.js',
      realpath: realpathSync,
      isWritable: () => true,
    });

    expect(mode).toEqual({ kind: 'migration-required' });
  });

  it('recognizes an init.d install', () => {
    const dataDir = tempDir('harmonic-install-mode-initd-');

    const mode = resolveInstallMode({
      env: { HARMONIC_MANAGED_BY: 'initd' },
      dataDir,
      cliPath: join(dataDir, 'app', 'current', 'dist', 'cli.js'),
      realpath: realpathSync,
      isWritable: () => true,
    });

    expect(mode).toEqual({ kind: 'initd' });
  });

  it('recognizes an npx invocation and builds the npx command', () => {
    const dataDir = tempDir('harmonic-install-mode-npx-datadir-');
    const npxRoot = tempDir('harmonic-install-mode-npx-cache-');
    const cliDir = join(npxRoot, '_npx', 'abc123', 'node_modules', '@mintopia', 'harmonic', 'dist');
    mkdirSync(cliDir, { recursive: true });
    const cliPath = join(cliDir, 'cli.js');
    writeFileSync(cliPath, '');

    const mode = resolveInstallMode({
      env: {},
      dataDir,
      cliPath,
      realpath: realpathSync,
      isWritable: () => true,
    });

    expect(mode.kind).toBe('external');
    if (mode.kind !== 'external') throw new Error('unreachable');
    expect(mode.subkind).toBe('npx');
    expect(mode.commandFor('2.6.0')).toBe('npx @mintopia/harmonic@2.6.0 serve');
  });

  it('recognizes a writable npm-global install and omits sudo', () => {
    const dataDir = tempDir('harmonic-install-mode-npmg-datadir-');
    const prefix = tempDir('harmonic-install-mode-npmg-writable-');
    const nodeModulesDir = join(prefix, 'lib', 'node_modules');
    const cliDir = join(nodeModulesDir, '@mintopia', 'harmonic', 'dist');
    mkdirSync(cliDir, { recursive: true });
    const cliPath = join(cliDir, 'cli.js');
    writeFileSync(cliPath, '');

    const mode = resolveInstallMode({
      env: {},
      dataDir,
      cliPath,
      realpath: realpathSync,
      isWritable: defaultIsWritable,
    });

    expect(mode.kind).toBe('external');
    if (mode.kind !== 'external') throw new Error('unreachable');
    expect(mode.subkind).toBe('npm-global');
    expect(mode.commandFor('2.6.0')).toBe('npm i -g @mintopia/harmonic@2.6.0');
  });

  it('prefixes sudo for a non-writable npm-global prefix', () => {
    const dataDir = tempDir('harmonic-install-mode-npmg-datadir2-');
    const prefix = tempDir('harmonic-install-mode-npmg-readonly-');
    const nodeModulesDir = join(prefix, 'lib', 'node_modules');
    const cliDir = join(nodeModulesDir, '@mintopia', 'harmonic', 'dist');
    mkdirSync(cliDir, { recursive: true });
    const cliPath = join(cliDir, 'cli.js');
    writeFileSync(cliPath, '');
    chmodSync(nodeModulesDir, 0o555);

    const mode = resolveInstallMode({
      env: {},
      dataDir,
      cliPath,
      realpath: realpathSync,
      isWritable: defaultIsWritable,
    });

    expect(mode.kind).toBe('external');
    if (mode.kind !== 'external') throw new Error('unreachable');
    expect(mode.subkind).toBe('npm-global');
    expect(mode.commandFor('2.6.0')).toBe('sudo npm i -g @mintopia/harmonic@2.6.0');

    chmodSync(nodeModulesDir, 0o755);
  });

  it('falls back to unknown for any other install shape', () => {
    const dataDir = tempDir('harmonic-install-mode-unknown-datadir-');
    const somewhereElse = tempDir('harmonic-install-mode-unknown-cli-');
    const cliPath = join(somewhereElse, 'cli.js');
    writeFileSync(cliPath, '');

    const mode = resolveInstallMode({
      env: {},
      dataDir,
      cliPath,
      realpath: realpathSync,
      isWritable: () => true,
    });

    expect(mode.kind).toBe('external');
    if (mode.kind !== 'external') throw new Error('unreachable');
    expect(mode.subkind).toBe('unknown');
    expect(mode.commandFor('2.6.0')).toContain('2.6.0');
  });
});
