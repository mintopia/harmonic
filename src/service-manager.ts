import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { installVersion } from './upgrade/version-install.js';

const execFileAsync = promisify(execFile);
const packageVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const packageManifest = z.object({ version: packageVersionSchema });
const packageVersion = (): string => {
  return packageManifest.parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))).version;
};

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

/** Settings recovered from a previously installed service, offered as install-time defaults. */
export interface ExistingServiceSettings {
  serve: {
    port: string;
    host: string;
    dataDir: string;
    otelEndpoint?: string | undefined;
    otelHeaders?: string | undefined;
    otelExport?: string | undefined;
    otelMetricExportInterval?: string | undefined;
    otelStdoutLogLevel?: string | undefined;
  };
  user?: string;
  password?: string;
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
  /** Best-effort recovery of the currently installed service's settings, for reuse on reinstall. */
  readExistingSettings(): Promise<ExistingServiceSettings | null>;
  /** Systemd-only self-heal for a pre-boot-guard unit (ADR-0042); absent on other backends. */
  ensureUnitRevisionCurrent?(): Promise<boolean>;
}

interface CommandResult {
  stdout: string;
}

export interface ServiceManagerDependencies {
  nodePath: string;
  currentVersion: string;
  path: string;
  homeDir: string;
  userName: string;
  run(command: string, args: readonly string[]): Promise<CommandResult>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  removeFile(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  fileExists(path: string): boolean;
  readFile(path: string, encoding: 'utf8'): string;
  /** Returns the file's contents, or null if it doesn't exist or can't be read. */
  readTextFile(path: string): Promise<string | null>;
  sudoUser?: string;
  warn?(message: string): void;
}

const defaultDependencies = (): ServiceManagerDependencies => ({
  nodePath: process.execPath,
  currentVersion: packageVersion(),
  path: process.env.PATH ?? '',
  homeDir: homedir(),
  userName: userInfo().username,
  run: async (command, args) => {
    const { stdout } = await execFileAsync(command, [...args]);
    return { stdout };
  },
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  writeFile: async (path, contents) => { await writeFile(path, contents, 'utf8'); },
  chmod,
  removeFile: async (path) => { await rm(path, { recursive: true, force: true }); },
  rename: async (from, to) => { await rename(from, to); },
  fileExists: existsSync,
  readFile: (path) => readFileSync(path, 'utf8'),
  readTextFile: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
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

const unitEnvironment = (key: string, value: string): string => {
  const assignment = `${key}=${value}`;
  return /^[A-Za-z0-9_./:=+@%,-]+$/.test(assignment) ? assignment : JSON.stringify(assignment);
};

/** Splits an ExecStart value back into arguments, reversing escapeUnitArgument's quoting. */
const tokenizeUnitArgs = (execStart: string): string[] | null => {
  const tokens: string[] = [];
  let i = 0;
  const n = execStart.length;
  while (i < n) {
    while (i < n && execStart[i] === ' ') i++;
    if (i >= n) break;
    if (execStart[i] === '"') {
      let j = i + 1;
      while (j < n && execStart[j] !== '"') {
        j += execStart[j] === '\\' ? 2 : 1;
      }
      if (j >= n) return null;
      try {
        const value: unknown = JSON.parse(execStart.slice(i, j + 1));
        if (typeof value !== 'string') return null;
        tokens.push(value);
      } catch {
        return null;
      }
      i = j + 1;
    } else {
      let j = i;
      while (j < n && execStart[j] !== ' ') j++;
      tokens.push(execStart.slice(i, j));
      i = j;
    }
  }
  return tokens;
};

const execStartServeSchema = z.object({
  port: z.string(),
  host: z.string(),
  dataDir: z.string(),
  otelEndpoint: z.string().optional(),
  otelHeaders: z.string().optional(),
  otelExport: z.string().optional(),
  otelMetricExportInterval: z.string().optional(),
  otelStdoutLogLevel: z.string().optional(),
});

const execStartFlags: Record<string, keyof z.infer<typeof execStartServeSchema>> = {
  '--port': 'port',
  '--host': 'host',
  '--data-dir': 'dataDir',
  '--otel-endpoint': 'otelEndpoint',
  '--otel-headers': 'otelHeaders',
  '--otel-export': 'otelExport',
  '--otel-metric-export-interval': 'otelMetricExportInterval',
  '--otel-stdout-log-level': 'otelStdoutLogLevel',
};

/** Recovers the `harmonic serve` invocation an ExecStart line encodes, or null if it doesn't match the shape this file writer produces. */
const parseExecStartServe = (unitContents: string): ExistingServiceSettings['serve'] | null => {
  const match = /^ExecStart=(.*)$/m.exec(unitContents);
  if (!match?.[1]) return null;
  const tokens = tokenizeUnitArgs(match[1]);
  if (!tokens || tokens.length < 3 || tokens[2] !== 'serve') return null;
  const collected: Record<string, string> = {};
  for (let i = 3; i < tokens.length; i += 2) {
    const flag = tokens[i];
    const key = flag ? execStartFlags[flag] : undefined;
    const value = tokens[i + 1];
    if (!key || value === undefined) return null;
    collected[key] = value;
  }
  const parsed = execStartServeSchema.safeParse(collected);
  return parsed.success ? parsed.data : null;
};

const parseUnitUser = (unitContents: string): string | undefined => /^User=(.+)$/m.exec(unitContents)?.[1];

/** Reads `HARMONIC_UNIT_REVISION` from a generated unit; 0 if absent (pre-boot-guard units, ADR-0042). */
export const unitRevision = (unitContents: string): number => {
  const match = /^Environment=HARMONIC_UNIT_REVISION=(\d+)$/m.exec(unitContents);
  return match?.[1] ? Number(match[1]) : 0;
};

/** The revision `unit()` currently writes; bump alongside any change `unitRevision` callers must react to. */
export const CURRENT_UNIT_REVISION = 2;

/** Recovers the operator password from a harmonic.env file written by this file writer. */
const parseEnvPassword = (envContents: string): { ok: true; password: string | undefined } | { ok: false } => {
  const match = /^HARMONIC_PASSWORD=(.*)$/m.exec(envContents);
  if (!match) return { ok: true, password: undefined };
  try {
    const value: unknown = JSON.parse(match[1]!);
    return typeof value === 'string' ? { ok: true, password: value } : { ok: false };
  } catch {
    return { ok: false };
  }
};

const initdScriptPath = '/etc/init.d/harmonic';

const ensureDataDir = async (dependencies: ServiceManagerDependencies, dataDir: string, user?: string): Promise<void> => {
  await dependencies.mkdir(dataDir);
  if (user !== undefined) await dependencies.run('chown', [user, dataDir]);
};

/** Copies the newly installed version's boot guard to `app/boot-guard.cjs`, so a pending boot always
 * runs a guard shipped by the release it's about to boot (ADR-0042). Absent on pre-guard versions. */
const copyBootGuard = async (dependencies: ServiceManagerDependencies, appDir: string, version: string): Promise<void> => {
  const guardSource = join(appDir, 'versions', version, 'dist', 'upgrade', 'boot-guard.cjs');
  if (dependencies.fileExists(guardSource)) {
    await dependencies.writeFile(join(appDir, 'boot-guard.cjs'), dependencies.readFile(guardSource, 'utf8'));
  }
};

export const shellWord = (value: string): string => /^[A-Za-z0-9_./:-]+$/.test(value)
  ? value
  : `'${value.replaceAll("'", "'\"'\"'")}'`;

export const initdScript = ({ dataDir, user, nodePath }: { dataDir: string; user: string; nodePath: string }): string => {
  const cli = shellWord(join(dataDir, 'app', 'current', 'dist', 'cli.js'));
  const runCli = `HARMONIC_INITD_SERVICE=1 HARMONIC_MANAGED_BY=initd runuser -u ${shellWord(user)} -- ${shellWord(nodePath)} ${cli}`;
  // The guard always exits 0 (ADR-0042); `|| true` is defensive. Runs as the service user, like
  // systemd's ExecStartPre, so any rollback.json/pending.json it writes stays owned by that user.
  const runGuard = `runuser -u ${shellWord(user)} -- ${shellWord(nodePath)} ${shellWord(join(dataDir, 'app', 'boot-guard.cjs'))} ${shellWord(dataDir)} || true`;
  return `#!/bin/sh
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
    ${runGuard}
    ${runCli} start --data-dir ${shellWord(dataDir)}
    ;;
  stop)
    ${runCli} stop --data-dir ${shellWord(dataDir)}
    ;;
  status)
    ${runCli} status --data-dir ${shellWord(dataDir)}
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
};

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
      join(serve.dataDir, 'app', 'current', 'dist', 'cli.js'),
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
    // Without an explicit PATH the unit inherits systemd's minimal default, which
    // omits the operator's shims (npm, opencode, version-manager bins). Carry the
    // install-time PATH so the harness can spawn its agents and in-place upgrades
    // can reach npm.
    const pathEnvironment = this.dependencies.path ? `Environment=${unitEnvironment('PATH', this.dependencies.path)}\n` : '';
    // `-` tells systemd to ignore this step's exit code; the guard always exits 0 anyway (ADR-0042).
    const execStartPre = [this.dependencies.nodePath, join(serve.dataDir, 'app', 'boot-guard.cjs'), serve.dataDir]
      .map(escapeUnitArgument)
      .join(' ');
    return `[Unit]\nDescription=Harmonic\nAfter=network.target\nStartLimitIntervalSec=120\nStartLimitBurst=10\n\n[Service]\nType=simple\nExecStartPre=-${execStartPre}\n${serviceUser}${workingDirectory}ExecStart=${args}\n${environmentFile}${pathEnvironment}Environment=HARMONIC_MANAGED_BY=systemd\nEnvironment=HARMONIC_UNIT_REVISION=${CURRENT_UNIT_REVISION}\nRestart=always\nRestartSec=2\nTimeoutStopSec=60\n\n[Install]\nWantedBy=${wantedBy}\n`;
  }

  async install(options: ServiceInstallOptions): Promise<ServiceInstallResult> {
    if (!options.serve) throw new Error('Systemd installation requires serve options.');
    const user = this.userUnit ? undefined : systemdServiceUser(resolveServiceUser({ user: options.user, sudoUser: this.dependencies.sudoUser }));
    if (user === 'root') warn(this.dependencies, 'Harmonic will run as root. Pass --user to run it as a non-root user.');
    if (this.userUnit && options.user !== undefined) warn(this.dependencies, '--user is ignored for user-level systemd.');
    if (this.userUnit) await this.dependencies.run('loginctl', ['enable-linger', this.dependencies.userName]);
    await ensureDataDir(this.dependencies, options.serve.dataDir, user);
    const appDir = join(options.serve.dataDir, 'app');
    const version = packageVersionSchema.parse(this.dependencies.currentVersion);
    await installVersion({
      appDir,
      version,
      dependencies: {
        run: this.dependencies.run,
        mkdir: this.dependencies.mkdir,
        rm: this.dependencies.removeFile,
        rename: this.dependencies.rename,
        fileExists: this.dependencies.fileExists,
        readFile: this.dependencies.readFile,
      },
    });
    await copyBootGuard(this.dependencies, appDir, version);
    if (user !== undefined) await this.dependencies.run('chown', ['-R', user, appDir]);
    await this.dependencies.run('ln', ['-sfn', `versions/${version}`, join(appDir, 'current')]);
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

  async readExistingSettings(): Promise<ExistingServiceSettings | null> {
    if (!this.dependencies.fileExists(this.unitPath)) return null;
    const unitContents = await this.dependencies.readTextFile(this.unitPath);
    if (unitContents === null) return null;
    const serve = parseExecStartServe(unitContents);
    if (serve === null) {
      warn(
        this.dependencies,
        `Could not parse the existing unit at ${this.unitPath}; reinstalling with the values you passed (or their defaults) instead of the running service's settings.`,
      );
      return null;
    }
    const user = parseUnitUser(unitContents);
    const settings: ExistingServiceSettings = { serve, ...(user === undefined ? {} : { user }) };
    if (this.dependencies.fileExists(this.environmentPath)) {
      const envContents = await this.dependencies.readTextFile(this.environmentPath);
      if (envContents === null) {
        throw new Error(`Could not read the existing password file at ${this.environmentPath}; refusing to reinstall without it. Pass --password explicitly to replace it deliberately.`);
      }
      const parsedEnv = parseEnvPassword(envContents);
      if (!parsedEnv.ok) {
        throw new Error(`Could not read the existing password from ${this.environmentPath}; refusing to reinstall without it. Pass --password explicitly to replace it deliberately.`);
      }
      if (parsedEnv.password !== undefined) settings.password = parsedEnv.password;
    }
    return settings;
  }

  /** Rewrites the unit file and reloads systemd if its `HARMONIC_UNIT_REVISION` predates the boot
   * guard (ADR-0042); no-op when already current, no unit is installed, or the existing unit can't
   * be parsed. Only meaningful for user-level units — self-healing a root-owned system unit needs
   * `sudo harmonic install` instead. Idempotent: a second call after a successful rewrite is a no-op. */
  async ensureUnitRevisionCurrent(): Promise<boolean> {
    if (!this.dependencies.fileExists(this.unitPath)) return false;
    const unitContents = await this.dependencies.readTextFile(this.unitPath);
    if (unitContents === null || unitRevision(unitContents) >= CURRENT_UNIT_REVISION) return false;
    const existing = await this.readExistingSettings();
    if (existing === null) return false;
    const serve: ServiceServeOptions = {
      port: existing.serve.port,
      host: existing.serve.host,
      dataDir: existing.serve.dataDir,
      ...(existing.password === undefined ? {} : { password: existing.password }),
      ...(existing.serve.otelEndpoint === undefined ? {} : { otelEndpoint: existing.serve.otelEndpoint }),
      ...(existing.serve.otelHeaders === undefined ? {} : { otelHeaders: existing.serve.otelHeaders }),
      ...(existing.serve.otelExport === undefined ? {} : { otelExport: existing.serve.otelExport }),
      ...(existing.serve.otelMetricExportInterval === undefined ? {} : { otelMetricExportInterval: existing.serve.otelMetricExportInterval }),
      ...(existing.serve.otelStdoutLogLevel === undefined ? {} : { otelStdoutLogLevel: existing.serve.otelStdoutLogLevel }),
    };
    await this.dependencies.writeFile(this.unitPath, this.unit(serve, existing.user));
    await this.dependencies.chmod(this.unitPath, 0o644);
    await this.systemctl('daemon-reload');
    return true;
  }
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
    const dataDir = options.serve.dataDir;
    await ensureDataDir(this.dependencies, dataDir, user);
    const appDir = join(dataDir, 'app');
    const version = packageVersionSchema.parse(this.dependencies.currentVersion);
    await installVersion({
      appDir,
      version,
      dependencies: {
        run: this.dependencies.run,
        mkdir: this.dependencies.mkdir,
        rm: this.dependencies.removeFile,
        rename: this.dependencies.rename,
        fileExists: this.dependencies.fileExists,
        readFile: this.dependencies.readFile,
      },
    });
    await copyBootGuard(this.dependencies, appDir, version);
    await this.dependencies.run('chown', ['-R', user, appDir]);
    await this.dependencies.run('ln', ['-sfn', `versions/${version}`, join(appDir, 'current')]);
    await this.dependencies.writeFile(initdScriptPath, initdScript({ dataDir, user, nodePath: this.dependencies.nodePath }));
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

  async readExistingSettings(): Promise<ExistingServiceSettings | null> { return null; }
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

  async readExistingSettings(): Promise<ExistingServiceSettings | null> {
    return null;
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
