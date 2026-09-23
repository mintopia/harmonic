import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile, chmod, rm, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELP, runCliCommand, type CliCommandDependencies } from '../src/cli-commands.js';
import { dispatchCli, type ServeValues } from '../src/cli-dispatch.js';
import type { DaemonInfo } from '../src/daemon.js';
import {
  createServiceManager,
  UnsupportedServicePlatformError,
  type ServiceManager,
  type ServiceManagerDependencies,
} from '../src/service-manager.js';

type LogEntry = { level: 'info' | 'warn' | 'error'; message: string };

function fakeServiceManager(overrides: Partial<ServiceManager> = {}): ServiceManager {
  return {
    backend: 'systemd',
    install: vi.fn(async () => ({ backend: 'systemd' as const })),
    uninstall: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    status: vi.fn(async () => ({ running: true })),
    isInstalled: vi.fn(async () => true),
    readExistingSettings: vi.fn(async () => null),
    ...overrides,
  };
}

function fakeDependencies() {
  const trace: string[] = [];
  const logs: LogEntry[] = [];
  const writes: string[] = [];
  const daemonTable = new Map<string, DaemonInfo>();
  const spawnCalls: { dataDir: string; args: string[] }[] = [];
  const waits: number[] = [];
  let nextPid = 1000;

  const deps: CliCommandDependencies = {
    defaultDataDir: () => '/default/data',
    serviceManager: () => {
      throw new Error('serviceManager() not stubbed for this test');
    },
    installedServiceManager: () => null,
    daemon: {
      daemonStatus: (dataDir) => {
        trace.push(`daemonStatus:${dataDir}`);
        const info = daemonTable.get(dataDir) ?? null;
        return { running: info !== null, info };
      },
      stopDaemon: async (dataDir) => {
        trace.push(`stopDaemon:${dataDir}`);
        const existed = daemonTable.has(dataDir);
        daemonTable.delete(dataDir);
        return existed;
      },
      writeDaemon: (dataDir, info) => {
        trace.push(`writeDaemon:${dataDir}`);
        daemonTable.set(dataDir, info);
      },
      logFilePath: (dataDir) => `${dataDir}/harmonic.log`,
    },
    spawnServe: ({ dataDir, args }) => {
      trace.push(`spawnServe:${dataDir}`);
      spawnCalls.push({ dataDir, args });
      return nextPid++;
    },
    wait: async (milliseconds) => {
      trace.push(`wait:${milliseconds}`);
      waits.push(milliseconds);
    },
    version: () => '1.2.3',
    write: (text) => {
      writes.push(text);
    },
    log: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
    runServer: async () => {
      throw new Error('runServer() not stubbed for this test');
    },
  };

  return { deps, trace, logs, writes, daemonTable, spawnCalls, waits };
}

const serveValues = (overrides: Partial<ServeValues> = {}): ServeValues => ({
  port: '4700',
  host: '0.0.0.0',
  ...overrides,
});

describe('runCliCommand: version', () => {
  it('writes exactly the version plus a newline and continues', async () => {
    const { deps, writes } = fakeDependencies();
    const outcome = await runCliCommand({ kind: 'version' }, [], deps);
    expect(writes).toEqual(['1.2.3\n']);
    expect(outcome).toEqual({ kind: 'continue' });
  });
});

describe('runCliCommand: help', () => {
  it('exit code 0 writes HELP and returns exit 0 (not continue)', async () => {
    const { deps, writes } = fakeDependencies();
    const outcome = await runCliCommand({ kind: 'help', exitCode: 0 }, [], deps);
    expect(writes).toEqual([HELP]);
    expect(outcome).toEqual({ kind: 'exit', code: 0 });
  });

  it('exit code 1 writes the same HELP text and returns exit 1', async () => {
    const { deps, writes } = fakeDependencies();
    const outcome = await runCliCommand({ kind: 'help', exitCode: 1 }, [], deps);
    expect(writes).toEqual([HELP]);
    expect(outcome).toEqual({ kind: 'exit', code: 1 });
  });
});

describe('runCliCommand: uninstall', () => {
  it('calls serviceManager().uninstall(), not installedServiceManager(), and logs', async () => {
    const { deps, logs } = fakeDependencies();
    const manager = fakeServiceManager();
    deps.serviceManager = () => manager;
    deps.installedServiceManager = () => {
      throw new Error('installedServiceManager() should not be used by uninstall');
    };

    const outcome = await runCliCommand({ kind: 'uninstall', dataDir: undefined }, [], deps);

    expect(manager.uninstall).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([{ level: 'info', message: 'Service uninstalled.' }]);
    expect(outcome).toEqual({ kind: 'continue' });
  });
});

describe('runCliCommand: status', () => {
  it('installed service running without detail logs "Running."', async () => {
    const { deps, logs } = fakeDependencies();
    const manager = fakeServiceManager({ status: vi.fn(async () => ({ running: true })) });
    deps.installedServiceManager = () => manager;

    const outcome = await runCliCommand({ kind: 'status', dataDir: '/d' }, [], deps);

    expect(logs).toEqual([{ level: 'info', message: 'Running.' }]);
    expect(outcome).toEqual({ kind: 'continue' });
  });

  it('installed service running with detail logs the detail string verbatim', async () => {
    const { deps, logs } = fakeDependencies();
    const manager = fakeServiceManager({ status: vi.fn(async () => ({ running: true, detail: 'active' })) });
    deps.installedServiceManager = () => manager;

    await runCliCommand({ kind: 'status', dataDir: '/d' }, [], deps);

    expect(logs).toEqual([{ level: 'info', message: 'active' }]);
  });

  it('installed service not running returns exit 1', async () => {
    const { deps, logs } = fakeDependencies();
    const manager = fakeServiceManager({ status: vi.fn(async () => ({ running: false, detail: 'inactive' })) });
    deps.installedServiceManager = () => manager;

    const outcome = await runCliCommand({ kind: 'status', dataDir: '/d' }, [], deps);

    expect(logs).toEqual([{ level: 'info', message: 'inactive' }]);
    expect(outcome).toEqual({ kind: 'exit', code: 1 });
  });

  it('no installed service, daemon alive: logs full running string, 0.0.0.0 renders as localhost', async () => {
    const { deps, logs, daemonTable } = fakeDependencies();
    const startedAt = Date.now() - 60_000;
    daemonTable.set('/d', { pid: 42, port: 4700, host: '0.0.0.0', startedAt });

    const outcome = await runCliCommand({ kind: 'status', dataDir: '/d' }, [], deps);

    expect(logs).toEqual([
      {
        level: 'info',
        message:
          `Running (pid 42) — http://localhost:4700, up since ${new Date(startedAt).toLocaleString()}\n` +
          'Logs: /d/harmonic.log',
      },
    ]);
    expect(outcome).toEqual({ kind: 'continue' });
  });

  it('no installed service, no daemon: logs "Not running." and returns exit 1', async () => {
    const { deps, logs } = fakeDependencies();

    const outcome = await runCliCommand({ kind: 'status', dataDir: '/d' }, [], deps);

    expect(logs).toEqual([{ level: 'info', message: 'Not running.' }]);
    expect(outcome).toEqual({ kind: 'exit', code: 1 });
  });
});

describe('runCliCommand: stop', () => {
  it('installed service path stops it and logs "Stopped."', async () => {
    const { deps, logs } = fakeDependencies();
    const manager = fakeServiceManager();
    deps.installedServiceManager = () => manager;

    const outcome = await runCliCommand({ kind: 'stop', dataDir: '/d' }, [], deps);

    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([{ level: 'info', message: 'Stopped.' }]);
    expect(outcome).toEqual({ kind: 'continue' });
  });

  it('daemon path logs "Stopped." when a daemon was running', async () => {
    const { deps, logs, daemonTable } = fakeDependencies();
    daemonTable.set('/d', { pid: 1, port: 4700, host: '0.0.0.0', startedAt: Date.now() });

    const outcome = await runCliCommand({ kind: 'stop', dataDir: '/d' }, [], deps);

    expect(logs).toEqual([{ level: 'info', message: 'Stopped.' }]);
    expect(outcome).toEqual({ kind: 'continue' });
  });

  it('daemon path logs "Not running." when nothing was running', async () => {
    const { deps, logs } = fakeDependencies();

    const outcome = await runCliCommand({ kind: 'stop', dataDir: '/d' }, [], deps);

    expect(logs).toEqual([{ level: 'info', message: 'Not running.' }]);
    expect(outcome).toEqual({ kind: 'continue' });
  });
});

describe('runCliCommand: dataDir resolution', () => {
  it('uses defaultDataDir() when dispatch.dataDir is undefined', async () => {
    const { deps, logs } = fakeDependencies();

    await runCliCommand({ kind: 'stop', dataDir: undefined }, [], deps);

    expect(logs).toEqual([{ level: 'info', message: 'Not running.' }]);
  });

  it('flows an explicit dataDir through to the daemon ops', async () => {
    const { deps, trace } = fakeDependencies();

    await runCliCommand({ kind: 'stop', dataDir: '/explicit' }, [], deps);

    expect(trace).toEqual(['stopDaemon:/explicit']);
  });
});

describe('runCliCommand: restart', () => {
  it('installed-service path restarts and logs "Restarted."', async () => {
    const { deps, logs } = fakeDependencies();
    const manager = fakeServiceManager();
    deps.installedServiceManager = () => manager;

    const outcome = await runCliCommand({ kind: 'restart', dataDir: '/d' }, [], deps);

    expect(manager.restart).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([{ level: 'info', message: 'Restarted.' }]);
    expect(outcome).toEqual({ kind: 'continue' });
  });

  it('standalone path stops the daemon then spawns serve with args===["--data-dir", dataDir], in order', async () => {
    const { deps, trace, spawnCalls } = fakeDependencies();

    await runCliCommand({ kind: 'restart', dataDir: '/d' }, [], deps);

    expect(spawnCalls).toEqual([{ dataDir: '/d', args: ['--data-dir', '/d'] }]);
    expect(trace).toEqual([
      'stopDaemon:/d',
      'daemonStatus:/d',
      'spawnServe:/d',
      'writeDaemon:/d',
      'wait:1500',
      'daemonStatus:/d',
    ]);
  });

  it('off-linux: serviceManager() throw escapes runCliCommand un-swallowed', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const { deps } = fakeDependencies();
      deps.serviceManager = () => {
        throw new UnsupportedServicePlatformError('darwin');
      };

      await expect(runCliCommand({ kind: 'restart', dataDir: '/d' }, [], deps)).rejects.toThrow(
        UnsupportedServicePlatformError,
      );
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });
});

describe('runCliCommand: install', () => {
  it('passes only the defined serve/user keys, logs "Selected <backend>.", status, and boot hook', async () => {
    const { deps, logs } = fakeDependencies();
    let captured: Parameters<ServiceManager['install']>[0] | undefined;
    const manager = fakeServiceManager({
      install: vi.fn(async (options) => {
        captured = options;
        return {
          backend: 'systemd' as const,
          status: { running: true, detail: 'active' },
          bootCommand: 'harmonic start --data-dir /d',
        };
      }),
    });
    deps.serviceManager = () => manager;

    const values = serveValues({ 'data-dir': '/d', password: 'secret' });
    const rest = ['--data-dir', '/d', '--password', 'secret'];

    const outcome = await runCliCommand({ kind: 'install', values }, rest, deps);

    expect(captured?.serve).toEqual({ port: '4700', host: '0.0.0.0', dataDir: '/d', password: 'secret' });
    expect(Object.prototype.hasOwnProperty.call(captured ?? {}, 'user')).toBe(false);
    expect(captured?.bootCommand).toBe('harmonic start --data-dir /d');
    expect(logs).toEqual([
      { level: 'info', message: 'Selected systemd.' },
      { level: 'info', message: 'active' },
      { level: 'info', message: 'Add this to the host boot hook: harmonic start --data-dir /d' },
    ]);
    expect(outcome).toEqual({ kind: 'continue' });
  });

  it('includes user and otel keys only when defined, and falls back to defaultDataDir()', async () => {
    const { deps } = fakeDependencies();
    let captured: Parameters<ServiceManager['install']>[0] | undefined;
    const manager = fakeServiceManager({
      install: vi.fn(async (options) => {
        captured = options;
        return { backend: 'systemd' as const };
      }),
    });
    deps.serviceManager = () => manager;

    const values = serveValues({
      user: 'operator',
      'otel-endpoint': 'http://collector:4318',
      'otel-export': 'true',
    });

    await runCliCommand({ kind: 'install', values }, [], deps);

    expect(captured?.user).toBe('operator');
    expect(captured?.serve).toEqual({
      port: '4700',
      host: '0.0.0.0',
      dataDir: '/default/data',
      otelEndpoint: 'http://collector:4318',
      otelExport: 'true',
    });
  });

  it('self-managed start failure: runCliCommand returns exit 1 and never logs the boot hook line', async () => {
    const { deps, logs, daemonTable } = fakeDependencies();
    daemonTable.set('/default/data', { pid: 1, port: 4700, host: '0.0.0.0', startedAt: Date.now() });
    const manager = fakeServiceManager({
      install: vi.fn(async (options) => {
        await options.startSelfManaged();
        return { backend: 'self-managed' as const, bootCommand: 'harmonic start' };
      }),
    });
    deps.serviceManager = () => manager;

    const outcome = await runCliCommand({ kind: 'install', values: serveValues() }, [], deps);

    expect(outcome).toEqual({ kind: 'exit', code: 1 });
    expect(logs.some((entry) => entry.message.includes('Add this to the host boot hook'))).toBe(false);
  });
});

describe('runCliCommand: start', () => {
  it('installed-service path starts it and logs "Started."', async () => {
    const { deps, logs } = fakeDependencies();
    const manager = fakeServiceManager();
    deps.installedServiceManager = () => manager;

    const outcome = await runCliCommand({ kind: 'start', values: serveValues() }, [], deps);

    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([{ level: 'info', message: 'Started.' }]);
    expect(outcome).toEqual({ kind: 'continue' });
  });

  it('standalone happy path: spawnServe -> writeDaemon -> wait(1500) -> daemonStatus, full success message', async () => {
    const { deps, trace, logs, spawnCalls } = fakeDependencies();

    const outcome = await runCliCommand({ kind: 'start', values: serveValues({ 'data-dir': '/d' }) }, ['--foo'], deps);

    expect(spawnCalls).toEqual([{ dataDir: '/d', args: ['--foo'] }]);
    expect(trace).toEqual(['daemonStatus:/d', 'spawnServe:/d', 'writeDaemon:/d', 'wait:1500', 'daemonStatus:/d']);
    expect(logs).toEqual([
      {
        level: 'info',
        message: 'Harmonic running in the background (pid 1000) — http://localhost:4700\nLogs: /d/harmonic.log\nStop with: harmonic stop',
      },
    ]);
    expect(outcome).toEqual({ kind: 'continue' });
  });

  it('daemon already running: exit 1, nothing spawned', async () => {
    const { deps, logs, spawnCalls, daemonTable } = fakeDependencies();
    daemonTable.set('/d', { pid: 7, port: 4700, host: '0.0.0.0', startedAt: Date.now() });

    const outcome = await runCliCommand({ kind: 'start', values: serveValues({ 'data-dir': '/d' }) }, [], deps);

    expect(spawnCalls).toEqual([]);
    expect(logs).toEqual([
      { level: 'error', message: 'Already running (pid 7) — http://localhost:4700. `harmonic stop` first.' },
    ]);
    expect(outcome).toEqual({ kind: 'exit', code: 1 });
  });

  it('daemon dies during wait: logs failure, stops the daemon, and returns exit 1', async () => {
    const { deps, logs, daemonTable } = fakeDependencies();
    deps.wait = async () => {
      daemonTable.delete('/d');
    };

    const outcome = await runCliCommand({ kind: 'start', values: serveValues({ 'data-dir': '/d' }) }, [], deps);

    expect(logs).toEqual([{ level: 'error', message: 'Failed to start — see /d/harmonic.log' }]);
    expect(outcome).toEqual({ kind: 'exit', code: 1 });
  });
});

describe('runCliCommand: serve', () => {
  it('delegates to the injected runServer(values, rest) and returns its outcome verbatim', async () => {
    const { deps } = fakeDependencies();
    const values = serveValues({ 'data-dir': '/d' });
    const rest = ['--data-dir', '/d'];
    deps.runServer = vi.fn(async (v, r) => {
      expect(v).toEqual(values);
      expect(r).toEqual(rest);
      return { kind: 'exit', code: 1 } as const;
    });

    const outcome = await runCliCommand({ kind: 'serve', values }, rest, deps);

    expect(deps.runServer).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'exit', code: 1 });
  });
});

describe('runCliCommand: install reinstall over a real existing systemd unit', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'harmonic-install-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('reuses the existing unit port/host/data-dir and keeps the password file when re-running install with no flags', async () => {
    const unitDir = join(home, '.config', 'systemd', 'user');
    const dataDir = join(home, 'srv', 'harmonic');
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      join(unitDir, 'harmonic.service'),
      [
        '[Unit]',
        'Description=Harmonic',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        `WorkingDirectory=${dataDir}`,
        `ExecStart=/usr/bin/node ${dataDir}/app/current/dist/cli.js serve --port 8080 --host 127.0.0.1 --data-dir ${dataDir}`,
        `EnvironmentFile=${join(unitDir, 'harmonic.env')}`,
        'Environment=HARMONIC_MANAGED_BY=systemd',
        'Restart=always',
        'TimeoutStopSec=60',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    );
    await writeFile(join(unitDir, 'harmonic.env'), 'HARMONIC_PASSWORD="hunter2"\n');

    const calls: string[][] = [];
    const dependencies: ServiceManagerDependencies = {
      nodePath: '/usr/bin/node',
      currentVersion: '2.16.0',
      path: '/usr/bin:/bin',
      homeDir: home,
      userName: 'tester',
      run: async (command, args) => {
        calls.push([command, ...args]);
        return { stdout: 'active\n' };
      },
      mkdir: async (p) => { await mkdir(p, { recursive: true }); },
      writeFile: async (p, c) => { await writeFile(p, c, 'utf8'); },
      chmod: async (p, m) => { await chmod(p, m); },
      removeFile: async (p) => { await rm(p, { recursive: true, force: true }); },
      rename: async (from, to) => { await rename(from, to); },
      fileExists: (p) => existsSync(p),
      readFile: (p) => readFileSync(p, 'utf8'),
      readTextFile: async (p) => {
        try {
          return await readFile(p, 'utf8');
        } catch {
          return null;
        }
      },
      readlink: (p) => {
        try {
          return readlinkSync(p);
        } catch {
          return null;
        }
      },
    };
    const manager = createServiceManager(
      { platform: 'linux', isRoot: false, systemdRunning: false, initdAvailable: false, userSystemdUsable: true },
      dependencies,
    );
    expect(manager.backend).toBe('user-systemd');

    const { deps } = fakeDependencies();
    deps.serviceManager = () => manager;
    deps.defaultDataDir = () => join(home, 'default');

    const dispatch = dispatchCli(['install']);
    expect(dispatch.kind).toBe('install');
    if (dispatch.kind !== 'install') throw new Error('expected install');

    await runCliCommand(dispatch, [], deps);

    const unitContents = await readFile(join(unitDir, 'harmonic.service'), 'utf8');
    expect(unitContents).toContain(`--port 8080 --host 127.0.0.1 --data-dir ${dataDir}`);
    expect(unitContents).not.toContain('--port 4700');

    const envContents = await readFile(join(unitDir, 'harmonic.env'), 'utf8');
    expect(envContents).toContain('hunter2');
  });

  function setUpManager(execStart: (dataDir: string) => string): { unitDir: string; unitPath: string; dataDir: string; deps: CliCommandDependencies } {
    const unitDir = join(home, '.config', 'systemd', 'user');
    const unitPath = join(unitDir, 'harmonic.service');
    const dataDir = join(home, 'srv', 'harmonic');
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      unitPath,
      ['[Unit]', 'Description=Harmonic', '', '[Service]', 'Type=simple', `ExecStart=${execStart(dataDir)}`, '', '[Install]', 'WantedBy=default.target', ''].join('\n'),
    );
    const dependencies: ServiceManagerDependencies = {
      nodePath: '/usr/bin/node',
      currentVersion: '2.16.0',
      path: '/usr/bin:/bin',
      homeDir: home,
      userName: 'tester',
      run: async () => ({ stdout: 'active\n' }),
      mkdir: async (p) => { await mkdir(p, { recursive: true }); },
      writeFile: async (p, c) => { await writeFile(p, c, 'utf8'); },
      chmod: async (p, m) => { await chmod(p, m); },
      removeFile: async (p) => { await rm(p, { recursive: true, force: true }); },
      rename: async (from, to) => { await rename(from, to); },
      fileExists: (p) => existsSync(p),
      readFile: (p) => readFileSync(p, 'utf8'),
      readTextFile: async (p) => {
        try {
          return await readFile(p, 'utf8');
        } catch {
          return null;
        }
      },
      readlink: (p) => {
        try {
          return readlinkSync(p);
        } catch {
          return null;
        }
      },
    };
    const manager = createServiceManager(
      { platform: 'linux', isRoot: false, systemdRunning: false, initdAvailable: false, userSystemdUsable: true },
      dependencies,
    );
    const { deps } = fakeDependencies();
    deps.serviceManager = () => manager;
    deps.defaultDataDir = () => join(home, 'default');
    return { unitDir, unitPath, dataDir, deps };
  }

  it('reuses an existing unit written in --flag=value form', async () => {
    const { unitDir, dataDir, deps } = setUpManager(
      (dataDir) => `/usr/bin/node ${dataDir}/app/current/dist/cli.js serve --port=8080 --host=127.0.0.1 --data-dir=${dataDir}`,
    );

    const dispatch = dispatchCli(['install']);
    if (dispatch.kind !== 'install') throw new Error('expected install');
    await runCliCommand(dispatch, [], deps);

    const unitContents = await readFile(join(unitDir, 'harmonic.service'), 'utf8');
    expect(unitContents).toContain(`--port 8080 --host 127.0.0.1 --data-dir ${dataDir}`);
  });

  it('refuses to reinstall when the existing unit has a token it cannot understand, and writes nothing', async () => {
    const { unitPath, dataDir, deps } = setUpManager(
      (dataDir) => `/usr/bin/node ${dataDir}/app/current/dist/cli.js serve --port 8080 --host 127.0.0.1 --data-dir ${dataDir} --unknown-flag surprise`,
    );
    const before = await readFile(unitPath, 'utf8');

    const dispatch = dispatchCli(['install']);
    if (dispatch.kind !== 'install') throw new Error('expected install');
    await expect(runCliCommand(dispatch, [], deps)).rejects.toThrow(/unrecognized ExecStart argument.*unknown-flag/);

    expect(await readFile(unitPath, 'utf8')).toBe(before);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('proceeds when explicit --port/--host/--data-dir override an unparseable existing unit', async () => {
    const { unitDir, dataDir, deps } = setUpManager(
      (dataDir) => `/usr/bin/node ${dataDir}/app/current/dist/cli.js serve --port 8080 --host 127.0.0.1 --data-dir ${dataDir} --unknown-flag surprise`,
    );
    const newDataDir = join(dataDir, '..', 'harmonic2');
    const rest = ['--port', '9000', '--host', '0.0.0.0', '--data-dir', newDataDir];

    const dispatch = dispatchCli(['install', ...rest]);
    if (dispatch.kind !== 'install') throw new Error('expected install');
    await runCliCommand(dispatch, rest, deps);

    const unitContents = await readFile(join(unitDir, 'harmonic.service'), 'utf8');
    expect(unitContents).toContain(`--port 9000 --host 0.0.0.0 --data-dir ${newDataDir}`);
  });
});
