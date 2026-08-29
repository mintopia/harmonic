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

/**
 * Claim the data-dir lock for this (serve) process. Returns the live holder's
 * info if another running process already owns the pidfile — the caller must
 * refuse to boot rather than run crash recovery and stomp the other instance.
 * A lock from a dead process, or one we already own (the pid `start` wrote for
 * us), is reclaimed; on success returns null and the pidfile names us.
 */
export function acquireLock(dataDir: string, self: { port: number; host: string }): DaemonInfo | null {
  mkdirSync(dataDir, { recursive: true });
  const path = pidFilePath(dataDir);
  const info: DaemonInfo = { pid: process.pid, port: self.port, host: self.host, startedAt: Date.now() };
  // O_EXCL makes the create itself the exclusivity check: with a fresh dir, only
  // one of two racing `serve`s can win it. A losing create means someone got
  // there first — read what they left and only clear it (stale pid, or ours
  // from the `start` parent) before retrying, never blind-overwrite.
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
      // Another reclaimer beat us to the unlink; loop and re-check.
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
    // Give shutdown handlers enough time to flush OTLP batches before the
    // SIGKILL fallback. The telemetry exporters default to a 30-second timeout.
    for (let i = 0; i < 400 && isAlive(info.pid); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isAlive(info.pid)) process.kill(info.pid, 'SIGKILL');
  }
  if (existsSync(pidFilePath(dataDir))) rmSync(pidFilePath(dataDir));
  return running;
}
