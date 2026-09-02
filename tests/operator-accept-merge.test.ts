import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, seedLocalMarkdownTicket, type TestServer } from './helpers.js';
import { verificationCommandSchema } from '../src/config.js';
import type { MirrorInput } from '../src/domain/tasks.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const tmpDirs: string[] = [];
const tmpPath = (prefix: string) => {
  const p = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(p);
  return p;
};

function makeRepo(): string {
  const dir = tmpPath('harmonic-accept-merge-');
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  mkdirSync(join(dir, 'docs', 'agents'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: local-markdown\n\nPath: tickets\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

function advanceMain(repo: string, file: string, content: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'main advances independently');
  return git(repo, 'rev-parse', 'main');
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('operator Accept merge (ADR-0001, issue #383)', () => {
  let server: TestServer;
  let wsId: number;

  it('operator Accept on an escalated ticket whose base moved non-conflictingly merges via a merge commit and passes the post-merge check, settling done', async () => {
    server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 2 });
    wsId = (await server.app.ctx.workspaces.list())[0]!.id;

    const repo = makeRepo();
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 })],
    });

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'impl-native.txt': 'implementation\n' } }),
    });
    expect(created.status).toBe(201);
    const taskId: number = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    const attemptId: number = started.body.id;
    const escalated = await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      return t.state === 'escalated' ? t : undefined;
    });
    expect(escalated.escalationReason).toMatch(/attempt 2 of 2 failed/);
    const verified = (await server.app.ctx.attempts.get(attemptId)).verifiedHeadOid;
    expect(verified).toMatch(/^[0-9a-f]{40}$/);

    const mainTip = advanceMain(repo, 'other.txt', 'someone else merged\n');

    await server.app.ctx.workspaces.update(wsId, {
      verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 })],
    });

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`, { force: true });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ state: 'done', escalationReason: null, mergeStatus: null });

    expect(git(repo, 'rev-parse', 'main')).not.toBe(mainTip);
    expect(git(repo, 'show', 'main:other.txt')).toBe('someone else merged');
    expect(git(repo, 'show', 'main:impl-native.txt')).toBe('implementation');
    expect(git(repo, 'log', '--merges', '--oneline', 'main')).not.toBe('');

    await server.close();
  });

  it('operator Accept without force verifies the candidate first; a passing verification merges it (issue #429)', async () => {
    server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 2 });
    wsId = (await server.app.ctx.workspaces.list())[0]!.id;

    const repo = makeRepo();
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 })],
    });

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'impl-native.txt': 'implementation\n' } }),
    });
    expect(created.status).toBe(201);
    const taskId: number = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      return t.state === 'escalated' ? t : undefined;
    });

    await server.app.ctx.workspaces.update(wsId, {
      verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 })],
    });

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ state: 'done', escalationReason: null, mergeStatus: null });
    expect(git(repo, 'show', 'main:impl-native.txt')).toBe('implementation');

    await server.close();
  });

  it('operator Accept refuses (409) when the base advance conflicts with the candidate, leaving the ticket escalated and nothing merged', async () => {
    server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 2 });
    wsId = (await server.app.ctx.workspaces.list())[0]!.id;

    const repo = makeRepo();
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      conflictResolveTurns: 0,
      verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 })],
    });

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'impl-native.txt': 'implementation\n' } }),
    });
    expect(created.status).toBe(201);
    const taskId: number = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      return t.state === 'escalated' ? t : undefined;
    });

    const mainTip = advanceMain(repo, 'impl-native.txt', 'someone else changed this\n');

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`, { force: true });
    expect(accepted.status).toBe(409);
    const stillEscalated = await server.app.ctx.tasks.get(taskId);
    expect(stillEscalated.state).toBe('escalated');
    expect(stillEscalated.mergeStatus).toBe('resolving-conflicts');
    expect(git(repo, 'rev-parse', 'main')).toBe(mainTip);

    await server.close();
  });

  it('operator Accept escalates (409) when the post-merge check on the merged base is red, reverting the merge to keep the base green', async () => {
    server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 2 });
    wsId = (await server.app.ctx.workspaces.list())[0]!.id;

    const repo = makeRepo();
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 })],
    });

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'impl-native.txt': 'implementation\n' } }),
    });
    expect(created.status).toBe(201);
    const taskId: number = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      return t.state === 'escalated' ? t : undefined;
    });

    advanceMain(repo, 'other.txt', 'someone else merged\n');

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`, { force: true });
    expect(accepted.status).toBe(409);
    expect((await server.app.ctx.tasks.get(taskId)).state).toBe('escalated');
    expect(() => git(repo, 'show', 'main:impl-native.txt')).toThrow();
    expect(git(repo, 'show', 'main:other.txt')).toBe('someone else merged');

    await server.close();
  });
});

describe('escalated worktree Run diff snapshot', () => {
  it('an escalated worktree Run snapshots its diff so the review pane is never blank', async () => {
    const server = await startServer({
      ...stubHarness(),
      defaults: { isolationMode: 'worktree' },
      maxAttempts: 2,
      drive: { continueAttempts: 0, mergeFate: 'auto-merge' },
    });
    try {
      const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
      const repo = makeRepo();
      await server.app.ctx.workspaces.update(wsId, {
        workingDir: repo,
        maxAttempts: 1,
        verificationCommand: [
          verificationCommandSchema.parse({
            command: process.execPath,
            args: ['-e', 'process.exit(1)'],
            timeoutSeconds: 30,
          }),
        ],
      });
      await server.app.ctx.settingsStore.updateGlobal({
        drive: { prompt: JSON.stringify({ writeFiles: { 'impl-{ref}.txt': 'implementation {ref}\n' }, mcpFinish: true }) },
      });

      const mirroredAfk = (trackerRef: number): MirrorInput => ({
        trackerRef,
        prompt: `ticket ${trackerRef}\n\nbody`,
        workflow: 'implement',
        wayfinderType: null,
        mapRef: null,
        closed: false,
      });
      const trackerRef = 38_300;
      const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(trackerRef));
      seedLocalMarkdownTicket(task.workingDir, trackerRef, 'closed');
      git(task.workingDir, 'add', '-A');
      git(task.workingDir, 'commit', '-q', '-m', `ticket ${trackerRef}`);
      await server.app.ctx.tasks.setState(task.id, 'working');
      const run = await server.app.ctx.runner.launchClaimed(task.id);

      await waitFor(async () => ((await server.app.ctx.tasks.get(task.id)).state === 'escalated' ? true : undefined));

      const settledRun = await server.app.ctx.attempts.get(run.id);
      expect(settledRun.state).toBe('escalated');
      expect(settledRun.branch).not.toBeNull();
      expect(settledRun.stat).toContain(`impl-${trackerRef}.txt`);
      expect(settledRun.diffBaseOid).not.toBeNull();
      expect(settledRun.diffHeadOid).not.toBeNull();
    } finally {
      await server.close();
    }
  });
});
