import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_UNIT_REVISION, createServiceManager, unitRevision, type ServiceEnvironment, type ServiceManagerDependencies } from '../src/service-manager.js';
import { createTempDirTracker } from './helpers/upgrade-fixture.js';

const environment = (overrides: Partial<ServiceEnvironment> = {}): ServiceEnvironment => ({
  platform: 'linux',
  isRoot: false,
  systemdRunning: false,
  initdAvailable: false,
  userSystemdUsable: false,
  ...overrides,
});

const dependencies = (): ServiceManagerDependencies & { calls: string[][]; dirs: string[]; files: Map<string, string> } => {
  const calls: string[][] = [];
  const dirs: string[] = [];
  const files = new Map<string, string>();
  return {
    calls,
    dirs,
    files,
    currentVersion: '2.16.0',
    nodePath: '/usr/bin/node',
    path: '/usr/local/bin:/usr/bin',
    homeDir: '/home/ada',
    userName: 'ada',
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: 'active\n' };
    },
    mkdir: async (path) => { dirs.push(path); },
    writeFile: async (path, contents) => { files.set(path, contents); },
    chmod: async () => {},
    removeFile: async (path) => { files.delete(path); },
    rename: async () => {},
    fileExists: (path) => files.has(path),
    readFile: (path) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    readTextFile: async (path) => files.get(path) ?? null,
    readlink: () => null,
  };
};

describe('unitRevision', () => {
  it('reads the declared revision, defaulting to 0 for pre-boot-guard units', () => {
    expect(unitRevision('Environment=HARMONIC_UNIT_REVISION=2\n')).toBe(2);
    expect(unitRevision('Description=Harmonic\n')).toBe(0);
  });
});

describe('systemd unit boot-guard wiring', () => {
  it('adds ExecStartPre, RestartSec, StartLimit settings, and the revision marker', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4711', host: '127.0.0.1', dataDir: '/var/lib/harmonic' },
    });

    const unit = deps.files.get('/etc/systemd/system/harmonic.service') ?? '';
    expect(unit).toContain('ExecStartPre=-/usr/bin/node /var/lib/harmonic/app/boot-guard.cjs /var/lib/harmonic');
    expect(unit).toContain('RestartSec=2');
    expect(unit).toContain('StartLimitIntervalSec=120');
    expect(unit).toContain('StartLimitBurst=10');
    expect(unit).toContain('Environment=HARMONIC_UNIT_REVISION=2');
    expect(unitRevision(unit)).toBe(2);
  });

  it('leaves KillMode at its default (control-group) and sets a stop timeout, so a SIGKILLed server and its startup watcher both die together and Restart=always brings the unit back', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4711', host: '127.0.0.1', dataDir: '/var/lib/harmonic' },
    });

    const unit = deps.files.get('/etc/systemd/system/harmonic.service') ?? '';
    expect(unit).toContain('TimeoutStopSec=60');
    expect(unit).toContain('Restart=always');
    expect(unit).not.toContain('KillMode=');
  });

  it('copies the newly installed version boot-guard.cjs into app/', async () => {
    const deps = dependencies();
    deps.files.set('/var/lib/harmonic/app/versions/2.16.0/dist/upgrade/boot-guard.cjs', '// guard 2.16.0');
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4711', host: '127.0.0.1', dataDir: '/var/lib/harmonic' },
    });

    expect(deps.files.get('/var/lib/harmonic/app/boot-guard.cjs')).toBe('// guard 2.16.0');
  });

  it('does not fail install when the version has no boot-guard.cjs yet', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await expect(manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4711', host: '127.0.0.1', dataDir: '/var/lib/harmonic' },
    })).resolves.toMatchObject({ backend: 'systemd' });
    expect(deps.files.has('/var/lib/harmonic/app/boot-guard.cjs')).toBe(false);
  });
});

describe('ensureUnitRevisionCurrent (user-level self-heal, ADR-0042)', () => {
  it('rewrites a pre-boot-guard user unit with the recovered settings and reloads', async () => {
    const deps = dependencies();
    deps.files.set(
      '/home/ada/.config/systemd/user/harmonic.service',
      '[Unit]\nDescription=Harmonic\n\n[Service]\nType=simple\nExecStart=/usr/bin/node /home/ada/.harmonic/app/current/dist/cli.js serve --port 4711 --host 127.0.0.1 --data-dir /home/ada/.harmonic\nEnvironment=HARMONIC_MANAGED_BY=systemd\nRestart=always\n\n[Install]\nWantedBy=default.target\n',
    );
    const manager = createServiceManager(environment({ userSystemdUsable: true }), deps);

    await expect(manager.ensureUnitRevisionCurrent?.()).resolves.toBe(true);

    const rewritten = deps.files.get('/home/ada/.config/systemd/user/harmonic.service') ?? '';
    expect(unitRevision(rewritten)).toBe(CURRENT_UNIT_REVISION);
    expect(rewritten).toContain('ExecStartPre=-/usr/bin/node /home/ada/.harmonic/app/boot-guard.cjs /home/ada/.harmonic');
    expect(rewritten).toContain('--port 4711');
    expect(deps.calls).toContainEqual(['systemctl', '--user', 'daemon-reload']);
  });

  it('does nothing for a unit that already declares the current revision', async () => {
    const deps = dependencies();
    deps.files.set(
      '/home/ada/.config/systemd/user/harmonic.service',
      `[Service]\nExecStart=/usr/bin/node /home/ada/.harmonic/app/current/dist/cli.js serve --port 4711 --host 127.0.0.1 --data-dir /home/ada/.harmonic\nEnvironment=HARMONIC_UNIT_REVISION=${CURRENT_UNIT_REVISION}\n`,
    );
    const manager = createServiceManager(environment({ userSystemdUsable: true }), deps);

    await expect(manager.ensureUnitRevisionCurrent?.()).resolves.toBe(false);
    expect(deps.calls).toEqual([]);
  });

  it('does nothing when no unit is installed', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ userSystemdUsable: true }), deps);

    await expect(manager.ensureUnitRevisionCurrent?.()).resolves.toBe(false);
    expect(deps.calls).toEqual([]);
  });

  it('throws instead of silently reporting success when the existing unit cannot be reconstructed', async () => {
    const deps = dependencies();
    deps.files.set(
      '/home/ada/.config/systemd/user/harmonic.service',
      '[Service]\nEnvironment=HARMONIC_MANAGED_BY=systemd\n',
    );
    const manager = createServiceManager(environment({ userSystemdUsable: true }), deps);

    await expect(manager.ensureUnitRevisionCurrent?.()).rejects.toThrow(/harmonic\.service/);
    expect(deps.calls).toEqual([]);
  });

  it('is idempotent: a second call after a successful rewrite is a no-op', async () => {
    const deps = dependencies();
    deps.files.set(
      '/home/ada/.config/systemd/user/harmonic.service',
      '[Service]\nExecStart=/usr/bin/node /home/ada/.harmonic/app/current/dist/cli.js serve --port 4711 --host 127.0.0.1 --data-dir /home/ada/.harmonic\nEnvironment=HARMONIC_MANAGED_BY=systemd\n',
    );
    const manager = createServiceManager(environment({ userSystemdUsable: true }), deps);

    await expect(manager.ensureUnitRevisionCurrent?.()).resolves.toBe(true);
    deps.calls.length = 0;
    await expect(manager.ensureUnitRevisionCurrent?.()).resolves.toBe(false);
    expect(deps.calls).toEqual([]);
  });
});

describe('systemd unit (real filesystem)', () => {
  const { tempDir, cleanupAll } = createTempDirTracker();
  afterEach(cleanupAll);

  it('passes systemd-analyze verify, and install() into a temp root leaves a runnable app/boot-guard.cjs', async () => {
    let systemdAnalyzeAvailable = true;
    try {
      execFileSync('systemd-analyze', ['--version']);
    } catch {
      systemdAnalyzeAvailable = false;
    }

    const dataDir = tempDir('service-manager-real-datadir-');
    const guardSource = fileGuardPath();
    const realFsDeps: ServiceManagerDependencies = {
      currentVersion: '2.16.0',
      nodePath: process.execPath,
      path: '/usr/bin',
      homeDir: dataDir,
      userName: 'workspace',
      run: async () => ({ stdout: '' }),
      mkdir: async (path) => { mkdirSync(path, { recursive: true }); },
      writeFile: async (path, contents) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, contents); },
      chmod: async () => {},
      removeFile: async () => {},
      rename: async () => {},
      fileExists: (path) => existsSync(path),
      readFile: (path) => readFileSync(path, 'utf8'),
      readTextFile: async () => null,
      readlink: (path) => {
        try {
          return readlinkSync(path);
        } catch {
          return null;
        }
      },
    };
    // Seed the version layout install() expects, so it can find dist/upgrade/boot-guard.cjs without a real npm install.
    mkdirSync(join(dataDir, 'app', 'versions', '2.16.0', 'dist', 'upgrade'), { recursive: true });
    writeFileSync(join(dataDir, 'app', 'versions', '2.16.0', 'package.json'), JSON.stringify({ version: '2.16.0' }));
    writeFileSync(join(dataDir, 'app', 'versions', '2.16.0', 'dist', 'cli.js'), '');
    writeFileSync(join(dataDir, 'app', 'versions', '2.16.0', 'dist', 'upgrade', 'boot-guard.cjs'), readFileSync(guardSource, 'utf8'));

    const unitDir = tempDir('service-manager-unit-dir-');
    const manager = createServiceManager(environment({ userSystemdUsable: true }), { ...realFsDeps, homeDir: unitDir });
    // userSystemdUsable writes to <homeDir>/.config/systemd/user; point homeDir at dataDir's parent so the app tree and unit dir coexist.
    await manager.install({
      startSelfManaged: async () => {},
      serve: { port: '4711', host: '127.0.0.1', dataDir },
    });

    expect(readFileSync(join(dataDir, 'app', 'boot-guard.cjs'), 'utf8')).toContain('boot-guard');

    if (!systemdAnalyzeAvailable) return;
    const unitPath = join(unitDir, '.config', 'systemd', 'user', 'harmonic.service');
    expect(() => execFileSync('systemd-analyze', ['verify', unitPath], { stdio: 'pipe' })).not.toThrow();
  });
});

function fileGuardPath(): string {
  return new URL('../src/upgrade/boot-guard.cjs', import.meta.url).pathname;
}
