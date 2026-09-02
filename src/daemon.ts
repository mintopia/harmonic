import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
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

/** Claim the data-dir lock; returns the live holder's info if another running process owns the pidfile, else null. A dead or self-owned lock is reclaimed. */
export function acquireLock(dataDir: string, self: { port: number; host: string }): DaemonInfo | null {
  mkdirSync(dataDir, { recursive: true });
  const path = pidFilePath(dataDir);
  const info: DaemonInfo = { pid: process.pid, port: self.port, host: self.host, startedAt: Date.now() };
  // 'wx' (O_EXCL) makes the create itself the exclusivity check; a losing create only clears a stale or self-owned pid before retrying.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const existing = readDaemon(dataDir);
    if (existing && existing.pid !== process.pid && isAlive(existing.pid)) return existing;
    try {
      unlinkSync(path);
    } catch {
    }
  }
  return readDaemon(dataDir);
}

/** Drop the lock if it's ours (SIGKILL leaves it stale, reclaimed next boot). */
export function releaseLock(dataDir: string): void {
  const info = readDaemon(dataDir);
  if (info?.pid === process.pid && existsSync(pidFilePath(dataDir))) rmSync(pidFilePath(dataDir));
}

/** SIGTERM the daemon and clear the pidfile. False when nothing was running. */
export async function stopDaemon(dataDir: string): Promise<boolean> {
  const { running, info } = daemonStatus(dataDir);
  if (!info) return false;
  if (running) {
    process.kill(info.pid, 'SIGTERM');
    // OTLP exporters default to a 30-second flush timeout; wait that out before the SIGKILL fallback.
    for (let i = 0; i < 400 && isAlive(info.pid); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isAlive(info.pid)) process.kill(info.pid, 'SIGKILL');
  }
  if (existsSync(pidFilePath(dataDir))) rmSync(pidFilePath(dataDir));
  return running;
}
