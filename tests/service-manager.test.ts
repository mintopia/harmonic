import { describe, expect, it, vi } from 'vitest';
import {
  UnsupportedServicePlatformError,
  createServiceManager,
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
    cliPath: '/opt/harmonic/dist/cli.js',
    nodePath: '/usr/bin/node',
    homeDir: '/home/agent',
    userName: 'agent',
    sudoUser: 'agent',
    run: async (command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      return { stdout: '' };
    },
    mkdir: async (path: string) => { dirs.push(path); },
    writeFile: async (path: string, contents: string) => { files.set(path, contents); },
    chmod: async (path: string, mode: number) => { modes.set(path, mode); },
    removeFile: async (path: string) => { files.delete(path); },
    fileExists: (path: string) => files.has(path),
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
    expect(script).toContain('### BEGIN INIT INFO');
    expect(script).toContain('if [ "$(id -u)" -ne 0 ]');
    expect(script).toContain('HARMONIC_INITD_SERVICE=1 runuser -u agent -- harmonic start --data-dir /srv/harmonic');
    expect(script).toContain('HARMONIC_INITD_SERVICE=1 runuser -u agent -- harmonic stop --data-dir /srv/harmonic');
    expect(script).toContain('HARMONIC_INITD_SERVICE=1 runuser -u agent -- harmonic status --data-dir /srv/harmonic');
    expect(script).toContain('restart|force-reload)');
    expect(initd.modes.get('/etc/init.d/harmonic')).toBe(0o755);
    expect(initd.dirs).toContain('/srv/harmonic');
    expect(initd.calls).toEqual([
      ['chown', 'agent', '/srv/harmonic'],
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

  it('warns when init.d would run Harmonic as root', async () => {
    const initd = initdDependencies();
    const manager = createServiceManager(environment({ isRoot: true, initdAvailable: true }), initd.dependencies);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/srv/harmonic' },
      user: 'root',
    });

    expect(initd.warn).toHaveBeenCalledWith(expect.stringContaining('root'));
    expect(initd.files.get('/etc/init.d/harmonic')).toContain('runuser -u root -- harmonic start');
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
      cliPath: '/opt/harmonic/dist/cli.js',
      nodePath: '/usr/bin/node',
      homeDir: '/home/ada',
      userName: 'ada',
      run: async (command, args) => {
        calls.push([command, ...args]);
        return { stdout: 'active\n' };
      },
      mkdir: async (path) => { dirs.push(path); },
      writeFile: async (path, contents) => { files.set(path, contents); },
      chmod: async (path, mode) => { modes.set(path, mode); },
      removeFile: async (path) => { files.delete(path); },
      fileExists: (path) => files.has(path),
    };
  };

  it('installs a root system unit with absolute executable paths and no password file', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ isRoot: true, systemdRunning: true }), deps);

    await expect(manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4711', host: '127.0.0.1', dataDir: '/var/lib/harmonic', otelEndpoint: 'http://otel' },
    })).resolves.toMatchObject({ backend: 'systemd', status: { running: true } });

    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('ExecStart=/usr/bin/node /opt/harmonic/dist/cli.js serve --port 4711 --host 127.0.0.1 --data-dir /var/lib/harmonic --otel-endpoint http://otel');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('WorkingDirectory=/var/lib/harmonic');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('Restart=always');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('TimeoutStopSec=60');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('Environment=HARMONIC_MANAGED_BY=systemd');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).not.toContain('EnvironmentFile=');
    expect(deps.files.has('/etc/systemd/system/harmonic.env')).toBe(false);
    expect(deps.dirs).toContain('/var/lib/harmonic');
    expect(deps.calls).toEqual([
      ['chown', 'workspace', '/var/lib/harmonic'],
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', 'harmonic'],
      ['systemctl', 'start', 'harmonic'],
      ['systemctl', 'is-active', 'harmonic'],
    ]);
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
    expect(deps.files.get('/home/ada/.config/systemd/user/harmonic.env')).toBe('HARMONIC_PASSWORD="secret value"\n');
    expect(deps.modes.get('/home/ada/.config/systemd/user/harmonic.env')).toBe(0o600);
    expect(deps.dirs).toContain('/home/ada/.harmonic');
    expect(deps.calls).toEqual([
      ['loginctl', 'enable-linger', 'ada'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'harmonic'],
      ['systemctl', '--user', 'start', 'harmonic'],
      ['systemctl', '--user', 'is-active', 'harmonic'],
    ]);
  });

  it('creates the data directory without chowning it for a user-level unit, since it already runs as the invoking user', async () => {
    const deps = dependencies();
    const manager = createServiceManager(environment({ userSystemdUsable: true }), deps);

    await manager.install({
      startSelfManaged: vi.fn(),
      serve: { port: '4700', host: '0.0.0.0', dataDir: '/home/ada/.harmonic' },
    });

    expect(deps.dirs).toContain('/home/ada/.harmonic');
    expect(deps.calls.some((call) => call[0] === 'chown')).toBe(false);
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
