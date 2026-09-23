import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonStatus, logFilePath } from '../daemon.js';
import { logger } from '../logger.js';
import { startOperation } from '../telemetry/operations.js';

function appendToDataDirLog(dataDir: string, line: string): void {
  try {
    appendFileSync(logFilePath(dataDir), `${new Date().toISOString()} ${line}\n`);
  } catch (error) {
    logger.warn('relauncher: failed to write data-dir log', { dataDir, error: error instanceof Error ? error.message : String(error) });
  }
}

export interface LaunchedProcess {
  pid: number | undefined;
  onExit(callback: () => void): void;
  kill(signal: NodeJS.Signals): void;
}

export interface RelauncherDependencies {
  isLocked(dataDir: string): boolean;
  wait(milliseconds: number): Promise<void>;
  runGuard(dataDir: string): void;
  launch(input: { dataDir: string; serveArgs: string[] }): LaunchedProcess;
  isPending(dataDir: string): boolean;
}

const productionDependencies: RelauncherDependencies = {
  isLocked: (dataDir) => daemonStatus(dataDir).running,
  wait: (milliseconds) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); }),
  runGuard: (dataDir) => {
    const guardPath = join(dataDir, 'app', 'boot-guard.cjs');
    if (!existsSync(guardPath)) return;
    try {
      spawnSync(process.execPath, [guardPath, dataDir], { stdio: 'ignore' });
    } catch (error) {
      logger.warn('relauncher: boot guard failed to run', { dataDir, error: error instanceof Error ? error.message : String(error) });
    }
  },
  launch: ({ dataDir, serveArgs }) => {
    const log = openSync(logFilePath(dataDir), 'a');
    const cliPath = join(dataDir, 'app', 'current', 'dist', 'cli.js');
    const child = spawn(process.execPath, [cliPath, 'serve', ...serveArgs], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.unref();
    return {
      pid: child.pid,
      onExit: (callback) => { child.once('exit', callback); },
      kill: (signal) => { child.kill(signal); },
    };
  },
  isPending: (dataDir) => existsSync(join(dataDir, 'app', 'pending.json')),
};

async function waitForLockRelease({
  dataDir,
  serveArgs,
  isLocked,
  wait,
  pollMs,
  maxWaitMs,
}: {
  dataDir: string;
  serveArgs: string[];
  isLocked: RelauncherDependencies['isLocked'];
  wait: RelauncherDependencies['wait'];
  pollMs: number;
  maxWaitMs: number;
}): Promise<void> {
  const operation = startOperation({ type: 'upgrade.relauncher.wait', attributes: { 'upgrade.data_dir': dataDir } });
  try {
    let waitedMs = 0;
    while (isLocked(dataDir)) {
      if (waitedMs >= maxWaitMs) {
        throw new Error(`gave up waiting for upgrade lock release on ${dataDir} after ${maxWaitMs}ms`);
      }
      logger.info('waiting for upgrade lock release', { dataDir });
      await wait(pollMs);
      waitedMs += pollMs;
    }
    operation.end();
  } catch (error) {
    operation.fail(error);
    const cliPath = join(dataDir, 'app', 'current', 'dist', 'cli.js');
    appendToDataDirLog(
      dataDir,
      `ERROR upgrade relauncher gave up waiting for the upgrade lock: ${error instanceof Error ? error.message : String(error)}. ` +
        `Harmonic was NOT restarted. Start it manually: ${process.execPath} ${cliPath} serve ${serveArgs.join(' ')}`,
    );
    throw error;
  }
}

type RoundOutcome = 'pending-cleared' | 'process-exited' | 'timed-out';

async function waitForRoundOutcome({
  dataDir,
  child,
  isPending,
  wait,
  pollMs,
  maxWaitMs,
}: {
  dataDir: string;
  child: LaunchedProcess;
  isPending: RelauncherDependencies['isPending'];
  wait: RelauncherDependencies['wait'];
  pollMs: number;
  maxWaitMs: number;
}): Promise<RoundOutcome> {
  let exited = false;
  child.onExit(() => { exited = true; });

  let waitedMs = 0;
  for (;;) {
    if (!isPending(dataDir)) return 'pending-cleared';
    if (exited) return 'process-exited';
    if (waitedMs >= maxWaitMs) return 'timed-out';
    await wait(pollMs);
    waitedMs += pollMs;
  }
}

export interface RelaunchOptions {
  dataDir: string;
  serveArgs: string[];
  maxRounds?: number;
  lockPollMs?: number;
  lockMaxWaitMs?: number;
  roundPollMs?: number;
  roundWaitMs?: number;
  killGraceMs?: number;
  dependencies?: RelauncherDependencies;
}

/** Terminates a child that timed out without booting: SIGTERM, then SIGKILL if it hasn't exited after `graceMs`. */
async function killHungChild({
  child,
  wait,
  graceMs,
}: {
  child: LaunchedProcess;
  wait: RelauncherDependencies['wait'];
  graceMs: number;
}): Promise<void> {
  let exited = false;
  child.onExit(() => { exited = true; });
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  await wait(graceMs);
  if (!exited) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }
}

/**
 * Waits for the exiting process to release the upgrade lock, then drives up to `maxRounds` of
 * [boot guard, launch, wait for the boot to clear `pending.json`, die, or time out] — the boot
 * guard flips `current` back to the previous version and restores its DB snapshot once it has seen
 * enough failed boots, so a broken release self-heals within this loop rather than crash-looping
 * forever. A round that times out (the startup watchdog inside the child should have already fired,
 * but nothing here depends on that) is killed and counted as a failed boot like a round that exits
 * on its own, so a release that hangs instead of crashing still rolls back.
 */
export async function relaunchWithBootGuard({
  dataDir,
  serveArgs,
  maxRounds = 4,
  lockPollMs = 100,
  lockMaxWaitMs = 5 * 60 * 1000,
  roundPollMs = 200,
  roundWaitMs = 60_000,
  killGraceMs = 5_000,
  dependencies = productionDependencies,
}: RelaunchOptions): Promise<void> {
  await waitForLockRelease({
    dataDir,
    serveArgs,
    isLocked: dependencies.isLocked,
    wait: dependencies.wait,
    pollMs: lockPollMs,
    maxWaitMs: lockMaxWaitMs,
  });

  for (let round = 1; round <= maxRounds; round++) {
    dependencies.runGuard(dataDir);

    const launchOperation = startOperation({ type: 'upgrade.relauncher.launch', attributes: { 'upgrade.data_dir': dataDir, 'upgrade.round': round } });
    let child: LaunchedProcess;
    try {
      child = dependencies.launch({ dataDir, serveArgs });
      launchOperation.end();
    } catch (error) {
      launchOperation.fail(error);
      appendToDataDirLog(dataDir, `relauncher round ${round}: failed to launch: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    appendToDataDirLog(dataDir, `relauncher round ${round}: started pid ${child.pid ?? 'unknown'}`);

    const outcome = await waitForRoundOutcome({
      dataDir,
      child,
      isPending: dependencies.isPending,
      wait: dependencies.wait,
      pollMs: roundPollMs,
      maxWaitMs: roundWaitMs,
    });
    appendToDataDirLog(dataDir, `relauncher round ${round}: ${outcome}`);

    if (outcome === 'pending-cleared') {
      appendToDataDirLog(dataDir, `relauncher finished after round ${round} (${outcome})`);
      return;
    }
    if (outcome === 'timed-out') {
      appendToDataDirLog(dataDir, `relauncher round ${round}: timed out waiting for boot; terminating hung child pid ${child.pid ?? 'unknown'}`);
      await killHungChild({ child, wait: dependencies.wait, graceMs: killGraceMs });
    }
  }
  appendToDataDirLog(dataDir, `relauncher gave up after ${maxRounds} rounds without a healthy boot`);
}

async function main(): Promise<void> {
  const [dataDir, encodedArgs] = process.argv.slice(2);
  if (!dataDir || encodedArgs === undefined) {
    throw new Error('relauncher requires a data directory and serve arguments');
  }
  const parsed: unknown = JSON.parse(encodedArgs);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('relauncher serve arguments must be strings');
  }
  const lockMaxWaitMs = process.env.HARMONIC_RELAUNCHER_MAX_WAIT_MS;
  const lockPollMs = process.env.HARMONIC_RELAUNCHER_POLL_MS;
  const roundWaitMs = process.env.HARMONIC_RELAUNCHER_ROUND_WAIT_MS;
  const killGraceMs = process.env.HARMONIC_RELAUNCHER_KILL_GRACE_MS;
  await relaunchWithBootGuard({
    dataDir,
    serveArgs: parsed,
    ...(lockMaxWaitMs === undefined ? {} : { lockMaxWaitMs: Number(lockMaxWaitMs) }),
    ...(lockPollMs === undefined ? {} : { lockPollMs: Number(lockPollMs) }),
    ...(roundWaitMs === undefined ? {} : { roundWaitMs: Number(roundWaitMs) }),
    ...(killGraceMs === undefined ? {} : { killGraceMs: Number(killGraceMs) }),
  });
}

function isEntryPoint(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return argvPath === modulePath;
  }
}

if (isEntryPoint()) {
  void main().catch((error: unknown) => {
    logger.error(`upgrade relauncher failed: ${String(error)}`);
    process.exitCode = 1;
  });
}
