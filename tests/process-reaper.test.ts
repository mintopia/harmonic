import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ProcGroupReaper, readProcStartToken, readSelfPgid, reapTargets, type ProcessStart } from '../src/execution/process-reaper.js';
import { waitFor } from './helpers.js';

const spawnedChildren: ChildProcess[] = [];

/** Reap from a process started after the group, as a post-crash boot would. */
async function reapInFreshProcess(identity: { pgid: number; startToken: string }): Promise<string> {
  const reaperUrl = pathToFileURL(fileURLToPath(new URL('../src/execution/process-reaper.ts', import.meta.url))).href;
  const script = [
    `import { ProcGroupReaper } from '${reaperUrl}';`,
    `console.log(await new ProcGroupReaper().reap(${JSON.stringify(identity)}, { termGraceMs: 2000, pollMs: 25 }));`,
  ].join('\n');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  await once(child, 'exit');
  return stdout.trim();
}

const spawnOrphan = (script = 'setInterval(() => {}, 1e9)'): ChildProcess => {
  const child = spawn(process.execPath, ['-e', script], { detached: true });
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
    const outcome = await reaper.reap({ pgid: pid, startToken }, { termGraceMs: 2000, pollMs: 25 });

    expect(outcome).toBe('reaped');
    expect(readProcStartToken(pid)).toBeNull();
  });

  it('refuses a reused pid whose /proc identity no longer matches (fail closed)', async () => {
    const child = spawnOrphan();
    const pid = child.pid!;

    const reaper = new ProcGroupReaper();
    const outcome = await reaper.reap({ pgid: pid, startToken: '999999999' }, { termGraceMs: 200, pollMs: 25 });

    expect(outcome).toBe('identity-mismatch');
    expect(readProcStartToken(pid)).not.toBeNull();
  });

  it('never targets the daemon\'s own process group', async () => {
    const reaper = new ProcGroupReaper();
    const startToken = readProcStartToken(process.pid)!;

    const outcome = await reaper.reap({ pgid: readSelfPgid(), startToken });

    expect(outcome).toBe('refused-self-group');
    expect(readProcStartToken(process.pid)).not.toBeNull();
  });

  it('reaps the surviving grandchild of a group whose leader already exited', async () => {
    const pidFile = join(tmpdir(), `harmonic-leaderless-${process.pid}-${Date.now()}.pid`);
    const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' }); c.unref(); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => process.exit(0), 300);`;
    const leader = spawnOrphan(script);
    const pgid = leader.pid!;
    const startToken = readProcStartToken(pgid)!;
    const grandchild = await waitFor(async () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined));
    await waitFor(async () => (readProcStartToken(pgid) === null ? true : undefined));
    expect(readProcStartToken(grandchild)).not.toBeNull();

    expect(await reapInFreshProcess({ pgid, startToken })).toBe('reaped');
    await waitFor(async () => (readProcStartToken(grandchild) === null ? true : undefined));
  });
});

describe('reapTargets', () => {
  const recorded = { pgid: 500, start: 1_000 };
  const selfStart = 5_000;
  const proc = (pid: number, pgid: number, start: number): ProcessStart => ({ pid, pgid, start });

  it('takes the whole group when the recorded leader is still alive', () => {
    const table = [proc(500, 500, 1_000), proc(501, 500, 1_200), proc(900, 900, 100)];
    expect(reapTargets(recorded, table, selfStart)).toEqual({ kind: 'reap', members: [proc(500, 500, 1_000), proc(501, 500, 1_200)] });
  });

  it('skips a reused pgid whose live leader started at a different time', () => {
    const table = [proc(500, 500, 7_000), proc(501, 500, 7_100)];
    expect(reapTargets(recorded, table, selfStart)).toEqual({ kind: 'skip', outcome: 'identity-mismatch' });
  });

  it('skips a leaderless member that started after this boot', () => {
    expect(reapTargets(recorded, [proc(501, 500, 6_000)], selfStart)).toEqual({ kind: 'skip', outcome: 'identity-mismatch' });
  });

  it('skips a leaderless member that started before the recorded leader', () => {
    expect(reapTargets(recorded, [proc(501, 500, 900)], selfStart)).toEqual({ kind: 'skip', outcome: 'identity-mismatch' });
  });

  it('reaps leaderless members that started between the leader and this boot', () => {
    const table = [proc(501, 500, 1_000), proc(502, 500, 4_999), proc(503, 500, 6_000)];
    expect(reapTargets(recorded, table, selfStart)).toEqual({ kind: 'reap', members: [proc(501, 500, 1_000), proc(502, 500, 4_999)] });
  });

  it('reports not-running when nothing is left in the group', () => {
    expect(reapTargets(recorded, [proc(900, 900, 100)], selfStart)).toEqual({ kind: 'skip', outcome: 'not-running' });
  });
});
