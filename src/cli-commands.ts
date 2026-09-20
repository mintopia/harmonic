import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { defaultDataDir } from './config.js';
import { daemonStatus, logFilePath, stopDaemon, writeDaemon, type DaemonInfo } from './daemon.js';
import { logger } from './logger.js';
import { dispatchCli, type CliDispatch, type ServeValues } from './cli-dispatch.js';
import { createServiceManager, shellWord, type ServiceManager } from './service-manager.js';

export type CliOutcome =
  | { kind: 'exit'; code: number }
  | { kind: 'continue' };

export interface CliDaemonOps {
  daemonStatus(dataDir: string): { running: boolean; info: DaemonInfo | null };
  stopDaemon(dataDir: string): Promise<boolean>;
  writeDaemon(dataDir: string, info: DaemonInfo): void;
  logFilePath(dataDir: string): string;
}

export interface CliCommandDependencies {
  defaultDataDir(): string;
  serviceManager(): ServiceManager;
  installedServiceManager(): ServiceManager | null;
  daemon: CliDaemonOps;
  spawnServe(input: { dataDir: string; args: string[] }): number | undefined;
  wait(milliseconds: number): Promise<void>;
  version(): string;
  write(text: string): void;
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
  runServer(values: ServeValues, rest: string[]): Promise<CliOutcome>;
}

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`cli exit ${code}`);
  }
}

export const HELP = `harmonic — queue, run, and review autonomous agent tasks

Usage:
  harmonic serve [--port <n>] [--host <h>] [--data-dir <dir>] [--password <pw>] [telemetry options]
  harmonic start [--port <n>] [--host <h>] [--data-dir <dir>] [--password <pw>] [telemetry options]
  harmonic status [--data-dir <dir>]
  harmonic stop [--data-dir <dir>]
  harmonic restart [--data-dir <dir>]
  harmonic install [--port <n>] [--host <h>] [--data-dir <dir>] [--user <name>] [--password <pw>] [telemetry options]
  harmonic uninstall [--data-dir <dir>]

Commands:
  serve       Run the server in the foreground
  start       Run the server in the background (logs to <data-dir>/harmonic.log)
  status      Show whether a background server is running
  stop        Stop the background server
  restart     Restart the installed service or background server
  install     Install Harmonic as a service, or print a boot-hook command
  uninstall   Remove the installed Harmonic service
  version     Print the installed Harmonic version (also --version, -v)

Options:
  --port, -p  Port to listen on (default 4700)
  --host, -H  Host to bind (default 0.0.0.0)
  --data-dir  State directory (default ~/.harmonic, or $HARMONIC_DATA_DIR)
  --user      OS user for a system service (ignored by user-level systemd)
  --password  Set/update the operator password (or $HARMONIC_PASSWORD).
              Optional; pass an empty value (--password '') to remove it and
              run ungated
  --otel-endpoint <url>       OTLP/HTTP base endpoint (or $OTEL_EXPORTER_OTLP_ENDPOINT)
  --otel-headers <headers>    Comma-separated key=value headers (or $OTEL_EXPORTER_OTLP_HEADERS)
  --otel-export <true|false>  Enable OTLP export; default off (or $OTEL_EXPORTER_OTLP_ENABLED)
  --otel-metric-export-interval <milliseconds>
                              Metric export and stdout summary interval
                              (or $OTEL_METRIC_EXPORT_INTERVAL)
  --otel-stdout-log-level <level>
                              debug, info, warn, error, or none
                              (or $OTEL_STDOUT_LOG_LEVEL)
`;

/** 0.0.0.0 binds everywhere but isn't a clickable URL — show localhost. */
export const displayUrl = (host: string, port: number) =>
  `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

export const readVersion = (): string => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
  return pkg.version ?? 'unknown';
};

const userSystemdUsable = (): boolean => {
  const uid = process.getuid?.();
  if (!process.env.XDG_RUNTIME_DIR || !process.env.DBUS_SESSION_BUS_ADDRESS || uid === undefined) return false;
  try {
    const linger = execFileSync('loginctl', ['show-user', String(uid), '--property=Linger', '--value'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    });
    if (linger.trim() !== 'yes') return false;
    execFileSync('systemctl', ['--user', 'show-environment'], {
      stdio: 'ignore',
      timeout: 1_000,
    });
    return true;
  } catch (error) {
    logger.debug('cli: user systemd unusable', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
};

const serviceManager = (): ServiceManager => {
  const isRoot = process.getuid?.() === 0;
  return createServiceManager({
    platform: process.platform,
    isRoot,
    systemdRunning: existsSync('/run/systemd/system'),
    initdAvailable: existsSync('/etc/init.d'),
    userSystemdUsable: !isRoot && userSystemdUsable(),
  });
};

const installedServiceManager = (): ServiceManager | null =>
  process.env.HARMONIC_INITD_SERVICE === '1' || process.platform !== 'linux' ? null : serviceManager();

export const bootCommand = (rest: string[]): string => {
  const safeArgs: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === '--password') {
      index++;
      continue;
    }
    if (!arg.startsWith('--password=')) safeArgs.push(arg);
  }
  return ['harmonic', 'start', ...safeArgs].map(shellWord).join(' ');
};

export function productionCliDependencies(options: { cliEntryPath: string }): CliCommandDependencies {
  return {
    defaultDataDir,
    serviceManager,
    installedServiceManager,
    daemon: { daemonStatus, stopDaemon, writeDaemon, logFilePath },
    spawnServe: ({ dataDir, args }) => {
      mkdirSync(dataDir, { recursive: true });
      const log = openSync(logFilePath(dataDir), 'a');
      const child = spawn(process.execPath, [options.cliEntryPath, 'serve', ...args], {
        detached: true,
        stdio: ['ignore', log, log],
      });
      child.unref();
      return child.pid;
    },
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    version: readVersion,
    write: (text) => { process.stdout.write(text); },
    log: logger,
    runServer: async (values, rest) => {
      const { runServer } = await import('./cli-serve.js');
      return runServer(values, rest);
    },
  };
}

async function startStandalone(values: ServeValues, rest: string[], deps: CliCommandDependencies): Promise<void> {
  const dataDir = values['data-dir'] ?? deps.defaultDataDir();
  const port = Number(values.port);
  const host = values.host!;
  const existing = deps.daemon.daemonStatus(dataDir);
  if (existing.running && existing.info) {
    deps.log.error(
      `Already running (pid ${existing.info.pid}) — ${displayUrl(existing.info.host, existing.info.port)}. ` +
        '`harmonic stop` first.',
    );
    throw new CliExit(1);
  }
  const pid = deps.spawnServe({ dataDir, args: rest });
  deps.daemon.writeDaemon(dataDir, { pid: pid!, port, host, startedAt: Date.now() });
  await deps.wait(1500);
  if (!deps.daemon.daemonStatus(dataDir).running) {
    deps.log.error(`Failed to start — see ${deps.daemon.logFilePath(dataDir)}`);
    await deps.daemon.stopDaemon(dataDir);
    throw new CliExit(1);
  }
  deps.log.info(
    `Harmonic running in the background (pid ${pid}) — ${displayUrl(host, port)}\n` +
      `Logs: ${deps.daemon.logFilePath(dataDir)}\nStop with: harmonic stop`,
  );
}

async function runLifecycleCommand(
  dispatch: Extract<CliDispatch, { kind: 'status' | 'stop' | 'restart' | 'uninstall' }>,
  deps: CliCommandDependencies,
): Promise<CliOutcome> {
  const dataDir = dispatch.dataDir ?? deps.defaultDataDir();
  if (dispatch.kind === 'uninstall') {
    const manager = deps.serviceManager();
    await manager.uninstall();
    deps.log.info('Service uninstalled.');
    return { kind: 'continue' };
  }
  if (dispatch.kind === 'restart' && process.platform !== 'linux') deps.serviceManager();
  const manager = deps.installedServiceManager();
  if (manager && (await manager.isInstalled())) {
    if (dispatch.kind === 'stop') {
      await manager.stop();
      deps.log.info('Stopped.');
      return { kind: 'continue' };
    }
    if (dispatch.kind === 'restart') {
      await manager.restart();
      deps.log.info('Restarted.');
      return { kind: 'continue' };
    }
    const status = await manager.status();
    deps.log.info(status.detail ?? (status.running ? 'Running.' : 'Not running.'));
    if (!status.running) return { kind: 'exit', code: 1 };
    return { kind: 'continue' };
  }
  if (dispatch.kind === 'stop') {
    deps.log.info((await deps.daemon.stopDaemon(dataDir)) ? 'Stopped.' : 'Not running.');
    return { kind: 'continue' };
  }
  if (dispatch.kind === 'restart') {
    await deps.daemon.stopDaemon(dataDir);
    const values = dispatchCli(['start', '--data-dir', dataDir]);
    if (values.kind !== 'start') throw new Error('Unable to build restart command');
    await startStandalone(values.values, ['--data-dir', dataDir], deps);
    return { kind: 'continue' };
  }
  const { running, info } = deps.daemon.daemonStatus(dataDir);
  if (!running || !info) {
    deps.log.info('Not running.');
    return { kind: 'exit', code: 1 };
  }
  deps.log.info(
    `Running (pid ${info.pid}) — ${displayUrl(info.host, info.port)}, ` +
      `up since ${new Date(info.startedAt).toLocaleString()}\nLogs: ${deps.daemon.logFilePath(dataDir)}`,
  );
  return { kind: 'continue' };
}

async function runInstallCommand(values: ServeValues, rest: string[], deps: CliCommandDependencies): Promise<CliOutcome> {
  const manager = deps.serviceManager();
  deps.log.info(`Selected ${manager.backend}.`);
  const result = await manager.install({
    startSelfManaged: () => startStandalone(values, rest, deps),
    bootCommand: bootCommand(rest),
    serve: {
      port: values.port,
      host: values.host,
      dataDir: values['data-dir'] ?? deps.defaultDataDir(),
      ...(values.password === undefined ? {} : { password: values.password }),
      ...(values['otel-endpoint'] === undefined ? {} : { otelEndpoint: values['otel-endpoint'] }),
      ...(values['otel-headers'] === undefined ? {} : { otelHeaders: values['otel-headers'] }),
      ...(values['otel-export'] === undefined ? {} : { otelExport: values['otel-export'] }),
      ...(values['otel-metric-export-interval'] === undefined
        ? {}
        : { otelMetricExportInterval: values['otel-metric-export-interval'] }),
      ...(values['otel-stdout-log-level'] === undefined ? {} : { otelStdoutLogLevel: values['otel-stdout-log-level'] }),
    },
    ...(values.user === undefined ? {} : { user: values.user }),
  });
  if (result.status) deps.log.info(result.status.detail ?? (result.status.running ? 'Running.' : 'Not running.'));
  if (result.bootCommand) deps.log.info(`Add this to the host boot hook: ${result.bootCommand}`);
  return { kind: 'continue' };
}

async function runStartCommand(values: ServeValues, rest: string[], deps: CliCommandDependencies): Promise<CliOutcome> {
  const manager = deps.installedServiceManager();
  if (manager && (await manager.isInstalled())) {
    await manager.start();
    deps.log.info('Started.');
    return { kind: 'continue' };
  }
  await startStandalone(values, rest, deps);
  return { kind: 'continue' };
}

export async function runCliCommand(dispatch: CliDispatch, rest: string[], deps: CliCommandDependencies): Promise<CliOutcome> {
  try {
    switch (dispatch.kind) {
      case 'status':
      case 'stop':
      case 'restart':
      case 'uninstall':
        return await runLifecycleCommand(dispatch, deps);
      case 'version':
        deps.write(`${deps.version()}\n`);
        return { kind: 'continue' };
      case 'help':
        deps.write(HELP);
        return { kind: 'exit', code: dispatch.exitCode };
      case 'install':
        return await runInstallCommand(dispatch.values, rest, deps);
      case 'start':
        return await runStartCommand(dispatch.values, rest, deps);
      case 'serve':
        return await deps.runServer(dispatch.values, rest);
    }
  } catch (error) {
    if (error instanceof CliExit) return { kind: 'exit', code: error.code };
    throw error;
  }
}
