import { describe, it, expect, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { verificationCommandSchema } from '../src/config.js';

/**
 * Boot crash-recovery (ADR-0001, "Scope and design ceiling": crash recovery
 * relies on git's own idempotence and on rebuilding in-memory state from the
 * DB at boot — no journal, no queue): a fresh process executes nothing, so
 * any Task left `working`/`running` by the previous instance was orphaned by
 * the restart and must be reconciled — including a mirrored afk Task that
 * crashed between the ready→working flip (the lock) and its Run being
 * created, and a worktree-mode Run whose merge landed in git before the
 * process died but whose settle never ran.
 */
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const tmpDirs: string[] = [];
const tmpPath = (prefix: string) => {
  const p = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(p);
  return p;
};

/** A throwaway git repo on branch main with one committed README. */
function makeRepo(): string {
  const dir = tmpPath('harmonic-boot-recovery-repo-');
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

function passingVerifier() {
  return verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 });
}

describe('boot crash-recovery', () => {
  let server: TestServer;

  afterEach(async () => {
    await server.close();
  });

  it('re-queues a Task stuck `working` with no Run row on the next boot', async () => {
    server = await startServer();
    const created = await server.api('POST', '/api/tasks', { prompt: 'stuck mid-launch' });
    const id = created.body.id as number;
    const dataDir = server.dataDir;

    // Simulate the crash: the auto-runner had flipped it to `working` but died
    // before spawning a Run — so there is no `running` run for the run sweep.
    await server.app.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute({ sql: 'UPDATE tasks SET state = ? WHERE id = ?', args: ['working', id] });
    sqlite.close();

    server = await startServer(undefined, { dataDir });
    const recovered = await server.api('GET', `/api/tasks/${id}`);
    expect(recovered.body.state).toBe('ready'); // an interruption is not a failed Attempt (ADR-0041)
  });

  it('leaves a done ticket and its merged Run untouched across a restart', async () => {
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
    const dataDir = server.dataDir;

    await server.app.close();
    server = await startServer(stubHarness(), { dataDir });

    const task = await server.api('GET', `/api/tasks/${created.body.id}`);
    expect(task.body.state).toBe('done');
    const run = await server.api('GET', `/api/runs/${started.body.id}`);
    expect(run.body.state).toBe('completed');
  });

  it('leaves an escalated ticket untouched across a restart — no sweep moves a human decision (ADR-0041)', async () => {
    server = await startServer({ ...stubHarness(), maxAttempts: 1 });
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ exit: 'crash-before-response' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated');
    const dataDir = server.dataDir;
    const runId = started.body.id as number;
    const before = await server.api('GET', `/api/tasks/${created.body.id}`);

    await server.app.close();
    const count = async () => {
      const check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      const n = ((await check.execute({ sql: 'SELECT COUNT(*) as n FROM run_facts WHERE run_id = ?', args: [runId] })).rows[0] as unknown as { n: number }).n;
      check.close();
      return n;
    };
    const factsBefore = await count();
    server = await startServer({ ...stubHarness(), maxAttempts: 1 }, { dataDir });

    const task = await server.api('GET', `/api/tasks/${created.body.id}`);
    expect(task.body).toMatchObject({ state: 'escalated', escalationReason: before.body.escalationReason });
    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.body.state).toBe('failed');
    await server.app.close();
    expect(await count()).toBe(factsBefore);
    server = await startServer({ ...stubHarness(), maxAttempts: 1 }, { dataDir });
  });

  it(
    'reconciles a worktree Run crashed after its merge landed but before settle ran: re-runs the post-merge check and completes it — idempotent across repeat boots, with zero merge_journal/turn_queue rows written',
    async () => {
      server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 1 });
      const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
      const repo = makeRepo();
      await server.app.ctx.workspaces.update(wsId, { workingDir: repo, verificationCommand: [passingVerifier()] });

      const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ writeFiles: { 'impl.txt': 'implementation\n' } }) });
      const taskId: number = created.body.id;
      const started = await server.api('POST', `/api/tasks/${taskId}/run`);
      const runId: number = started.body.id;
      await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');
      const dataDir = server.dataDir;
      const runBefore = await server.api('GET', `/api/runs/${runId}`);
      expect(runBefore.body.state).toBe('completed');
      const mainTipAfterMerge = git(repo, 'rev-parse', 'main');

      // Simulate the crash: the merge landed in git (it really did — `main` now
      // contains the task branch), but the process died before the Run/Task
      // settled — exactly as a crash between `mergeIntoBase` and
      // `RunSettleCoordinator.settle` would leave them.
      await server.app.close();
      const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      await sqlite.execute({ sql: "UPDATE runs SET state = 'running', finished_at = NULL WHERE id = ?", args: [runId] });
      await sqlite.execute({ sql: "UPDATE tasks SET state = 'working' WHERE id = ?", args: [taskId] });
      sqlite.close();

      server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 1 }, { dataDir });

      // Reconciled without touching git again: `main` is exactly where the
      // original merge left it (no re-merge, no duplicate commit).
      const run = await server.api('GET', `/api/runs/${runId}`);
      expect(run.body.state).toBe('completed');
      const task = await server.api('GET', `/api/tasks/${taskId}`);
      expect(task.body.state).toBe('done');
      expect(git(repo, 'rev-parse', 'main')).toBe(mainTipAfterMerge);

      const check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      const journalCount = ((await check.execute('SELECT COUNT(*) as n FROM merge_journal')).rows[0] as unknown as { n: number }).n;
      const turnQueueCount = ((await check.execute('SELECT COUNT(*) as n FROM turn_queue')).rows[0] as unknown as { n: number }).n;
      check.close();
      expect(journalCount).toBe(0);
      expect(turnQueueCount).toBe(0);

      // A second boot: the Run already left `running`, so nothing re-checks it.
      await server.app.close();
      server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 1 }, { dataDir });
      const runAgain = await server.api('GET', `/api/runs/${runId}`);
      expect(runAgain.body.state).toBe('completed');
      expect(git(repo, 'rev-parse', 'main')).toBe(mainTipAfterMerge);
    },
  );

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
});
