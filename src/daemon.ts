import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // ponytail: non-atomic read-then-write; two `serve`s launched on the same
  // fresh dir at once could both win. Fine for a local single-user tool (and
  // `start` is already shielded by its own status check); switch to an O_EXCL
  // create with stale reclaim if simultaneous boots ever matter.
  const existing = readDaemon(dataDir);
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) return existing;
  mkdirSync(dataDir, { recursive: true });
  writeDaemon(dataDir, { pid: process.pid, port: self.port, host: self.host, startedAt: Date.now() });
  return null;
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
