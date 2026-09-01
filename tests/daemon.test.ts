import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {
  acquireLock,
  daemonStatus,
  releaseLock,
  writeDaemon,
  stopDaemon,
  pidFilePath,
  type DaemonInfo,
} from '../src/daemon.js';

const daemonUrl = pathToFileURL(new URL('../src/daemon.ts', import.meta.url).pathname).href;

const raceClaim = (dir: string, port: number) => {
  const script = [
    `import { acquireLock } from '${daemonUrl}';`,
    `const holder = acquireLock(${JSON.stringify(dir)}, { port: ${port}, host: '0.0.0.0' });`,
    `console.log(JSON.stringify(holder));`,
    `if (holder === null) await new Promise((resolve) => setTimeout(resolve, 500));`,
  ].join('\n');
  return new Promise<{ pid: number | undefined; holder: DaemonInfo | null }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      stdio: 'pipe',
    });
    let stdout = '';
    let resolved = false;
    child.on('exit', (code) => {
      if (!resolved && code !== 0) reject(new Error(`race claimant exited ${code}`));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const line = stdout.split('\n').find((l) => l.trim() !== '');
      if (line !== undefined && !resolved) {
        resolved = true;
        resolve({ pid: child.pid, holder: JSON.parse(line) as DaemonInfo | null });
      }
    });
  });
};

const freshDir = () => mkdtempSync(join(tmpdir(), 'harmonic-daemon-'));

const info = (pid: number): DaemonInfo => ({
  pid,
  port: 4700,
  host: '0.0.0.0',
  startedAt: Date.now(),
});

const deadPid = () =>
  new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.on('exit', () => resolve(child.pid!));
  });

const livePid = () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  return {
    pid: child.pid!,
    exited: new Promise<void>((resolve) => child.on('exit', () => resolve())),
  };
};

describe('daemon pidfile lifecycle', () => {
  it('reports stopped when nothing was ever started', () => {
    expect(daemonStatus(freshDir())).toEqual({ running: false, info: null });
  });

  it('reports running for a live pid and round-trips the info', () => {
    const dir = freshDir();
    const written = info(process.pid);
    writeDaemon(dir, written);
    expect(daemonStatus(dir)).toEqual({ running: true, info: written });
  });

  it('reports stopped for a stale pidfile whose process is gone', async () => {
    const dir = freshDir();
    writeDaemon(dir, info(await deadPid()));
    expect(daemonStatus(dir).running).toBe(false);
  });

  it('stop kills the process and clears the pidfile', async () => {
    const dir = freshDir();
    const child = livePid();
    writeDaemon(dir, info(child.pid));
    expect(await stopDaemon(dir)).toBe(true);
    await child.exited;
    expect(existsSync(pidFilePath(dir))).toBe(false);
    expect(daemonStatus(dir).running).toBe(false);
  });

  it('stop on a non-running daemon returns false', async () => {
    expect(await stopDaemon(freshDir())).toBe(false);
  });
});

describe('data-dir lock', () => {
  it('claims a free dir and records this process', () => {
    const dir = freshDir();
    expect(acquireLock(dir, { port: 4700, host: '0.0.0.0' })).toBeNull();
    expect(daemonStatus(dir).info?.pid).toBe(process.pid);
  });

  it('refuses when a live process holds the lock, naming the holder', async () => {
    const dir = freshDir();
    const child = livePid();
    writeDaemon(dir, info(child.pid));
    const holder = acquireLock(dir, { port: 4800, host: '0.0.0.0' });
    expect(holder?.pid).toBe(child.pid);
    expect(holder?.port).toBe(4700);
    await stopDaemon(dir);
    await child.exited;
  });

  it('reclaims its own lock (the pid `start` wrote for the serve child)', () => {
    const dir = freshDir();
    writeDaemon(dir, info(process.pid));
    expect(acquireLock(dir, { port: 4700, host: '0.0.0.0' })).toBeNull();
  });

  it('reclaims a stale lock left by a dead process', async () => {
    const dir = freshDir();
    writeDaemon(dir, info(await deadPid()));
    expect(acquireLock(dir, { port: 4700, host: '0.0.0.0' })).toBeNull();
    expect(daemonStatus(dir).info?.pid).toBe(process.pid);
  });

  it('lets only one of two genuinely racing processes claim a fresh dir', async () => {
    const dir = freshDir();
    const [a, b] = await Promise.all([raceClaim(dir, 4700), raceClaim(dir, 4800)]);
    const winners = [a, b].filter((result) => result.holder === null);
    const losers = [a, b].filter((result) => result.holder !== null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.holder!.pid).toBe(winners[0]!.pid);
    expect(daemonStatus(dir).info?.pid).toBe(winners[0]!.pid);
  });

  it('release drops the lock only when we own it', () => {
    const dir = freshDir();
    acquireLock(dir, { port: 4700, host: '0.0.0.0' });
    releaseLock(dir);
    expect(existsSync(pidFilePath(dir))).toBe(false);
    writeDaemon(dir, info(999999));
    releaseLock(dir);
    expect(existsSync(pidFilePath(dir))).toBe(true);
  });
});
