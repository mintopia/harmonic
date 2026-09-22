import { readFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './server/app.js';
import { defaultDataDir, verifyChannelsUnconfigured } from './config.js';
import { acquireLock, releaseLock } from './daemon.js';
import { initializeTelemetry, resolveTelemetryOptions } from './telemetry.js';
import { logger } from './logger.js';
import { installProcessSafetyNet } from './reliability/process-safety-net.js';
import { type ServeValues } from './cli-dispatch.js';
import { UpgradeSwap } from './upgrade/upgrade-swap.js';
import { startOperation } from './telemetry/operations.js';
import { displayUrl, type CliOutcome } from './cli-commands.js';

export function requiresSystemdInstallMigration({ managedBy, dataDir, cliPath }: { managedBy: string | undefined; dataDir: string; cliPath: string }): boolean {
  if (managedBy !== 'systemd') return false;
  const current = join(dataDir, 'app', 'current');
  const pathFromCurrent = relative(current, cliPath);
  return pathFromCurrent === '' || pathFromCurrent.startsWith('..') || isAbsolute(pathFromCurrent);
}

const execFileAsync = promisify(execFile);

export type UpgradeCommand = (file: string, args: string[]) => Promise<unknown>;

export async function installSystemdUpgrade({
  dataDir,
  target,
  run,
}: {
  dataDir: string;
  target: string;
  run: UpgradeCommand;
}): Promise<void> {
  const appDir = join(dataDir, 'app');
  const versionDir = join(appDir, 'versions', target);
  await run('npm', ['i', '--prefix', versionDir, `@mintopia/harmonic@${target}`]);
  await run('ln', ['-sfn', `versions/${target}`, join(appDir, 'current')]);
}

export function readSystemdInstalledVersion({
  dataDir,
  readFile,
}: {
  dataDir: string;
  readFile: (path: string, encoding: 'utf8') => string;
}): string {
  const packagePath = `${join(dataDir, 'app', 'current', 'dist')}/../package.json`;
  const packageJson: unknown = JSON.parse(readFile(packagePath, 'utf8'));
  if (typeof packageJson !== 'object' || packageJson === null || !('version' in packageJson)) return 'unknown';
  return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
}

export async function runServer(values: ServeValues, rest: string[]): Promise<CliOutcome> {
  const dataDir = values['data-dir'] ?? defaultDataDir();
  const port = Number(values.port);
  const host = values.host!;
  const migrationRequired = requiresSystemdInstallMigration({
    managedBy: process.env.HARMONIC_MANAGED_BY,
    dataDir,
    cliPath: process.argv[1] ?? fileURLToPath(import.meta.url),
  });
  if (migrationRequired) {
    logger.warn('Auto-upgrade is disabled until you re-run sudo harmonic install; your data is untouched.');
  }
  const holder = acquireLock(dataDir, { port, host });
  if (holder) {
    logger.error(
      `Another Harmonic instance is using ${dataDir} (pid ${holder.pid}, ${displayUrl(holder.host, holder.port)}).\n` +
        '  Stop it first (harmonic stop), or use a different --data-dir.',
    );
    return { kind: 'exit', code: 1 };
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
      migrationRequired,
      metricsSummary: { intervalMs: telemetryOptions.metricExportIntervalMillis, flush: () => telemetry.flushMetricSummary() },
      onUpgradeIdle: async (version) => {
        const swap = new UpgradeSwap({
          ...(process.env.HARMONIC_MANAGED_BY === undefined ? {} : { managedBy: process.env.HARMONIC_MANAGED_BY }),
          ...(migrationRequired ? { migrationRequired: true } : {}),
          install: async (target) => {
            if (process.env.HARMONIC_MANAGED_BY === 'systemd') {
              await installSystemdUpgrade({
                dataDir,
                target,
                run: async (file, args) => execFileAsync(file, args),
              });
              return;
            }
            await execFileAsync('npm', ['i', '-g', `@mintopia/harmonic@${target}`]);
          },
          installedVersion: async () => {
            if (process.env.HARMONIC_MANAGED_BY === 'systemd') {
              return readSystemdInstalledVersion({ dataDir, readFile: readFileSync });
            }
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

  const releaseAll = async () => {
    await app.close();
    await telemetry.shutdown();
    releaseLock(dataDir);
  };
  const shutdown = createShutdownHandler(releaseAll, (code) => process.exit(code));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { kind: 'continue' };
}

export function createShutdownHandler(release: () => Promise<void>, exit: (code: number) => void): () => Promise<void> {
  let shuttingDown = false;
  return async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await release();
    exit(0);
  };
}
