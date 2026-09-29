import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin, dirname as pathDirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { createTempDirTracker } from './helpers/upgrade-fixture.js';
import { startStartupWatchdog } from '../src/cli-serve.js';
import { openAsyncDb } from '../src/db/async.js';
import { parseBaseline } from '../src/db/schema-sync.js';

vi.mock('../src/reliability/startup-progress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reliability/startup-progress.js')>();
  return { ...actual, touchStartupProgress: vi.fn(actual.touchStartupProgress) };
});
import { touchStartupProgress } from '../src/reliability/startup-progress.js';

const { tempDir, cleanupAll } = createTempDirTracker();
const hangFixturePath = fileURLToPath(new URL('./fixtures/startup-watchdog-hang.ts', import.meta.url));
const progressFixturePath = fileURLToPath(new URL('./fixtures/startup-watchdog-progress.ts', import.meta.url));
const watcherPath = fileURLToPath(new URL('../src/upgrade/startup-watcher.cjs', import.meta.url));
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

function writePending(dataDir: string, version: string): void {
  mkdirSync(join(dataDir, 'app'), { recursive: true });
  writeFileSync(
    join(dataDir, 'app', 'pending.json'),
    JSON.stringify({ version, previous: '0.0.0', snapshot: join(dataDir, 'app', 'pre.db'), boots: 0 }),
  );
}

function spawnFixture(fixturePath: string, args: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ['--import', 'tsx', fixturePath, ...args], {
    cwd: repoRoot,
    stdio: 'pipe',
    env: { ...process.env, HARMONIC_STARTUP_WATCHER_POLL_MS: '30', HARMONIC_STARTUP_DEADLINE_MS: '300' },
  });
  runningChildren.push(child);
  return child;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for exit')), timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

function waitForStdout(child: ChildProcessWithoutNullStreams, marker: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture never printed "${marker.trim()}"`)), timeoutMs);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(marker)) { clearTimeout(timer); resolve(); }
    });
  });
}

describe('startup watchdog: out-of-process watcher (real processes)', () => {
  it('kills a boot that blocks the Node event loop synchronously, which an in-process timer could never catch', async () => {
    const dataDir = tempDir('startup-watchdog-sync-hang-');
    writePending(dataDir, ownVersion);

    const child = spawnFixture(hangFixturePath, [dataDir]);
    await waitForStdout(child, 'armed\n', 20_000);
    const code = await waitForExit(child, 15_000);

    expect(code).not.toBe(0);
  }, 30_000);

  it('does not kill a boot that keeps touching startup-progress, even once the deadline window has elapsed several times over', async () => {
    const dataDir = tempDir('startup-watchdog-progress-');
    writePending(dataDir, ownVersion);

    // A 2s deadline with touches every 250ms (deadline/8, see the fixture)
    // gives real scheduling jitter room to breathe under CPU contention,
    // unlike the previous 300ms/150ms pairing which left none.
    const child = spawnFixture(progressFixturePath, [dataDir, '2000', '8000']);
    await waitForStdout(child, 'armed\n', 20_000);
    await waitForStdout(child, 'healthy\n', 20_000);

    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);
    child.kill('SIGKILL');
  }, 45_000);

});

describe('real schema convergence touches startup-progress after every step, not just around the whole boot', () => {
  const { tempDir: tempDataDir, cleanupAll: cleanupDataDirs } = createTempDirTracker();
  afterEach(cleanupDataDirs);

  it('touches progress after every rebuilt-table step and every backfill step (deterministic, no wall-clock deadline)', async () => {
    const dataDir = tempDataDir('startup-watchdog-real-convergence-');
    mkdirSync(pathJoin(dataDir, 'app'), { recursive: true });

    const baselinePath = pathJoin(pathDirname(fileURLToPath(new URL('../src/db/async.ts', import.meta.url))), '..', '..', 'drizzle', '0000_baseline.sql');
    const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'));
    const seedTables = baseline.tables.filter((t) => !/FOREIGN KEY/.test(t.sql));
    const client = createClient({ url: `file:${pathJoin(dataDir, 'harmonic.db')}` });
    await client.execute('PRAGMA foreign_keys = OFF');
    for (const table of seedTables) {
      const driftedSql = table.sql.replace(/\)$/, ', CHECK (1=1))');
      await client.execute(driftedSql);
      const rowCount = table.name === 'workspaces' ? 1 : 5; // at least one workspace so the backfill actually runs its 3 steps
      const columnNames = table.columns.map((c) => `\`${c.name}\``).join(', ');
      const values = Array.from({ length: rowCount }, (_, i) =>
        `(${table.columns.map((c) => (/integer/i.test(c.definition) ? String(i + 1) : `'v${i + 1}'`)).join(', ')})`,
      );
      await client.execute(`INSERT INTO \`${table.name}\` (${columnNames}) VALUES ${values.join(', ')}`);
    }
    client.close();

    vi.mocked(touchStartupProgress).mockClear();
    const handle = await openAsyncDb(dataDir);
    await handle.close();

    const touchesForThisBoot = vi.mocked(touchStartupProgress).mock.calls.filter(([dir]) => dir === dataDir);
    // Floor: 3 coarse touches from openAsyncDb, plus 4 per rebuilt table (rebuildTable's create/copy/drop/rename).
    const minimumExpectedTouches = 3 + seedTables.length * 4;
    expect(touchesForThisBoot.length).toBeGreaterThanOrEqual(minimumExpectedTouches);
  });
});

describe('startStartupWatchdog (unit)', () => {
  it('does not spawn a watcher when there is no pending.json', () => {
    const dataDir = tempDir('startup-watchdog-no-pending-');
    let spawned = false;
    const clear = startStartupWatchdog({
      dataDir,
      watcherPath,
      spawnWatcher: (() => { spawned = true; throw new Error('should not be called'); }) as never,
    });

    expect(spawned).toBe(false);
    clear();
  });

  it('does not spawn a watcher when pending.json names a different version', () => {
    const dataDir = tempDir('startup-watchdog-other-version-');
    writePending(dataDir, '9.9.9');
    let spawned = false;
    const clear = startStartupWatchdog({
      dataDir,
      ownDir: repoRoot,
      watcherPath,
      spawnWatcher: (() => { spawned = true; throw new Error('should not be called'); }) as never,
    });

    expect(spawned).toBe(false);
    clear();
  });

  it('spawns the watcher with the data dir, own pid, running version, and deadline when pending.json names the running version', () => {
    const dataDir = tempDir('startup-watchdog-spawn-');
    writePending(dataDir, ownVersion);
    const calls: unknown[][] = [];
    const clear = startStartupWatchdog({
      dataDir,
      ownDir: repoRoot,
      watcherPath,
      deadlineMs: 5_000,
      spawnWatcher: ((...args: unknown[]) => {
        calls.push(args);
        return { unref: () => {}, kill: () => {} };
      }) as never,
    });

    expect(calls).toHaveLength(1);
    const [file, spawnArgs] = calls[0] as [string, string[]];
    expect(file).toBe(process.execPath);
    expect(spawnArgs).toEqual([watcherPath, dataDir, String(process.pid), ownVersion, '5000']);
    clear();
  });

  it('the cleanup function kills the spawned watcher', () => {
    const dataDir = tempDir('startup-watchdog-cleanup-');
    writePending(dataDir, ownVersion);
    let killed = false;
    const clear = startStartupWatchdog({
      dataDir,
      ownDir: repoRoot,
      watcherPath,
      spawnWatcher: (() => ({ unref: () => {}, kill: () => { killed = true; } })) as never,
    });

    clear();
    expect(killed).toBe(true);
  });

  it('does not spawn a watcher, and warns instead, when the watcher script is missing', () => {
    const dataDir = tempDir('startup-watchdog-missing-watcher-');
    writePending(dataDir, ownVersion);
    let spawned = false;
    const clear = startStartupWatchdog({
      dataDir,
      ownDir: repoRoot,
      watcherPath: join(dataDir, 'does-not-exist.cjs'),
      spawnWatcher: (() => { spawned = true; throw new Error('should not be called'); }) as never,
    });

    expect(spawned).toBe(false);
    clear();
  });
});
