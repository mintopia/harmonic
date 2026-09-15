import { describe, expect, it, vi } from 'vitest';
import {
  UnsupportedServicePlatformError,
  createServiceManager,
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

  it('reports that init.d installation is not yet available', async () => {
    await expect(createServiceManager(environment({ isRoot: true, initdAvailable: true })).install({ startSelfManaged: vi.fn() }))
      .rejects.toThrow('not yet available');
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
  const dependencies = (): ServiceManagerDependencies & { calls: string[][]; files: Map<string, string>; modes: Map<string, number> } => {
    const calls: string[][] = [];
    const files = new Map<string, string>();
    const modes = new Map<string, number>();
    return {
      calls,
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
      mkdir: async () => {},
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
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('Restart=always');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('TimeoutStopSec=60');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).toContain('Environment=HARMONIC_MANAGED_BY=systemd');
    expect(deps.files.get('/etc/systemd/system/harmonic.service')).not.toContain('EnvironmentFile=');
    expect(deps.files.has('/etc/systemd/system/harmonic.env')).toBe(false);
    expect(deps.calls).toEqual([
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', 'harmonic'],
      ['systemctl', 'start', 'harmonic'],
      ['systemctl', 'is-active', 'harmonic'],
    ]);
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
    expect(deps.calls).toEqual([
      ['loginctl', 'enable-linger', 'ada'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'harmonic'],
      ['systemctl', '--user', 'start', 'harmonic'],
      ['systemctl', '--user', 'is-active', 'harmonic'],
    ]);
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
