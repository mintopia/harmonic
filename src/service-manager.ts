import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ServiceBackend = 'systemd' | 'init.d' | 'user-systemd' | 'self-managed';

export interface ServiceEnvironment {
  platform: NodeJS.Platform;
  isRoot: boolean;
  systemdRunning: boolean;
  initdAvailable: boolean;
  userSystemdUsable: boolean;
}

export interface ServiceInstallOptions {
  startSelfManaged: () => Promise<void>;
  bootCommand?: string;
  serve?: ServiceServeOptions;
  user?: string;
}

export interface ServiceServeOptions {
  port: string;
  host: string;
  dataDir: string;
  password?: string;
  otelEndpoint?: string;
  otelHeaders?: string;
  otelExport?: string;
  otelMetricExportInterval?: string;
  otelStdoutLogLevel?: string;
}

export interface ServiceInstallResult {
  backend: ServiceBackend;
  bootCommand?: string;
  status?: ServiceStatus;
}

export interface ServiceStatus {
  running: boolean;
  detail?: string;
}

export interface ServiceManager {
  readonly backend: ServiceBackend;
  install(options: ServiceInstallOptions): Promise<ServiceInstallResult>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
  isInstalled(): Promise<boolean>;
}

interface CommandResult {
  stdout: string;
}

export interface ServiceManagerDependencies {
  nodePath: string;
  cliPath: string;
  homeDir: string;
  userName: string;
  run(command: string, args: readonly string[]): Promise<CommandResult>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  removeFile(path: string): Promise<void>;
  fileExists(path: string): boolean;
  sudoUser?: string;
  warn?(message: string): void;
}

const defaultDependencies = (): ServiceManagerDependencies => ({
  nodePath: process.execPath,
  cliPath: resolve(process.argv[1] ?? fileURLToPath(new URL('./cli.js', import.meta.url))),
  homeDir: homedir(),
  userName: userInfo().username,
  run: async (command, args) => {
    const { stdout } = await execFileAsync(command, [...args]);
    return { stdout };
  },
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  writeFile: async (path, contents) => { await writeFile(path, contents, 'utf8'); },
  chmod,
  removeFile: async (path) => { await rm(path, { force: true }); },
  fileExists: existsSync,
  ...(process.env.SUDO_USER === undefined ? {} : { sudoUser: process.env.SUDO_USER }),
});

export function resolveServiceUser({ user, sudoUser }: { user?: string | undefined; sudoUser?: string | undefined }): string {
  return user || sudoUser || 'workspace';
}

const warn = (dependencies: ServiceManagerDependencies, message: string): void => {
  if (dependencies.warn) dependencies.warn(message);
  else process.emitWarning(message);
};

const systemdServiceUser = (user: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(user)) throw new Error(`Invalid systemd service user: ${user}`);
  return user;
};

const escapeUnitArgument = (value: string): string =>
  /^[A-Za-z0-9_./:=+@%,-]+$/.test(value) ? value : JSON.stringify(value);

const environmentFileValue = (value: string): string => JSON.stringify(value);

const initdScriptPath = '/etc/init.d/harmonic';

const shellWord = (value: string): string => /^[A-Za-z0-9_./:-]+$/.test(value)
  ? value
  : `'${value.replaceAll("'", "'\"'\"'")}'`;

const initdScript = ({ dataDir, user }: { dataDir: string; user: string }): string => `#!/bin/sh
### BEGIN INIT INFO
# Provides:          harmonic
# Required-Start:    $network
# Required-Stop:     $network
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: Harmonic autonomous task service
### END INIT INFO

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root." >&2
  exit 1
fi

case "$1" in
  start)
    HARMONIC_INITD_SERVICE=1 runuser -u ${shellWord(user)} -- harmonic start --data-dir ${shellWord(dataDir)}
    ;;
  stop)
    HARMONIC_INITD_SERVICE=1 runuser -u ${shellWord(user)} -- harmonic stop --data-dir ${shellWord(dataDir)}
    ;;
  status)
    HARMONIC_INITD_SERVICE=1 runuser -u ${shellWord(user)} -- harmonic status --data-dir ${shellWord(dataDir)}
    ;;
  restart|force-reload)
    "$0" stop
    "$0" start
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|force-reload|status}" >&2
    exit 2
    ;;
esac
`;

class SystemdServiceManager implements ServiceManager {
  readonly backend: 'systemd' | 'user-systemd';
  private readonly userUnit: boolean;
  private readonly unitDirectory: string;
  private readonly unitPath: string;
  private readonly environmentPath: string;

  constructor(backend: 'systemd' | 'user-systemd', private readonly dependencies: ServiceManagerDependencies) {
    this.backend = backend;
    this.userUnit = backend === 'user-systemd';
    this.unitDirectory = this.userUnit ? join(dependencies.homeDir, '.config', 'systemd', 'user') : '/etc/systemd/system';
    this.unitPath = join(this.unitDirectory, 'harmonic.service');
    this.environmentPath = join(this.unitDirectory, 'harmonic.env');
  }

  private systemctlArgs(...args: string[]): string[] {
    return this.userUnit ? ['--user', ...args] : args;
  }

  private async systemctl(...args: string[]): Promise<CommandResult> {
    return this.dependencies.run('systemctl', this.systemctlArgs(...args));
  }

  private unit(serve: ServiceServeOptions, user?: string): string {
    const args = [
      this.dependencies.nodePath,
      this.dependencies.cliPath,
      'serve',
      '--port', serve.port,
      '--host', serve.host,
      '--data-dir', serve.dataDir,
      ...(serve.otelEndpoint === undefined ? [] : ['--otel-endpoint', serve.otelEndpoint]),
      ...(serve.otelHeaders === undefined ? [] : ['--otel-headers', serve.otelHeaders]),
      ...(serve.otelExport === undefined ? [] : ['--otel-export', serve.otelExport]),
      ...(serve.otelMetricExportInterval === undefined ? [] : ['--otel-metric-export-interval', serve.otelMetricExportInterval]),
      ...(serve.otelStdoutLogLevel === undefined ? [] : ['--otel-stdout-log-level', serve.otelStdoutLogLevel]),
    ].map(escapeUnitArgument).join(' ');
    const environmentFile = serve.password === undefined ? '' : `EnvironmentFile=${escapeUnitArgument(this.environmentPath)}\n`;
    const serviceUser = user === undefined ? '' : `User=${user}\nGroup=${user}\n`;
    const wantedBy = this.userUnit ? 'default.target' : 'multi-user.target';
    const workingDirectory = `WorkingDirectory=${escapeUnitArgument(serve.dataDir)}\n`;
    return `[Unit]\nDescription=Harmonic\nAfter=network.target\n\n[Service]\nType=simple\n${serviceUser}${workingDirectory}ExecStart=${args}\n${environmentFile}Environment=HARMONIC_MANAGED_BY=systemd\nRestart=always\nTimeoutStopSec=60\n\n[Install]\nWantedBy=${wantedBy}\n`;
  }

  async install(options: ServiceInstallOptions): Promise<ServiceInstallResult> {
    if (!options.serve) throw new Error('Systemd installation requires serve options.');
    const user = this.userUnit ? undefined : systemdServiceUser(resolveServiceUser({ user: options.user, sudoUser: this.dependencies.sudoUser }));
    if (user === 'root') warn(this.dependencies, 'Harmonic will run as root. Pass --user to run it as a non-root user.');
    if (this.userUnit && options.user !== undefined) warn(this.dependencies, '--user is ignored for user-level systemd.');
    if (this.userUnit) await this.dependencies.run('loginctl', ['enable-linger', this.dependencies.userName]);
    await this.dependencies.mkdir(this.unitDirectory);
    if (options.serve.password === undefined) {
      await this.dependencies.removeFile(this.environmentPath);
    } else {
      await this.dependencies.writeFile(this.environmentPath, `HARMONIC_PASSWORD=${environmentFileValue(options.serve.password)}\n`);
      await this.dependencies.chmod(this.environmentPath, 0o600);
    }
    await this.dependencies.writeFile(this.unitPath, this.unit(options.serve, user));
    await this.dependencies.chmod(this.unitPath, 0o644);
    await this.systemctl('daemon-reload');
    await this.systemctl('enable', 'harmonic');
    await this.systemctl('start', 'harmonic');
    return { backend: this.backend, status: await this.status() };
  }

  async uninstall(): Promise<void> {
    await this.systemctl('stop', 'harmonic');
    await this.systemctl('disable', 'harmonic');
    await this.dependencies.removeFile(this.unitPath);
    await this.dependencies.removeFile(this.environmentPath);
    await this.systemctl('daemon-reload');
  }

  async start(): Promise<void> { await this.systemctl('start', 'harmonic'); }

  async stop(): Promise<void> { await this.systemctl('stop', 'harmonic'); }

  async restart(): Promise<void> { await this.systemctl('restart', 'harmonic'); }

  async status(): Promise<ServiceStatus> {
    try {
      const { stdout } = await this.systemctl('is-active', 'harmonic');
      const detail = stdout.trim();
      return { running: detail === 'active', ...(detail === '' ? {} : { detail }) };
    } catch {
      return { running: false, detail: 'inactive' };
    }
  }

  async isInstalled(): Promise<boolean> { return this.dependencies.fileExists(this.unitPath); }
}

class InitdServiceManager implements ServiceManager {
  readonly backend = 'init.d' as const;

  constructor(private readonly dependencies: ServiceManagerDependencies) {}

  async install(options: ServiceInstallOptions): Promise<ServiceInstallResult> {
    if (!options.serve) throw new Error('init.d installation requires serve options.');
    const user = resolveServiceUser({ user: options.user, sudoUser: this.dependencies.sudoUser });
    if (user === 'root') {
      warn(this.dependencies, 'Harmonic will run as root. Pass --user to run it as a non-root user.');
    }
    await this.dependencies.writeFile(initdScriptPath, initdScript({ dataDir: options.serve.dataDir, user }));
    await this.dependencies.chmod(initdScriptPath, 0o755);
    await this.dependencies.run('update-rc.d', ['harmonic', 'defaults']);
    await this.start();
    return { backend: this.backend };
  }

  async uninstall(): Promise<void> {
    await this.stop();
    await this.dependencies.run('update-rc.d', ['-f', 'harmonic', 'remove']);
    await this.dependencies.removeFile(initdScriptPath);
  }

  async start(): Promise<void> { await this.dependencies.run('service', ['harmonic', 'start']); }

  async stop(): Promise<void> { await this.dependencies.run('service', ['harmonic', 'stop']); }

  async restart(): Promise<void> { await this.dependencies.run('service', ['harmonic', 'restart']); }

  async status(): Promise<ServiceStatus> {
    try {
      await this.dependencies.run('service', ['harmonic', 'status']);
      return { running: true };
    } catch {
      return { running: false };
    }
  }

  async isInstalled(): Promise<boolean> { return this.dependencies.fileExists(initdScriptPath); }
}

export class UnsupportedServicePlatformError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(`Service installation is unsupported on ${platform}: only systemd/init.d supported.`);
    this.name = 'UnsupportedServicePlatformError';
  }
}

class SelfManagedServiceManager implements ServiceManager {
  readonly backend = 'self-managed' as const;

  async install({ startSelfManaged, bootCommand }: ServiceInstallOptions): Promise<ServiceInstallResult> {
    await startSelfManaged();
    return { backend: this.backend, ...(bootCommand === undefined ? {} : { bootCommand }) };
  }

  async uninstall(): Promise<void> {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async restart(): Promise<void> {}

  async status(): Promise<ServiceStatus> {
    return { running: false };
  }

  async isInstalled(): Promise<boolean> {
    return false;
  }
}

export function createServiceManager(
  environment: ServiceEnvironment,
  dependencies: ServiceManagerDependencies = defaultDependencies(),
): ServiceManager {
  if (environment.platform !== 'linux') throw new UnsupportedServicePlatformError(environment.platform);
  if (environment.isRoot && environment.systemdRunning) return new SystemdServiceManager('systemd', dependencies);
  if (environment.isRoot && environment.initdAvailable) return new InitdServiceManager(dependencies);
  if (environment.userSystemdUsable) return new SystemdServiceManager('user-systemd', dependencies);
  return new SelfManagedServiceManager();
}
