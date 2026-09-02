import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { ProcGroupReaper, readProcStartToken, readSelfPgid } from '../src/execution/process-reaper.js';

const spawnedChildren: ChildProcess[] = [];

const spawnOrphan = (): ChildProcess => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { detached: true });
  spawnedChildren.push(child);
  return child;
};

afterEach(() => {
  while (spawnedChildren.length > 0) {
    const child = spawnedChildren.pop()!;
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
});

describe('ProcGroupReaper', () => {
  it('reaps a live orphan group', async () => {
    const child = spawnOrphan();
    const pid = child.pid!;
    const startToken = readProcStartToken(pid)!;
    expect(startToken).not.toBeNull();

    const reaper = new ProcGroupReaper();
    const outcome = await reaper.reap({ pid, pgid: pid, startToken }, { termGraceMs: 2000, pollMs: 25 });

    expect(outcome).toBe('reaped');
    expect(readProcStartToken(pid)).toBeNull();
  });

  it('refuses a reused pid whose /proc identity no longer matches (fail closed)', async () => {
    const child = spawnOrphan();
    const pid = child.pid!;

    const reaper = new ProcGroupReaper();
    const outcome = await reaper.reap({ pid, pgid: pid, startToken: '999999999' }, { termGraceMs: 200, pollMs: 25 });

    expect(outcome).toBe('identity-mismatch');
    expect(readProcStartToken(pid)).not.toBeNull();
  });

  it('never targets the daemon\'s own process group', async () => {
    const reaper = new ProcGroupReaper();
    const startToken = readProcStartToken(process.pid)!;

    const outcome = await reaper.reap({ pid: process.pid, pgid: readSelfPgid(), startToken });

    expect(outcome).toBe('refused-self-group');
    expect(readProcStartToken(process.pid)).not.toBeNull();
  });
});
