import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTempDirTracker } from './helpers/upgrade-fixture.js';

const { tempDir, cleanupAll } = createTempDirTracker();
const fixturePath = fileURLToPath(new URL('./fixtures/startup-watchdog-hang.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ownVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const runningChildren: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  while (runningChildren.length > 0) runningChildren.pop()?.kill('SIGKILL');
  cleanupAll();
});

function join(...segments: string[]): string {
  return segments.join('/');
}

function spawnFixture(dataDir: string, deadlineMs: number): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fixturePath, dataDir],
    { cwd: repoRoot, stdio: 'pipe', env: { ...process.env, HARMONIC_STARTUP_DEADLINE_MS: String(deadlineMs) } },
  );
  runningChildren.push(child);
  return child;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for exit')), timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function waitForArmed(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture never armed the watchdog')), 20_000);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('armed\n')) { clearTimeout(timer); resolve(); }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

describe('startup watchdog (real process)', () => {
  it('exits non-zero within the deadline when pending.json names this process own version and it never listens', async () => {
    const dataDir = tempDir('startup-watchdog-hung-');
    mkdirSync(join(dataDir, 'app'), { recursive: true });
    writeFileSync(
      join(dataDir, 'app', 'pending.json'),
      JSON.stringify({ version: ownVersion, previous: '0.0.0', snapshot: join(dataDir, 'app', 'pre.db'), boots: 0 }),
    );

    const child = spawnFixture(dataDir, 300);
    const exited = waitForExit(child, 25_000);
    await waitForArmed(child);
    const code = await exited;

    expect(code).not.toBe(0);
  }, 30_000);

  it('stays running past the deadline when no pending.json names this process own version', async () => {
    const dataDir = tempDir('startup-watchdog-idle-');
    mkdirSync(join(dataDir, 'app'), { recursive: true });

    const child = spawnFixture(dataDir, 300);
    await waitForArmed(child);
    await sleep(1_200);

    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);
  }, 30_000);
});
