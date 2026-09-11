import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { daemonStatus, logFilePath } from '../daemon.js';
import { logger } from '../logger.js';
import { startOperation } from '../telemetry/operations.js';

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
  dependencies = productionDependencies,
}: {
  dataDir: string;
  cliPath: string;
  serveArgs: string[];
  pollMs?: number;
  dependencies?: RelauncherDependencies;
}): Promise<void> {
  const wait = startOperation({ type: 'upgrade.relauncher.wait', attributes: { 'upgrade.data_dir': dataDir } });
  try {
    while (dependencies.isLocked(dataDir)) {
      logger.info('waiting for upgrade lock release', { dataDir });
      await dependencies.wait(pollMs);
    }
    wait.end();
  } catch (error) {
    wait.fail(error);
    throw error;
  }
  const launch = startOperation({ type: 'upgrade.relauncher.launch', attributes: { 'upgrade.data_dir': dataDir } });
  try {
    const pid = dependencies.launch({ dataDir, cliPath, serveArgs });
    logger.info('started upgraded Harmonic service', { dataDir, pid });
    launch.end();
  } catch (error) {
    launch.fail(error);
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
  await relaunchWhenLockIsFree({ dataDir, cliPath, serveArgs: parsed });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  void main().catch((error: unknown) => {
    logger.error(`upgrade relauncher failed: ${String(error)}`);
    process.exitCode = 1;
  });
}
