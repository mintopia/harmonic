import { spawn } from 'node:child_process';
import { appendFileSync, openSync, realpathSync } from 'node:fs';
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

export interface RelauncherDependencies {
  isLocked(dataDir: string): boolean;
  wait(milliseconds: number): Promise<void>;
  launch(input: { dataDir: string; cliPath: string; serveArgs: string[] }): number | undefined;
}

const productionDependencies: RelauncherDependencies = {
  isLocked: (dataDir) => daemonStatus(dataDir).running,
  wait: (milliseconds) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); }),
  launch: ({ dataDir, cliPath, serveArgs }) => {
    const log = openSync(logFilePath(dataDir), 'a');
    const child = spawn(process.execPath, [cliPath, 'serve', ...serveArgs], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.unref();
    return child.pid;
  },
};

export async function relaunchWhenLockIsFree({
  dataDir,
  cliPath,
  serveArgs,
  pollMs = 100,
  maxWaitMs = 5 * 60 * 1000,
  dependencies = productionDependencies,
}: {
  dataDir: string;
  cliPath: string;
  serveArgs: string[];
  pollMs?: number;
  maxWaitMs?: number;
  dependencies?: RelauncherDependencies;
}): Promise<void> {
  const wait = startOperation({ type: 'upgrade.relauncher.wait', attributes: { 'upgrade.data_dir': dataDir } });
  try {
    let waitedMs = 0;
    while (dependencies.isLocked(dataDir)) {
      if (waitedMs >= maxWaitMs) {
        throw new Error(`gave up waiting for upgrade lock release on ${dataDir} after ${maxWaitMs}ms`);
      }
      logger.info('waiting for upgrade lock release', { dataDir });
      await dependencies.wait(pollMs);
      waitedMs += pollMs;
    }
    wait.end();
  } catch (error) {
    wait.fail(error);
    appendToDataDirLog(
      dataDir,
      `ERROR upgrade relauncher gave up waiting for the upgrade lock: ${error instanceof Error ? error.message : String(error)}. ` +
        `Harmonic was NOT restarted. Start it manually: ${process.execPath} ${cliPath} serve ${serveArgs.join(' ')}`,
    );
    throw error;
  }
  const launch = startOperation({ type: 'upgrade.relauncher.launch', attributes: { 'upgrade.data_dir': dataDir } });
  try {
    const pid = dependencies.launch({ dataDir, cliPath, serveArgs });
    logger.info('started upgraded Harmonic service', { dataDir, pid });
    appendToDataDirLog(dataDir, `started upgraded Harmonic service (pid ${pid ?? 'unknown'})`);
    launch.end();
  } catch (error) {
    launch.fail(error);
    appendToDataDirLog(
      dataDir,
      `ERROR upgrade relauncher failed to launch the upgraded service: ${error instanceof Error ? error.message : String(error)}. ` +
        `Harmonic was NOT restarted. Start it manually: ${process.execPath} ${cliPath} serve ${serveArgs.join(' ')}`,
    );
    throw error;
  }
}

async function main(): Promise<void> {
  const [dataDir, cliPath, encodedArgs] = process.argv.slice(2);
  if (!dataDir || !cliPath || !encodedArgs) throw new Error('relauncher requires data directory, CLI path, and serve arguments');
  const parsed: unknown = JSON.parse(encodedArgs);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('relauncher serve arguments must be strings');
  }
  const maxWaitMs = process.env.HARMONIC_RELAUNCHER_MAX_WAIT_MS;
  const pollMs = process.env.HARMONIC_RELAUNCHER_POLL_MS;
  await relaunchWhenLockIsFree({
    dataDir,
    cliPath,
    serveArgs: parsed,
    ...(maxWaitMs === undefined ? {} : { maxWaitMs: Number(maxWaitMs) }),
    ...(pollMs === undefined ? {} : { pollMs: Number(pollMs) }),
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
