import { describe, it, expect, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { verificationCommandSchema } from '../src/config.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const tmpDirs: string[] = [];
const tmpPath = (prefix: string) => {
  const p = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(p);
  return p;
};

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

    await server.app.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute({ sql: 'UPDATE tasks SET state = ? WHERE id = ?', args: ['working', id] });
    sqlite.close();

    server = await startServer(undefined, { dataDir });
    const recovered = await server.api('GET', `/api/tasks/${id}`);
    expect(recovered.body.state).toBe('ready');
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
    const run = await server.api('GET', `/api/attempts/${started.body.id}`);
    expect(run.body.state).toBe('completed');
  });

  it('leaves an escalated ticket untouched across a restart — no sweep moves a human decision', async () => {
    server = await startServer({ ...stubHarness(), maxAttempts: 1 });
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ exit: 'crash-before-response' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated');
    const dataDir = server.dataDir;
    const attemptId = started.body.id as number;
    const taskId = created.body.id as number;
    const before = await server.api('GET', `/api/tasks/${created.body.id}`);

    await server.app.close();
    const attemptSnapshot = async () => {
      const check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      const rows = await check.execute({ sql: 'SELECT id, state, reason FROM attempts WHERE task_id = ?', args: [taskId] });
      check.close();
      return rows.rows;
    };
    const attemptsBefore = await attemptSnapshot();
    server = await startServer({ ...stubHarness(), maxAttempts: 1 }, { dataDir });

    const task = await server.api('GET', `/api/tasks/${created.body.id}`);
    expect(task.body).toMatchObject({ state: 'escalated', escalationReason: before.body.escalationReason });
    const run = await server.api('GET', `/api/attempts/${attemptId}`);
    expect(run.body.state).toBe('failed');
    await server.app.close();
    expect(await attemptSnapshot()).toEqual(attemptsBefore);
    server = await startServer({ ...stubHarness(), maxAttempts: 1 }, { dataDir });
  });

  it(
    'reconciles a worktree Run crashed after its merge landed but before settle ran: re-runs the post-merge check and completes it — idempotent across repeat boots',
    async () => {
      server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 1 });
      const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
      const repo = makeRepo();
      await server.app.ctx.workspaces.update(wsId, { workingDir: repo, verificationCommand: [passingVerifier()] });

      const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ writeFiles: { 'impl.txt': 'implementation\n' } }) });
      const taskId: number = created.body.id;
      const started = await server.api('POST', `/api/tasks/${taskId}/run`);
      const attemptId: number = started.body.id;
      await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');
      const dataDir = server.dataDir;
      const runBefore = await server.api('GET', `/api/attempts/${attemptId}`);
      expect(runBefore.body.state).toBe('completed');
      const mainTipAfterMerge = git(repo, 'rev-parse', 'main');

      await server.app.close();
      const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      await sqlite.execute({ sql: "UPDATE attempts SET state = 'running', ended_at = NULL WHERE id = ?", args: [attemptId] });
      await sqlite.execute({ sql: "UPDATE tasks SET state = 'working' WHERE id = ?", args: [taskId] });
      sqlite.close();

      server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 1 }, { dataDir });

      const run = await server.api('GET', `/api/attempts/${attemptId}`);
      expect(run.body.state).toBe('completed');
      const task = await server.api('GET', `/api/tasks/${taskId}`);
      expect(task.body.state).toBe('done');
      expect(git(repo, 'rev-parse', 'main')).toBe(mainTipAfterMerge);

      await server.app.close();
      server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 1 }, { dataDir });
      const runAgain = await server.api('GET', `/api/attempts/${attemptId}`);
      expect(runAgain.body.state).toBe('completed');
      expect(git(repo, 'rev-parse', 'main')).toBe(mainTipAfterMerge);
    },
  );

  it(
    'settles a merged Task whose settle died after the Attempt passed but before the Task reached done — done, not re-picked, no double-merge (#427)',
    async () => {
      server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 1 });
      const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
      const repo = makeRepo();
      await server.app.ctx.workspaces.update(wsId, { workingDir: repo, verificationCommand: [passingVerifier()] });

      const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ writeFiles: { 'impl.txt': 'implementation\n' } }) });
      const taskId: number = created.body.id;
      const started = await server.api('POST', `/api/tasks/${taskId}/run`);
      const attemptId: number = started.body.id;
      await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');
      const dataDir = server.dataDir;
      const mainTipAfterMerge = git(repo, 'rev-parse', 'main');

      await server.app.close();
      const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      await sqlite.execute({ sql: "UPDATE tasks SET state = 'working' WHERE id = ?", args: [taskId] });
      sqlite.close();

      server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 1 }, { dataDir });

      const task = await server.api('GET', `/api/tasks/${taskId}`);
      expect(task.body.state).toBe('done');
      const run = await server.api('GET', `/api/attempts/${attemptId}`);
      expect(run.body.state).toBe('completed');
      expect(git(repo, 'rev-parse', 'main')).toBe(mainTipAfterMerge);

      const check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      const rows = await check.execute({ sql: 'SELECT id FROM attempts WHERE task_id = ?', args: [taskId] });
      check.close();
      expect(rows.rows).toHaveLength(1);
    },
  );

  it(
    'settles an accepted-then-merged Task whose settle died with the Attempt passed but the Task still escalated — done, not left a silent orphan (#427)',
    async () => {
      server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 1 });
      const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
      const repo = makeRepo();
      await server.app.ctx.workspaces.update(wsId, { workingDir: repo, verificationCommand: [passingVerifier()] });

      const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ writeFiles: { 'impl.txt': 'implementation\n' } }) });
      const taskId: number = created.body.id;
      const started = await server.api('POST', `/api/tasks/${taskId}/run`);
      const attemptId: number = started.body.id;
      await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');
      const dataDir = server.dataDir;
      const mainTipAfterMerge = git(repo, 'rev-parse', 'main');

      await server.app.close();
      const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      await sqlite.execute({ sql: "UPDATE tasks SET state = 'escalated' WHERE id = ?", args: [taskId] });
      sqlite.close();

      server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 1 }, { dataDir });

      const task = await server.api('GET', `/api/tasks/${taskId}`);
      expect(task.body.state).toBe('done');
      const run = await server.api('GET', `/api/attempts/${attemptId}`);
      expect(run.body.state).toBe('completed');
      expect(git(repo, 'rev-parse', 'main')).toBe(mainTipAfterMerge);
    },
  );

  it(
    'settles a merged Task requeued to `ready` while its accept-merge was still in flight — the merge, not the stale `ready`, wins',
    async () => {
      server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 1 });
      const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
      const repo = makeRepo();
      await server.app.ctx.workspaces.update(wsId, { workingDir: repo, verificationCommand: [passingVerifier()] });

      const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ writeFiles: { 'impl.txt': 'implementation\n' } }) });
      const taskId: number = created.body.id;
      const started = await server.api('POST', `/api/tasks/${taskId}/run`);
      const attemptId: number = started.body.id;
      await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');
      const dataDir = server.dataDir;
      const mainTipAfterMerge = git(repo, 'rev-parse', 'main');

      await server.app.close();
      // Reproduce the race's end-state: the branch is merged and the Attempt
      // passed, but the verify/requeue loop moved the Task back to `ready`.
      const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      await sqlite.execute({ sql: "UPDATE tasks SET state = 'ready' WHERE id = ?", args: [taskId] });
      sqlite.close();

      server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 1 }, { dataDir });

      const task = await server.api('GET', `/api/tasks/${taskId}`);
      expect(task.body.state).toBe('done');
      const run = await server.api('GET', `/api/attempts/${attemptId}`);
      expect(run.body.state).toBe('completed');
      expect(git(repo, 'rev-parse', 'main')).toBe(mainTipAfterMerge);
    },
  );

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
});
