import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What `harmonic start` records so status/stop can find the server later. */
export interface DaemonInfo {
  pid: number;
  port: number;
  host: string;
  startedAt: number;
}

export const pidFilePath = (dataDir: string): string => join(dataDir, 'harmonic.pid');
export const logFilePath = (dataDir: string): string => join(dataDir, 'harmonic.log');

export function writeDaemon(dataDir: string, info: DaemonInfo): void {
  writeFileSync(pidFilePath(dataDir), JSON.stringify(info));
}

function readDaemon(dataDir: string): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(pidFilePath(dataDir), 'utf8')) as DaemonInfo;
  } catch {
    return null;
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A stale pidfile (process gone) counts as stopped. */
export function daemonStatus(dataDir: string): { running: boolean; info: DaemonInfo | null } {
  const info = readDaemon(dataDir);
  if (!info) return { running: false, info: null };
  return { running: isAlive(info.pid), info };
}

/** SIGTERM the daemon and clear the pidfile. False when nothing was running. */
export async function stopDaemon(dataDir: string): Promise<boolean> {
  const { running, info } = daemonStatus(dataDir);
  if (!info) return false;
  if (running) {
    process.kill(info.pid, 'SIGTERM');
    for (let i = 0; i < 50 && isAlive(info.pid); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isAlive(info.pid)) process.kill(info.pid, 'SIGKILL');
  }
  if (existsSync(pidFilePath(dataDir))) rmSync(pidFilePath(dataDir));
  return running;
}
