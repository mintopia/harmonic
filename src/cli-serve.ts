import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readlinkSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './server/app.js';
import { defaultDataDir, verifyChannelsUnconfigured } from './config.js';
import { acquireLock, releaseLock } from './daemon.js';
import { initializeTelemetry, resolveTelemetryOptions } from './telemetry.js';
import { logger } from './logger.js';
import { installProcessSafetyNet } from './reliability/process-safety-net.js';
import { beginBootProgress, endBootProgress, touchStartupProgress } from './reliability/startup-progress.js';
import { type ServeValues } from './cli-dispatch.js';
import { UpgradeSwap } from './upgrade/upgrade-swap.js';
import { SYSTEMD_MIGRATION_NOTICE, type UpgradeCancellation } from './upgrade/upgrade-coordinator.js';
import { defaultIsWritable, defaultRealpath, resolveInstallMode, type InstallMode } from './upgrade/install-mode.js';
import { hasValidInstall, installVersion, readInstalledVersion, verifyInstall, type VersionInstallDependencies } from './upgrade/version-install.js';
import { clearRollback, flipCurrent, markHealthy, readPending, readRollback, snapshotDatabase, writePending } from './upgrade/boot-state.js';
import { startOperation } from './telemetry/operations.js';
import { displayUrl, type CliOutcome } from './cli-commands.js';
import { createServiceManager, CURRENT_UNIT_REVISION, unitRevision } from './service-manager.js';

export interface SystemdGuardRevisionDeps {
  systemUnitPath: string;
  userUnitPath: string;
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string;
  /** Rewrites and reloads the user unit if it predates the boot guard; a no-op otherwise. */
  ensureUserUnitCurrent: () => Promise<unknown> | undefined;
  warn: (message: string) => void;
}

/**
 * Checks the system unit path first, then the user unit path, since the running process's own
 * uid doesn't tell us which one owns it (`sudo harmonic install --user x` runs a root-owned unit
 * as a non-root user). A pre-boot-guard system unit can't self-heal without root, so it's reported
 * as `guardMissing` instead of rewritten; a user unit self-heals in place.
 */
export async function reconcileSystemdGuardRevision(deps: SystemdGuardRevisionDeps): Promise<boolean> {
  if (deps.fileExists(deps.systemUnitPath)) {
    try {
      return unitRevision(deps.readFile(deps.systemUnitPath)) < CURRENT_UNIT_REVISION;
    } catch (error) {
      deps.warn(`Failed to read the system unit at ${deps.systemUnitPath}: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
  }
  if (deps.fileExists(deps.userUnitPath)) {
    try {
      await deps.ensureUserUnitCurrent();
      return false;
    } catch (error) {
      deps.warn(`Failed to self-heal the user systemd unit at ${deps.userUnitPath}: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
  }
  deps.warn(`Could not find a systemd unit for this process at ${deps.systemUnitPath} or ${deps.userUnitPath}; automatic rollback status is unknown.`);
  return true;
}

const execFileAsync = promisify(execFile);

export type UpgradeCommand = (file: string, args: readonly string[]) => Promise<unknown>;

export type ManagedUpgradeFsDependencies = Pick<VersionInstallDependencies, 'mkdir' | 'rm' | 'rename' | 'fileExists' | 'readFile' | 'readlink' | 'fsyncDir'>;

const defaultManagedUpgradeFsDependencies = (): ManagedUpgradeFsDependencies => ({
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  rm: async (path) => { await rm(path, { recursive: true, force: true }); },
  rename: async (from, to) => { await rename(from, to); },
  fileExists: existsSync,
  readFile: (path) => readFileSync(path, 'utf8'),
  readlink: (path) => {
    try {
      return readlinkSync(path);
    } catch {
      return null;
    }
  },
  fsyncDir: (path) => {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
});

/** Installs a pinned version into `app/versions/<target>`; the flip to `app/current` happens later, in the swap's commit step. */
export async function installManagedUpgrade({
  dataDir,
  target,
  run,
  packageSpec,
  fs = defaultManagedUpgradeFsDependencies(),
}: {
  dataDir: string;
  target: string;
  run: UpgradeCommand;
  packageSpec?: string;
  fs?: ManagedUpgradeFsDependencies;
}): Promise<void> {
  const appDir = join(dataDir, 'app');
  const versionDir = await installVersion({
    appDir,
    version: target,
    ...(packageSpec === undefined ? {} : { packageSpec }),
    dependencies: { run, ...fs },
  });
  if (!hasValidInstall(versionDir, target, fs)) {
    throw new Error(`self-upgrade to ${target} did not produce a valid install at ${versionDir}`);
  }
}

export function readManagedInstalledVersion({
  dataDir,
  readlink,
  fileExists,
}: {
  dataDir: string;
  readlink: (path: string) => string;
  fileExists: (path: string) => boolean;
}): string {
  const appDir = join(dataDir, 'app');
  let target: string;
  try {
    target = readlink(join(appDir, 'current'));
  } catch {
    return 'unknown';
  }
  const version = target.split('/').pop();
  // Trust the symlink target only once its version directory exists (a rescued 2.18.0/2.18.1
  // install's package.json can't be trusted instead: it's npm's wrapper manifest, not ours).
  if (!version || !fileExists(join(appDir, 'versions', version))) return 'unknown';
  return version;
}

/** Force-kills this process if boot hangs past `deadlineMs` without touching {@link touchStartupProgress}, so systemd/the relauncher restart it. Runs as a separate OS process because a fully blocked event loop can't fire an in-process timer. */
export function startStartupWatchdog({
  dataDir,
  ownDir = fileURLToPath(new URL('..', import.meta.url)),
  watcherPath = join(ownDir, 'dist', 'upgrade', 'startup-watcher.cjs'),
  deadlineMs = Number(process.env.HARMONIC_STARTUP_DEADLINE_MS ?? 300_000),
  spawnWatcher = spawn,
}: {
  dataDir: string;
  ownDir?: string;
  watcherPath?: string;
  deadlineMs?: number;
  spawnWatcher?: typeof spawn;
}): () => void {
  const appDir = join(dataDir, 'app');
  const pending = readPending({ appDir });
  if (!pending) return () => {};
  const runningVersion = readInstalledVersion({ dir: ownDir, readFile: readFileSync });
  if (pending.version !== runningVersion) return () => {};
  touchStartupProgress(dataDir);
  if (!existsSync(watcherPath)) {
    logger.warn(`Startup watchdog: no out-of-process watcher at ${watcherPath}; a synchronous startup hang will not be caught.`);
    return () => {};
  }
  let watcher: ReturnType<typeof spawn>;
  try {
    watcher = spawnWatcher(
      process.execPath,
      [watcherPath, dataDir, String(process.pid), runningVersion, String(deadlineMs)],
      // stderr inherited so the watcher's kill explanation reaches the journal under systemd.
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    watcher.unref();
  } catch (error) {
    logger.warn(`Startup watchdog: failed to spawn the out-of-process watcher: ${error instanceof Error ? error.message : String(error)}`);
    return () => {};
  }
  return () => { watcher.kill(); };
}

export async function runServer(values: ServeValues, rest: string[]): Promise<CliOutcome> {
  const dataDir = values['data-dir'] ?? defaultDataDir();
  beginBootProgress(dataDir);
  const clearStartupWatchdog = startStartupWatchdog({ dataDir });
  const port = Number(values.port);
  const host = values.host!;
  const installMode: InstallMode = resolveInstallMode({
    env: process.env,
    dataDir,
    cliPath: process.argv[1] ?? fileURLToPath(import.meta.url),
    realpath: defaultRealpath,
    isWritable: defaultIsWritable,
  });
  const migrationRequired = installMode.kind === 'migration-required';
  if (migrationRequired) logger.warn(SYSTEMD_MIGRATION_NOTICE);
  const holder = acquireLock(dataDir, { port, host });
  if (holder) {
    logger.error(
      `Another Harmonic instance is using ${dataDir} (pid ${holder.pid}, ${displayUrl(holder.host, holder.port)}).\n` +
        '  Stop it first (harmonic stop), or use a different --data-dir.',
    );
    clearStartupWatchdog();
    endBootProgress();
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
  // Only systemd/init.d installs manage a versioned `app/` directory to self-upgrade into.
  const selfUpgrading = installMode.kind === 'systemd' || installMode.kind === 'initd';
  const guardMissing = installMode.kind === 'systemd'
    ? await reconcileSystemdGuardRevision({
      systemUnitPath: '/etc/systemd/system/harmonic.service',
      userUnitPath: join(homedir(), '.config', 'systemd', 'user', 'harmonic.service'),
      fileExists: existsSync,
      readFile: (path) => readFileSync(path, 'utf8'),
      ensureUserUnitCurrent: () =>
        createServiceManager({ platform: process.platform, isRoot: false, systemdRunning: false, initdAvailable: false, userSystemdUsable: true })
          .ensureUnitRevisionCurrent?.(),
      warn: logger.warn,
    })
    : false;
  try {
    app = await buildApp({
      dataDir,
      password,
      migrationRequired,
      installMode,
      guardMissing,
      metricsSummary: { intervalMs: telemetryOptions.metricExportIntervalMillis, flush: () => telemetry.flushMetricSummary() },
      ...(selfUpgrading ? {
        readRollback: () => readRollback({ appDir: join(dataDir, 'app') }) ?? undefined,
        clearRollback: () => { clearRollback({ appDir: join(dataDir, 'app') }); },
        onUpgradeIdle: async (version: string, cancellation: UpgradeCancellation) => {
          const swap = new UpgradeSwap({
            cancellation,
            ...(process.env.HARMONIC_MANAGED_BY === undefined ? {} : { managedBy: process.env.HARMONIC_MANAGED_BY }),
            install: async (target) => {
              await installManagedUpgrade({
                dataDir,
                target,
                run: async (file, args) => execFileAsync(file, args),
              });
            },
            verify: async (target) => {
              await verifyInstall({
                dir: join(dataDir, 'app', 'versions', target),
                version: target,
                dependencies: {
                  fileExists: existsSync,
                  readFile: readFileSync,
                  readlink: (path) => {
                    try {
                      return readlinkSync(path);
                    } catch {
                      return null;
                    }
                  },
                },
              });
            },
            commit: async (target) => {
              const appDir = join(dataDir, 'app');
              // `current` still points at the running version here — the flip below hasn't happened yet.
              const previous = readManagedInstalledVersion({ dataDir, readlink: readlinkSync, fileExists: existsSync });
              const snapshot = await snapshotDatabase({ dataDir, version: target });
              writePending({ appDir, version: target, previous, snapshot });
              flipCurrent({ appDir, version: target });
            },
            spawnRelauncher: async () => {
              const relauncher = fileURLToPath(new URL('./upgrade/relauncher.js', import.meta.url));
              const child = spawn(process.execPath, [relauncher, dataDir, JSON.stringify(rest)], {
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
          if (outcome.kind === 'cancelled' || outcome.kind === 'idle-timeout') return outcome.kind;
        },
      } : {}),
    });
  } catch (error) {
    clearStartupWatchdog();
    endBootProgress();
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
  clearStartupWatchdog();
  logger.info(`Harmonic listening on ${displayUrl(host, port)} (bound to ${host}, data: ${dataDir})`);

  if (selfUpgrading) {
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
  endBootProgress();

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

/** Always drops the data-dir lock and exits, even on a `close`/`shutdownTelemetry` failure or timeout, so a botched shutdown never leaves a dead-but-listening process holding the lock. */
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
