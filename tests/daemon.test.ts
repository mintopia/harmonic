import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const freshDir = () => mkdtempSync(join(tmpdir(), 'harmonic-daemon-'));

const info = (pid: number): DaemonInfo => ({
  pid,
  port: 4700,
  host: '0.0.0.0',
  startedAt: Date.now(),
});

/** A child that exits immediately — a guaranteed-dead pid once awaited. */
const deadPid = () =>
  new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.on('exit', () => resolve(child.pid!));
  });

/** A child that sticks around until killed. */
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

  it('release drops the lock only when we own it', () => {
    const dir = freshDir();
    acquireLock(dir, { port: 4700, host: '0.0.0.0' });
    releaseLock(dir);
    expect(existsSync(pidFilePath(dir))).toBe(false);
    // A lock owned by someone else survives our release.
    writeDaemon(dir, info(999999));
    releaseLock(dir);
    expect(existsSync(pidFilePath(dir))).toBe(true);
  });
});
