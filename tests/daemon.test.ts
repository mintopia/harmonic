import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { daemonStatus, writeDaemon, stopDaemon, pidFilePath, type DaemonInfo } from '../src/daemon.js';

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
