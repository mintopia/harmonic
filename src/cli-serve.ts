import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
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
import { SYSTEMD_MIGRATION_NOTICE } from './upgrade/upgrade-coordinator.js';
import { hasValidInstall, installVersion, readInstalledVersion, type VersionInstallDependencies } from './upgrade/version-install.js';
import { markHealthy } from './upgrade/boot-state.js';
import { startOperation } from './telemetry/operations.js';
import { displayUrl, type CliOutcome } from './cli-commands.js';

export function requiresSystemdInstallMigration({ managedBy, dataDir, cliPath }: { managedBy: string | undefined; dataDir: string; cliPath: string }): boolean {
  if (managedBy !== 'systemd') return false;
  const current = join(dataDir, 'app', 'current');
  const pathFromCurrent = relative(current, cliPath);
  return pathFromCurrent === '' || pathFromCurrent.startsWith('..') || isAbsolute(pathFromCurrent);
}

export function detectSystemdInstallMigration({
  managedBy,
  dataDir,
  cliPath,
  warn,
}: {
  managedBy: string | undefined;
  dataDir: string;
  cliPath: string;
  warn: (message: string) => void;
}): boolean {
  const migrationRequired = requiresSystemdInstallMigration({ managedBy, dataDir, cliPath });
  if (migrationRequired) warn(SYSTEMD_MIGRATION_NOTICE);
  return migrationRequired;
}

const execFileAsync = promisify(execFile);

export type UpgradeCommand = (file: string, args: readonly string[]) => Promise<unknown>;

export type SystemdUpgradeFsDependencies = Pick<VersionInstallDependencies, 'mkdir' | 'rm' | 'rename' | 'fileExists' | 'readFile'>;

const defaultSystemdUpgradeFsDependencies = (): SystemdUpgradeFsDependencies => ({
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  rm: async (path) => { await rm(path, { recursive: true, force: true }); },
  rename: async (from, to) => { await rename(from, to); },
  fileExists: existsSync,
  readFile: (path) => readFileSync(path, 'utf8'),
});

export async function installSystemdUpgrade({
  dataDir,
  target,
  run,
  packageSpec,
  fs = defaultSystemdUpgradeFsDependencies(),
}: {
  dataDir: string;
  target: string;
  run: UpgradeCommand;
  packageSpec?: string;
  fs?: SystemdUpgradeFsDependencies;
}): Promise<void> {
  const appDir = join(dataDir, 'app');
  const versionDir = await installVersion({
    appDir,
    version: target,
    ...(packageSpec === undefined ? {} : { packageSpec }),
    dependencies: { run, ...fs },
  });
  // Verify before flipping `current`: a broken install must never take down the running service.
  if (!hasValidInstall(versionDir, target, fs)) {
    throw new Error(`self-upgrade to ${target} did not produce a valid install at ${versionDir}`);
  }
  await run('ln', ['-sfn', `versions/${target}`, join(appDir, 'current')]);
}

export function readSystemdInstalledVersion({
  dataDir,
  readFile,
}: {
  dataDir: string;
  readFile: (path: string, encoding: 'utf8') => string;
}): string {
  return readInstalledVersion({ dir: join(dataDir, 'app', 'current'), readFile });
}

export async function runServer(values: ServeValues, rest: string[]): Promise<CliOutcome> {
  const dataDir = values['data-dir'] ?? defaultDataDir();
  const port = Number(values.port);
  const host = values.host!;
  const migrationRequired = detectSystemdInstallMigration({
    managedBy: process.env.HARMONIC_MANAGED_BY,
    dataDir,
    cliPath: process.argv[1] ?? fileURLToPath(import.meta.url),
    warn: logger.warn,
  });
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
          waitForIdle: () => app.ctx.upgrade.waitForIdle(),
          releaseLock: createUpgradeReleaseLock({
            close: () => app.close(),
            shutdownTelemetry: () => telemetry.shutdown(),
            releaseLock: () => releaseLock(dataDir),
            exit: (code) => process.exit(code),
          }),
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

  if (!migrationRequired && (process.env.HARMONIC_MANAGED_BY === 'systemd' || process.env.HARMONIC_MANAGED_BY === 'initd')) {
    try {
      // `current` may already point at a later version than the one actually executing this process
      // (a subsequent upgrade attempt can flip it before this process restarts), so resolve the running
      // version and its own boot-guard from this process's own install directory, not from `current`.
      const ownDir = fileURLToPath(new URL('..', import.meta.url));
      markHealthy({
        appDir: join(dataDir, 'app'),
        runningVersion: readInstalledVersion({ dir: ownDir, readFile: readFileSync }),
        guardSource: join(ownDir, 'dist', 'upgrade', 'boot-guard.cjs'),
      });
    } catch (error) {
      logger.warn('Failed to mark the running version healthy after boot', { error: error instanceof Error ? error.message : String(error) });
    }
  }

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

/**
 * The upgrade swap's `releaseLock` step: once it starts, the process must
 * always drop the data-dir lock and exit, or a botched `app.close()`/telemetry
 * shutdown leaves a dead-but-listening process holding the lock forever with
 * systemd unable to restart it (issue #3). `close`/`shutdownTelemetry` failures
 * or a hang (bounded by `timeoutMs`) are swallowed here and force a non-zero
 * exit instead of propagating — a zero exit is left to the swap's own `exit`
 * step on the clean path.
 */
export function createUpgradeReleaseLock({
  close,
  shutdownTelemetry,
  releaseLock: releaseLockFile,
  exit,
  log,
  timeoutMs = 10_000,
}: {
  close: () => Promise<void>;
  shutdownTelemetry: () => Promise<void>;
  releaseLock: () => void;
  exit: (code: number) => void;
  log?: (message: string) => void;
  timeoutMs?: number;
}): () => Promise<void> {
  const warn = log ?? logger.error;
  return async () => {
    let failed = false;
    try {
      await Promise.race([
        close(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`app.close() exceeded ${timeoutMs}ms`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      failed = true;
      warn(`upgrade release-lock: app.close failed, forcing shutdown: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await shutdownTelemetry();
    } catch (error) {
      failed = true;
      warn(`upgrade release-lock: telemetry shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    releaseLockFile();
    if (failed) exit(1);
  };
}
