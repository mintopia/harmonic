import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb } from '../src/db/async.js';
import { processGroups } from '../src/db/schema.js';
import { ProcessGroupJournal } from '../src/execution/process-groups.js';
import { createChildProcessSpawn } from '../src/verification/command-verifier.js';
import { BackgroundWork } from '../src/error-handling.js';
import { testSpawnProcessGroup, startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pidFrom = (file: string): Promise<number> =>
  waitFor(async () => (existsSync(file) && readFileSync(file, 'utf8') !== '' ? Number(readFileSync(file, 'utf8')) : undefined));

const gone = (pid: number): Promise<true> => waitFor(async () => (alive(pid) ? undefined : true));

const FOREVER = 'setInterval(() => {}, 1e9)';

/** Boot Harmonic in a new process, as a restart after a crash would, so its own start time postdates the crashed groups. */
async function bootInFreshProcess(dataDir: string): Promise<void> {
  const appUrl = pathToFileURL(fileURLToPath(new URL('../src/server/app.ts', import.meta.url))).href;
  const script = [
    `import { buildApp } from '${appUrl}';`,
    `const app = await buildApp({ dataDir: ${JSON.stringify(dataDir)}, reliabilityTuning: { eventLoop: { enabled: false } } });`,
    'await app.close();',
  ].join('\n');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const [code] = (await once(child, 'exit')) as [number | null];
  if (code !== 0) throw new Error(`fresh boot exited ${code}: ${stderr}`);
}

describe('harness process groups', () => {
  let server: TestServer | undefined;
  const dirs: string[] = [];
  const strays: number[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-pgroups-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    await server?.close();
    server = undefined;
    for (const pid of strays.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('an Attempt harness that exits takes its grandchild with it', async () => {
    server = await startServer(stubHarness());
    const pidFile = join(scratch(), 'grandchild.pid');
    const task = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ grandchildPidFile: pidFile, exit: 'clean' }) });
    await server.api('POST', `/api/tasks/${task.body.id}/run`);
    const grandchild = await pidFrom(pidFile);
    strays.push(grandchild);

    await gone(grandchild);
    await waitFor(async () => ((await server!.app.ctx.asyncDb.read((d) => d.select().from(processGroups).all())).length === 0 ? true : undefined));
  });

  it('ending a Conversation kills its harness grandchild', async () => {
    server = await startServer(stubHarness());
    const pidFile = join(scratch(), 'grandchild.pid');
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: JSON.stringify({ grandchildPidFile: pidFile }) });
    const grandchild = await pidFrom(pidFile);
    strays.push(grandchild);
    expect(alive(grandchild)).toBe(true);

    await server.api('POST', `/api/conversations/${convo.id}/end`);

    await gone(grandchild);
  });

  it('app.close() kills the grandchildren of a running Attempt and an open Conversation', async () => {
    server = await startServer(stubHarness());
    const attemptPidFile = join(scratch(), 'attempt-grandchild.pid');
    const convoPidFile = join(scratch(), 'convo-grandchild.pid');
    const task = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ grandchildPidFile: attemptPidFile, exit: 'hang' }) });
    await server.api('POST', `/api/tasks/${task.body.id}/run`);
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: JSON.stringify({ grandchildPidFile: convoPidFile }) });
    const grandchildren = [await pidFrom(attemptPidFile), await pidFrom(convoPidFile)];
    strays.push(...grandchildren);

    await server.app.close();

    for (const pid of grandchildren) await gone(pid);
  });

  it('a verify command finishes even when it leaves a grandchild holding its output pipes, and the grandchild is killed', async () => {
    const pidFile = join(scratch(), 'grandchild.pid');
    const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(FOREVER)}], { stdio: 'inherit' }); c.unref(); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`;

    const result = await createChildProcessSpawn(testSpawnProcessGroup).run({
      command: { id: 'leaky', command: process.execPath, args: ['-e', script], env: {}, timeoutSeconds: 30 },
      cwd: scratch(),
      timeoutMs: 30_000,
      outputCap: 10_000,
      signal: undefined,
    });
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    strays.push(grandchild);

    expect(result.code).toBe(0);
    await gone(grandchild);
  });

  it('boot reaps a process group a crashed instance left running', async () => {
    server = await startServer(stubHarness());
    const dataDir = server.dataDir;
    await server.app.close();
    server = undefined;

    const pidFile = join(scratch(), 'grandchild.pid');
    const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(FOREVER)}], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); ${FOREVER}`;
    const leader = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
    leader.unref();
    strays.push(leader.pid!);
    const grandchild = await pidFrom(pidFile);
    strays.push(grandchild);
    const db = await openAsyncDb(dataDir);
    await new ProcessGroupJournal(db, new BackgroundWork().fireAndForget).record(leader.pid!, 'crashed attempt harness');
    await db.close();

    server = await startServer(stubHarness(), { dataDir });

    await gone(leader.pid!);
    await gone(grandchild);
    expect(await server.app.ctx.asyncDb.read((d) => d.select().from(processGroups).all())).toEqual([]);
  });

  it('boot reaps the surviving grandchild of a crash-left group whose leader already exited', async () => {
    server = await startServer(stubHarness());
    const dataDir = server.dataDir;
    await server.app.close();
    server = undefined;

    const pidFile = join(scratch(), 'grandchild.pid');
    const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(FOREVER)}], { stdio: 'ignore' }); c.unref(); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => process.exit(0), 300);`;
    const leader = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
    const db = await openAsyncDb(dataDir);
    await new ProcessGroupJournal(db, new BackgroundWork().fireAndForget).record(leader.pid!, 'crashed conversation harness');
    await db.close();
    const grandchild = await pidFrom(pidFile);
    strays.push(grandchild);
    await gone(leader.pid!);
    expect(alive(grandchild)).toBe(true);

    await bootInFreshProcess(dataDir);

    await gone(grandchild);
    const reopened = await openAsyncDb(dataDir);
    try {
      expect(await reopened.read((d) => d.select().from(processGroups).all())).toEqual([]);
    } finally {
      await reopened.close();
    }
  });

  it('the spawner a boot reap returns journals each group until its leader exits; the unjournaled spawner leaves no row', async () => {
    const dir = scratch();
    const db = await openAsyncDb(dir);
    try {
      const background = new BackgroundWork();
      const spawnJournaled = await new ProcessGroupJournal(db, background.fireAndForget).reapOrphans();
      const rows = () => db.read((d) => d.select().from(processGroups).all());

      const journaled = spawnJournaled(process.execPath, ['-e', FOREVER], { stdio: 'ignore' }, 'journaled test child');
      strays.push(journaled.pid!);
      await waitFor(async () => ((await rows()).some((row) => row.pgid === journaled.pid && row.owner === 'journaled test child') ? true : undefined));

      const bare = testSpawnProcessGroup(process.execPath, ['-e', FOREVER], { stdio: 'ignore' }, 'bare test child');
      strays.push(bare.pid!);
      expect((await rows()).map((row) => row.pgid)).toEqual([journaled.pid]);

      process.kill(journaled.pid!, 'SIGKILL');
      process.kill(bare.pid!, 'SIGKILL');
      await once(journaled, 'exit');
      await background.drain();
      expect(await rows()).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('a boot reap kills a crashed predecessor\'s group before handing out a spawner', async () => {
    const dir = scratch();
    const leader = spawn(process.execPath, ['-e', FOREVER], { detached: true, stdio: 'ignore' });
    leader.unref();
    strays.push(leader.pid!);
    const db = await openAsyncDb(dir);
    try {
      const journal = new ProcessGroupJournal(db, new BackgroundWork().fireAndForget);
      await journal.record(leader.pid!, 'crashed harness');

      await journal.reapOrphans();

      await gone(leader.pid!);
      expect(await db.read((d) => d.select().from(processGroups).all())).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
