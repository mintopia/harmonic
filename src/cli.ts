#!/usr/bin/env node
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './server/app.js';
import { defaultDataDir, verifyChannelsUnconfigured } from './config.js';
import { acquireLock, daemonStatus, logFilePath, releaseLock, stopDaemon, writeDaemon } from './daemon.js';
import { initializeTelemetry, resolveTelemetryOptions } from './telemetry.js';
import { logger } from './logger.js';
import { installProcessSafetyNet } from './reliability/process-safety-net.js';
import { dispatchCli } from './cli-dispatch.js';
import { UpgradeSwap } from './upgrade/upgrade-swap.js';
import { startOperation } from './telemetry/operations.js';

const execFileAsync = promisify(execFile);

const HELP = `harmonic — queue, run, and review autonomous agent tasks

Usage:
  harmonic serve [--port <n>] [--host <h>] [--data-dir <dir>] [--password <pw>] [telemetry options]
  harmonic start [--port <n>] [--host <h>] [--data-dir <dir>] [--password <pw>] [telemetry options]
  harmonic status [--data-dir <dir>]
  harmonic stop [--data-dir <dir>]

Commands:
  serve       Run the server in the foreground
  start       Run the server in the background (logs to <data-dir>/harmonic.log)
  status      Show whether a background server is running
  stop        Stop the background server
  version     Print the installed Harmonic version (also --version, -v)

Options:
  --port, -p  Port to listen on (default 4700)
  --host, -H  Host to bind (default 0.0.0.0)
  --data-dir  State directory (default ~/.harmonic, or $HARMONIC_DATA_DIR)
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
const displayUrl = (host: string, port: number) =>
  `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

/** The installed version, read from the package manifest that ships beside dist/. */
const readVersion = (): string => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
  return pkg.version ?? 'unknown';
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rest = argv.slice(1);
  const dispatch = dispatchCli(argv);

  if (dispatch.kind === 'status' || dispatch.kind === 'stop') {
    const dataDir = dispatch.dataDir ?? defaultDataDir();
    if (dispatch.kind === 'stop') {
      logger.info((await stopDaemon(dataDir)) ? 'Stopped.' : 'Not running.');
      return;
    }
    const { running, info } = daemonStatus(dataDir);
    if (!running || !info) {
      logger.info('Not running.');
      process.exit(1);
    }
    logger.info(
      `Running (pid ${info.pid}) — ${displayUrl(info.host, info.port)}, ` +
        `up since ${new Date(info.startedAt).toLocaleString()}\nLogs: ${logFilePath(dataDir)}`,
    );
    return;
  }

  if (dispatch.kind === 'version') {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  if (dispatch.kind === 'help') {
    process.stdout.write(HELP);
    process.exit(dispatch.exitCode);
  }

  const { values } = dispatch;

  if (dispatch.kind === 'start') {
    const dataDir = values['data-dir'] ?? defaultDataDir();
    const port = Number(values.port);
    const host = values.host!;
    const existing = daemonStatus(dataDir);
    if (existing.running && existing.info) {
      logger.error(
        `Already running (pid ${existing.info.pid}) — ${displayUrl(existing.info.host, existing.info.port)}. ` +
          '`harmonic stop` first.',
      );
      process.exit(1);
    }
    mkdirSync(dataDir, { recursive: true });
    const log = openSync(logFilePath(dataDir), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', ...rest], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.unref();
    writeDaemon(dataDir, { pid: child.pid!, port, host, startedAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!daemonStatus(dataDir).running) {
      logger.error(`Failed to start — see ${logFilePath(dataDir)}`);
      await stopDaemon(dataDir);
      process.exit(1);
    }
    logger.info(
      `Harmonic running in the background (pid ${child.pid}) — ${displayUrl(host, port)}\n` +
        `Logs: ${logFilePath(dataDir)}\nStop with: harmonic stop`,
    );
    return;
  }

  const dataDir = values['data-dir'] ?? defaultDataDir();
  const port = Number(values.port);
  const host = values.host!;
  const holder = acquireLock(dataDir, { port, host });
  if (holder) {
    logger.error(
      `Another Harmonic instance is using ${dataDir} (pid ${holder.pid}, ${displayUrl(holder.host, holder.port)}).\n` +
        '  Stop it first (harmonic stop), or use a different --data-dir.',
    );
    process.exit(1);
  }
  installProcessSafetyNet();
  const password = values.password ?? process.env.HARMONIC_PASSWORD;
  const telemetryOptions = resolveTelemetryOptions({
    endpoint: values['otel-endpoint'],
    headers: values['otel-headers'],
    exportEnabled: values['otel-export'],
    metricExportIntervalMillis: values['otel-metric-export-interval'],
    stdoutLogLevel: values['otel-stdout-log-level'],
  });
  const telemetry = initializeTelemetry(telemetryOptions, { ownsMetricSummaryInterval: false });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let installedCliPath: string | undefined;
  try {
    app = await buildApp({
      dataDir,
      password,
      metricsSummary: { intervalMs: telemetryOptions.metricExportIntervalMillis, flush: () => telemetry.flushMetricSummary() },
      onUpgradeIdle: async (version) => {
        const swap = new UpgradeSwap({
          install: async (target) => {
            await execFileAsync('npm', ['i', '-g', `@mintopia/harmonic@${target}`]);
          },
          installedVersion: async () => {
            const { stdout } = await execFileAsync('npm', ['root', '-g']);
            const packageDir = join(stdout.trim(), '@mintopia', 'harmonic');
            const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: unknown };
            installedCliPath = join(packageDir, 'dist', 'cli.js');
            return typeof pkg.version === 'string' ? pkg.version : 'unknown';
          },
          spawnRelauncher: async () => {
            if (!installedCliPath) throw new Error('installed Harmonic CLI path was not resolved');
            const relauncher = fileURLToPath(new URL('./upgrade/relauncher.js', import.meta.url));
            const child = spawn(process.execPath, [relauncher, dataDir, installedCliPath, JSON.stringify(rest)], {
              detached: true,
              stdio: 'ignore',
            });
            child.unref();
          },
          releaseLock: async () => {
            await app.close();
            await telemetry.shutdown();
            releaseLock(dataDir);
          },
          exit: () => { process.exit(0); },
          abort: async () => {},
          operation: async ({ type, version: target }, work) => {
            const operation = startOperation({ type, attributes: { 'upgrade.version': target } });
            try {
              const result = await operation.run(work);
              operation.end();
              return result;
            } catch (error) {
              operation.fail(error);
              throw error;
            }
          },
          log: (event) => {
            const log = event.outcome === 'failed' ? logger.error : logger.info;
            log(`upgrade ${event.action} ${event.outcome}`, {
              action: event.action,
              version: event.version,
              ...(event.error ? { error: event.error.message } : {}),
            });
          },
        });
        const outcome = await swap.execute({ version });
        if (outcome.kind === 'aborted') throw outcome.error;
      },
    });
  } catch (error) {
    await telemetry.shutdown();
    releaseLock(dataDir);
    throw error;
  }
  if (!(await app.ctx.auth.hasPassword())) {
    const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    logger.warn(
      `No operator password set — Harmonic is running ungated${loopback ? '' : ` and reachable on ${host}`}.\n` +
        (loopback ? '' : '  Anyone who can reach this address has full access. Bind to 127.0.0.1 or set a password.\n') +
        '  Set one any time: harmonic serve --password <password>   (or HARMONIC_PASSWORD)',
    );
  }
  const { verify } = app.ctx.settingsStore.getGlobal();
  if (verifyChannelsUnconfigured(verify)) {
    logger.warn(
      'No command verifier and no critic review are configured — merges will proceed with no verification at all. Configure one in Settings → Verification, or add commands/enable review for a workspace.',
    );
  }
  await app.listen({ port, host });
  logger.info(`Harmonic listening on ${displayUrl(host, port)} (bound to ${host}, data: ${dataDir})`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    await telemetry.shutdown();
    releaseLock(dataDir);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  logger.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
