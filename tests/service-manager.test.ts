import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UnsupportedServicePlatformError,
  createServiceManager,
  initdScript,
  resolveServiceUser,
  type ServiceManagerDependencies,
  type ServiceEnvironment,
} from '../src/service-manager.js';

const environment = (overrides: Partial<ServiceEnvironment> = {}): ServiceEnvironment => ({
  platform: 'linux',
  isRoot: false,
  systemdRunning: false,
  initdAvailable: false,
  userSystemdUsable: false,
  ...overrides,
});

const initdDependencies = () => {
  const calls: string[][] = [];
  const dirs: string[] = [];
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  const warn = vi.fn();
  const dependencies = {
    warn,
    currentVersion: '2.16.0',
    nodePath: '/usr/bin/node',
    path: '/usr/local/bin:/usr/bin:/bin',
    homeDir: '/home/agent',
    userName: 'agent',
    sudoUser: 'agent',
    // `service harmonic status` mirrors real init.d: it fails until a start/restart has actually run.
    run: async (command: string, args: readonly string[]) => {
      if (command === 'service' && args[1] === 'status') {
        const started = calls.some(([cmd, , verb]) => cmd === 'service' && (verb === 'start' || verb === 'restart'));
        calls.push([command, ...args]);
        if (!started) throw new Error('not running');
        return { stdout: '' };
      }
      calls.push([command, ...args]);
      return { stdout: '' };
    },
    mkdir: async (path: string) => { dirs.push(path); },
    writeFile: async (path: string, contents: string) => { files.set(path, contents); },
    chmod: async (path: string, mode: number) => { modes.set(path, mode); },
    removeFile: async (path: string) => { files.delete(path); },
    rename: async () => {},
    fileExists: (path: string) => files.has(path),
    readFile: (path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    readTextFile: async (path: string) => files.get(path) ?? null,
    readlink: () => null,
  } satisfies ServiceManagerDependencies;
  return { dependencies, calls, dirs, files, modes, warn };
};

describe('ServiceManager backend detection', () => {
  it('prefers a root systemd service over init.d', () => {
    expect(createServiceManager(environment({ isRoot: true, systemdRunning: true, initdAvailable: true })).backend).toBe('systemd');
  });

  it('uses init.d for root when systemd is not running', () => {
    expect(createServiceManager(environment({ isRoot: true, initdAvailable: true })).backend).toBe('init.d');
  });

  it('uses a user systemd service when available', () => {
    expect(createServiceManager(environment({ userSystemdUsable: true })).backend).toBe('user-systemd');
  });

  it('falls back to the self-managed daemon when no service manager fits', () => {
    expect(createServiceManager(environment()).backend).toBe('self-managed');
  });

  it.each(['darwin', 'win32'] as const)('rejects %s', (platform) => {
    expect(() => createServiceManager(environment({ platform }))).toThrow(UnsupportedServicePlatformError);
    expect(() => createServiceManager(environment({ platform }))).toThrow('only systemd/init.d supported');
  });

  it('resolves an explicit user, then SUDO_USER, then workspace', () => {
    expect(resolveServiceUser({ user: 'operator', sudoUser: 'agent' })).toBe('operator');
    expect(resolveServiceUser({ sudoUser: 'agent' })).toBe('agent');
    expect(resolveServiceUser({})).toBe('workspace');
  });

  it('installs an executable LSB init.d script and registers then starts it', async () => {
    const initd = initdDependencies();
    const manager = createServiceManager(environment({ isRoot: true, initdAvailable: true }), initd.dependencies);

    await expect(manager.install({ startSelfManaged: vi.fn(), serve: { port: '4700', host: '0.0.0.0', dataDir: '/srv/harmonic' } }))
      .resolves.toEqual({ backend: 'init.d' });

    const script = initd.files.get('/etc/init.d/harmonic') ?? '';
    const runCli = 'HARMONIC_INITD_SERVICE=1 HARMONIC_MANAGED_BY=initd runuser -u agent -- /usr/bin/node /srv/harmonic/app/current/dist/cli.js';
    expect(script).toContain('### BEGIN INIT INFO');
    expect(script).toContain('if [ "$(id -u)" -ne 0 ]');
    expect(script).toContain('runuser -u agent -- /usr/bin/node /srv/harmonic/app/boot-guard.cjs /srv/harmonic || true');
    expect(script).toContain(`${runCli} start --data-dir /srv/harmonic`);
    expect(script).toContain(`${runCli} stop --data-dir /srv/harmonic`);
    expect(script).toContain(`${runCli} status --data-dir /srv/harmonic`);
    expect(script).toContain('restart|force-reload)');
    expect(initd.modes.get('/etc/init.d/harmonic')).toBe(0o755);
    expect(initd.dirs).toContain('/srv/harmonic');
    expect(initd.calls).toEqual([
      ['service', 'harmonic', 'status'],
      ['chown', 'agent', '/srv/harmonic'],
      ['npm', 'pack', '--pack-destination', '/srv/harmonic/app/versions/.2.16.0.staging', '@mintopia/harmonic@2.16.0'],
      ['tar', '-xzf', '/srv/harmonic/app/versions/.2.16.0.staging/mintopia-harmonic-2.16.0.tgz', '--strip-components=1', '-C', '/srv/harmonic/app/versions/.2.16.0.staging'],
      ['npm', 'pkg', 'delete', 'devDependencies', 'scripts.prepare', '--prefix', '/srv/harmonic/app/versions/.2.16.0.staging'],
      ['npm', 'i', '--prefix', '/srv/harmonic/app/versions/.2.16.0.staging', '--omit=dev'],
      ['sync', '-f', '/srv/harmonic/app/versions/2.16.0'],
      ['chown', '-R', 'agent', '/srv/harmonic/app'],
      ['ln', '-sfn', 'versions/2.16.0', '/srv/harmonic/app/current'],
      ['update-rc.d', 'harmonic', 'defaults'],
      ['service', 'harmonic', 'start'],
    ]);
  });

  it('shell-quotes an apostrophe in the data directory', async () => {
    const initd = initdDependencies();
    const manager = createServiceManager(environment({ isRoot: true, initdAvailable: true }), initd.dependencies);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: "/srv/harmonic's state" },
    });

    expect(initd.files.get('/etc/init.d/harmonic')).toContain("--data-dir '/srv/harmonic'\"'\"'s state'");
  });

  it('restarts, rather than starts, an already-running init.d service so new code takes effect', async () => {
    const initd = initdDependencies();
    const manager = createServiceManager(environment({ isRoot: true, initdAvailable: true }), initd.dependencies);
    initd.calls.push(['service', 'harmonic', 'start']);

    await manager.install({ startSelfManaged: vi.fn(), serve: { port: '4700', host: '0.0.0.0', dataDir: '/srv/harmonic' } });

    expect(initd.calls.at(-1)).toEqual(['service', 'harmonic', 'restart']);
  });

  it('warns when init.d would run Harmonic as root', async () => {
    const initd = initdDependencies();
    const manager = createServiceManager(environment({ isRoot: true, initdAvailable: true }), initd.dependencies);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/srv/harmonic' },
      user: 'root',
    });

    expect(initd.warn).toHaveBeenCalledWith(expect.stringContaining('root'));
    expect(initd.files.get('/etc/init.d/harmonic')).toContain('runuser -u root -- /usr/bin/node /srv/harmonic/app/current/dist/cli.js start');
  });

  it('stops, deregisters, and removes the init.d script without touching the data directory', async () => {
    const initd = initdDependencies();
    const manager = createServiceManager(environment({ isRoot: true, initdAvailable: true }), initd.dependencies);

    await manager.uninstall();

    expect(initd.calls).toEqual([
      ['service', 'harmonic', 'stop'],
      ['update-rc.d', '-f', 'harmonic', 'remove'],
    ]);
    expect(initd.files.has('/srv/harmonic')).toBe(false);
  });

  it('starts the standalone daemon and returns a boot-hook command on fallback install', async () => {
    const startSelfManaged = vi.fn(async () => {});
    const manager = createServiceManager(environment());

    await expect(manager.install({ startSelfManaged, bootCommand: 'harmonic start --data-dir /state' })).resolves.toEqual({
      backend: 'self-managed',
      bootCommand: 'harmonic start --data-dir /state',
    });
    expect(startSelfManaged).toHaveBeenCalledOnce();
    await expect(manager.isInstalled()).resolves.toBe(false);
  });
});

describe('systemd ServiceManager', () => {
  const dependencies = (): ServiceManagerDependencies & { calls: string[][]; dirs: string[]; files: Map<string, string>; modes: Map<string, number> } => {
    const calls: string[][] = [];
    const dirs: string[] = [];
    const files = new Map<string, string>();
    const modes = new Map<string, number>();
    return {
      calls,
      dirs,
      files,
      modes,
      currentVersion: '2.16.0',
      nodePath: '/usr/bin/node',
      path: '/opt/tools/bin:/usr/local/bin:/usr/bin:/bin',
      homeDir: '/home/ada',
      userName: 'ada',
      // `systemctl is-active` mirrors real systemd: it fails until a start/restart has actually run.
      run: async (command, args) => {
        if (command === 'systemctl' && args.includes('is-active')) {
          const started = calls.some(([cmd, ...rest]) => cmd === 'systemctl' && (rest.includes('start') || rest.includes('restart')));
          calls.push([command, ...args]);
          if (!started) throw new Error('inactive');
          return { stdout: 'active\n' };
        }
        calls.push([command, ...args]);
        return { stdout: 'active\n' };
      },
      mkdir: async (path) => { dirs.push(path); },
      writeFile: async (path, contents) => { files.set(path, contents); },
      chmod: async (path, mode) => { modes.set(path, mode); },
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

  it('installs a root system unit with absolute executable paths and no password file', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await expect(manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4711', host: '127.0.0.1', dataDir: '/var/lib/harmonic', otelEndpoint: 'http://otel' },
    })).resolves.toMatchObject({ backend: 'systemd', status: { running: true } });

    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('ExecStart=/usr/bin/node /var/lib/harmonic/app/current/dist/cli.js serve --port 4711 --host 127.0.0.1 --data-dir /var/lib/harmonic --otel-endpoint http://otel');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('WorkingDirectory=/var/lib/harmonic');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('Restart=always');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('TimeoutStopSec=60');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('Environment=PATH=/opt/tools/bin:/usr/local/bin:/usr/bin:/bin');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('Environment=HARMONIC_MANAGED_BY=systemd');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).not.toContain('EnvironmentFile=');
    expect(deps.files.has('/etc/systemd/system/harmonic.env')).toBe(false);
    expect(deps.dirs).toContain('/var/lib/harmonic');
    expect(deps.dirs).toContain('/var/lib/harmonic/app/versions/.2.16.0.staging');
    expect(deps.calls).toEqual([
      ['systemctl', 'is-active', 'harmonic'],
      ['chown', 'workspace', '/var/lib/harmonic'],
      ['npm', 'pack', '--pack-destination', '/var/lib/harmonic/app/versions/.2.16.0.staging', '@mintopia/harmonic@2.16.0'],
      ['tar', '-xzf', '/var/lib/harmonic/app/versions/.2.16.0.staging/mintopia-harmonic-2.16.0.tgz', '--strip-components=1', '-C', '/var/lib/harmonic/app/versions/.2.16.0.staging'],
      ['npm', 'pkg', 'delete', 'devDependencies', 'scripts.prepare', '--prefix', '/var/lib/harmonic/app/versions/.2.16.0.staging'],
      ['npm', 'i', '--prefix', '/var/lib/harmonic/app/versions/.2.16.0.staging', '--omit=dev'],
      ['sync', '-f', '/var/lib/harmonic/app/versions/2.16.0'],
      ['chown', '-R', 'workspace', '/var/lib/harmonic/app'],
      ['ln', '-sfn', 'versions/2.16.0', '/var/lib/harmonic/app/current'],
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', 'harmonic'],
      ['systemctl', 'start', 'harmonic'],
      ['systemctl', 'is-active', 'harmonic'],
    ]);
  });

  it('restarts, rather than starts, an already-running systemd unit so new code takes effect', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);
    deps.calls.push(['systemctl', 'start', 'harmonic']);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/srv/harmonic' },
    });

    const verbs = deps.calls.filter(([command]) => command === 'systemctl').map(([, verb]) => verb);
    expect(verbs.at(-2)).toBe('restart');
  });

  it('runs a system unit as the explicit install user and group', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/srv/harmonic' },
      user: 'operator',
    });

    const unit = deps.files.get('/etc/systemd/system/harmonic.service') ?? '';
    expect(unit).toContain('User=operator');
    expect(unit).toContain('Group=operator');
    expect(deps.calls).toContainEqual(['chown', '-R', 'operator', '/srv/harmonic/app']);
  });

  it('installs the injected running version under the app versions directory', async () => {
    const deps = { ...dependencies(), currentVersion: '3.1.4' };
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/srv/harmonic' },
    });

    expect(deps.dirs).toContain('/srv/harmonic/app/versions/.3.1.4.staging');
    expect(deps.calls).toContainEqual(['ln', '-sfn', 'versions/3.1.4', '/srv/harmonic/app/current']);
  });

  it('reinstalls an old systemd service into the stable layout without changing data files', async () => {
    const deps = dependencies();
    deps.files.set('/srv/harmonic/settings.yaml', 'existing data');
    deps.files.set('/etc/systemd/system/harmonic.service', 'ExecStart=/usr/bin/node /usr/lib/node_modules/@mintopia/harmonic/dist/cli.js serve');
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);
    const options = { startSelfManaged: vi.fn(), serve: { port: '4700', host: '0.0.0.0', dataDir: '/srv/harmonic' } };

    await manager.install(options);
    await manager.install(options);

    expect(deps.files.get('/srv/harmonic/settings.yaml')).toBe('existing data');
    expect(deps.dirs).toContain('/srv/harmonic/app/versions/.2.16.0.staging');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain(
      'ExecStart=/usr/bin/node /srv/harmonic/app/current/dist/cli.js serve',
    );
    expect(deps.calls.filter(([command]) => command === 'ln')).toEqual([
      ['ln', '-sfn', 'versions/2.16.0', '/srv/harmonic/app/current'],
      ['ln', '-sfn', 'versions/2.16.0', '/srv/harmonic/app/current'],
    ]);
    expect(deps.calls.filter(([command, action]) => command === 'systemctl' && action === 'daemon-reload')).toHaveLength(2);
  });

  it('rejects a version that could escape the app versions directory', async () => {
    const deps = { ...dependencies(), currentVersion: '../outside' };
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await expect(manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/srv/harmonic' },
    })).rejects.toThrow('Invalid string');
  });

  it('uses SUDO_USER for a system unit when no explicit user was passed', async () => {
    const deps = { ...dependencies(), sudoUser: 'operator' };
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/srv/harmonic' },
    });

    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('User=operator');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('Group=operator');
  });

  it('warns when a system unit would run Harmonic as root', async () => {
    const deps = { ...dependencies(), sudoUser: 'root', warn: vi.fn() };
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/srv/harmonic' },
    });

    expect(deps.warn).toHaveBeenCalledWith('Harmonic will run as root. Pass --user to run it as a non-root user.');
  });

  it('rejects a system service user that could change the unit file', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await expect(manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/srv/harmonic' },
      user: 'operator\nExecStart=/malicious',
    })).rejects.toThrow('Invalid systemd service user');

    expect(deps.files.has('/etc/systemd/system/harmonic.service')).toBe(false);
  });

  it('installs a user unit, enables linger, and persists an explicitly supplied password only', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ userSystemdUsable: true }), deps);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/home/ada/.harmonic', password: 'secret value' },
    });

    expect(deps.files.get('/home/ada/.config/systemd/user/harmonic.service')).toContain('EnvironmentFile=/home/ada/.config/systemd/user/harmonic.env');
    expect(deps.files.get('/home/ada/.config/systemd/user/harmonic.service')).toContain('ExecStart=/usr/bin/node /home/ada/.harmonic/app/current/dist/cli.js serve');
    expect(deps.files.get('/home/ada/.config/systemd/user/harmonic.env')).toBe('HARMONIC_PASSWORD="secret value"\n');
    expect(deps.modes.get('/home/ada/.config/systemd/user/harmonic.env')).toBe(0o600);
    expect(deps.dirs).toContain('/home/ada/.harmonic');
    expect(deps.dirs).toContain('/home/ada/.harmonic/app/versions/.2.16.0.staging');
    expect(deps.calls).toEqual([
      ['systemctl', '--user', 'is-active', 'harmonic'],
      ['loginctl', 'enable-linger', 'ada'],
      ['npm', 'pack', '--pack-destination', '/home/ada/.harmonic/app/versions/.2.16.0.staging', '@mintopia/harmonic@2.16.0'],
      ['tar', '-xzf', '/home/ada/.harmonic/app/versions/.2.16.0.staging/mintopia-harmonic-2.16.0.tgz', '--strip-components=1', '-C', '/home/ada/.harmonic/app/versions/.2.16.0.staging'],
      ['npm', 'pkg', 'delete', 'devDependencies', 'scripts.prepare', '--prefix', '/home/ada/.harmonic/app/versions/.2.16.0.staging'],
      ['npm', 'i', '--prefix', '/home/ada/.harmonic/app/versions/.2.16.0.staging', '--omit=dev'],
      ['sync', '-f', '/home/ada/.harmonic/app/versions/2.16.0'],
      ['ln', '-sfn', 'versions/2.16.0', '/home/ada/.harmonic/app/current'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'harmonic'],
      ['systemctl', '--user', 'start', 'harmonic'],
      ['systemctl', '--user', 'is-active', 'harmonic'],
    ]);
  });

  it('does not chown the app tree for a user-level unit', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ userSystemdUsable: true }), deps);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/home/ada/.harmonic' },
    });

    expect(deps.dirs).toContain('/home/ada/.harmonic');
    expect(deps.calls.some(([command]) => command === 'chown')).toBe(false);
  });

  it('ignores --user for a user-level systemd unit and warns', async () => {
    const deps = { ...dependencies(), warn: vi.fn() };
    const manager = createServiceManager(environment({ userSystemdUsable: true }), deps);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/home/ada/.harmonic' },
      user: 'operator',
    });

    const unit = deps.files.get('/home/ada/.config/systemd/user/harmonic.service') ?? '';
    expect(unit).not.toContain('User=');
    expect(deps.calls.some(([command]) => command === 'chown')).toBe(false);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('ignored'));
  });

  it('removes a stale password file when reinstalling without an explicit password', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ userSystemdUsable: true }), deps);
    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/home/ada/.harmonic', password: 'old secret' },
    });

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/home/ada/.harmonic' },
    });

    const unit = deps.files.get('/home/ada/.config/systemd/user/harmonic.service')!;
    expect(unit).not.toContain('EnvironmentFile=');
    expect(unit).not.toContain('old secret');
    expect(deps.files.has('/home/ada/.config/systemd/user/harmonic.env')).toBe(false);
  });

  it('quotes unit arguments so paths and telemetry values cannot change the command', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/var/lib/harmonic data', otelHeaders: 'token=a b' },
    });

    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('--data-dir "/var/lib/harmonic data" --otel-headers "token=a b"');
  });

  it('delegates lifecycle commands and removes only service files on uninstall', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ userSystemdUsable: true }), deps);
    await manager.install({ startSelfManaged: vi.fn(), serve: { port: '4700', host: '0.0.0.0', dataDir: '/home/ada/.harmonic' } });
    deps.calls.length = 0;

    await manager.start();
    await manager.stop();
    await manager.restart();
    await manager.uninstall();

    expect(deps.calls).toEqual([
      ['systemctl', '--user', 'start', 'harmonic'],
      ['systemctl', '--user', 'stop', 'harmonic'],
      ['systemctl', '--user', 'restart', 'harmonic'],
      ['systemctl', '--user', 'stop', 'harmonic'],
      ['systemctl', '--user', 'disable', 'harmonic'],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    expect(deps.files.has('/home/ada/.config/systemd/user/harmonic.service')).toBe(false);
    expect(deps.files.has('/home/ada/.harmonic')).toBe(false);
  });
});

describe('init.d script (real filesystem)', () => {
  const cleanup: string[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('passes `sh -n`, runs the boot guard, then starts app/current/dist/cli.js through a stubbed runuser', () => {
    const dataDir = tempDir('harmonic-initd-real-datadir-');
    const cliDir = join(dataDir, 'app', 'current', 'dist');
    mkdirSync(cliDir, { recursive: true });
    const markerPath = join(dataDir, 'started.marker');
    writeFileSync(
      join(cliDir, 'cli.js'),
      `if (process.argv[2] === 'status') process.exit(1);\n` +
        `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join(' '));\n`,
    );
    const guardMarkerPath = join(dataDir, 'guard.marker');
    writeFileSync(
      join(dataDir, 'app', 'boot-guard.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(guardMarkerPath)}, process.argv.slice(2).join(' '));\n`,
    );

    const script = initdScript({ dataDir, user: 'agent', nodePath: process.execPath });
    const scriptDir = tempDir('harmonic-initd-real-script-');
    const scriptPath = join(scriptDir, 'harmonic');
    writeFileSync(scriptPath, script);
    chmodSync(scriptPath, 0o755);

    execFileSync('sh', ['-n', scriptPath]);

    // Stubs `id -u` (report root) and `runuser -u <user> -- <cmd...>` (drop the user switch and
    // just exec the command) so the script's real logic runs unprivileged in the test sandbox.
    const stubDir = tempDir('harmonic-initd-real-stub-');
    writeFileSync(join(stubDir, 'id'), '#!/bin/sh\necho 0\n');
    writeFileSync(join(stubDir, 'runuser'), '#!/bin/sh\nshift 3\nexec "$@"\n');
    chmodSync(join(stubDir, 'id'), 0o755);
    chmodSync(join(stubDir, 'runuser'), 0o755);

    execFileSync('sh', [scriptPath, 'start'], { env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` } });

    expect(readFileSync(guardMarkerPath, 'utf8')).toBe(dataDir);
    expect(readFileSync(markerPath, 'utf8')).toBe(`start --data-dir ${dataDir}`);
  });
});
