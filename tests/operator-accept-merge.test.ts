import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, seedLocalMarkdownTicket, type TestServer } from './helpers.js';
import { verificationCommandSchema } from '../src/config.js';
import type { MirrorInput } from '../src/domain/tasks.js';
import type { CriticHarnessDrive } from '../src/verification/critic.js';
import { trackerRef as brandRef } from '../src/tracker/adapter.js';

const failingCritic = () => ({
  taskPreMergeCritics: [
    {
      kind: 'local' as const,
      enabled: true,
      critic: { id: 'critic-test', name: 'Test critic', issuePrompt: 'Review the diff.', noIssuePrompt: 'Review the diff.', harness: 'claude' as const, model: 'stub-model', timeoutSeconds: 300 },
    },
  ],
});

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

  it('operator Accept on an escalated ticket whose base moved non-conflictingly resumes the workflow and merges via a merge commit, settling done', async () => {
    server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 2 });
    wsId = (await server.app.ctx.workspaces.list())[0]!.id;

    const repo = makeRepo();
    await server.legacy.setWorkspace(wsId, { taskPreMergeCommands: [{ kind: 'local', enabled: true, command: verificationCommandSchema.parse({ id: 'cmd-exit-1', command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 }) }] });
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
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
    expect(escalated.escalationReason).toMatch(/workflow attempts exhausted after 2/);
    const verified = (await server.app.ctx.attempts.get(attemptId)).verifiedHeadOid;
    expect(verified).toMatch(/^[0-9a-f]{40}$/);

    const mainTip = advanceMain(repo, 'other.txt', 'someone else merged\n');

    await server.legacy.setWorkspace(wsId, { taskPreMergeCommands: [{ kind: 'local', enabled: true, command: verificationCommandSchema.parse({ id: 'cmd-exit-0', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 }) }] });

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(200);
    const done = await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      return t.state === 'done' ? t : undefined;
    });
    expect(done).toMatchObject({ escalationReason: null, mergeStatus: null });

    expect(git(repo, 'rev-parse', 'main')).not.toBe(mainTip);
    expect(git(repo, 'show', 'main:other.txt')).toBe('someone else merged');
    expect(git(repo, 'show', 'main:impl-native.txt')).toBe('implementation');
    expect(git(repo, 'log', '--merges', '--oneline', 'main')).not.toBe('');

    await server.close();
  });

  it('Accept escalates again, merging nothing, when the base advance conflicts with the candidate', async () => {
    const criticDrive: CriticHarnessDrive = { run: async () => ({ output: JSON.stringify({ verdict: 'fail', summary: 'needs work' }), permissionRequests: [] }) };
    server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 2 }, { criticDrive });
    wsId = (await server.app.ctx.workspaces.list())[0]!.id;

    const repo = makeRepo();
    await server.legacy.setWorkspace(wsId, failingCritic());
    await server.app.ctx.workspaces.update(wsId, { workingDir: repo });

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

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(200);
    const again = await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      return t.state === 'escalated' && /workflow step merge conflict/.test(t.escalationReason ?? '') ? t : undefined;
    });
    expect(again.mergeStatus).toBeNull();
    expect(git(repo, 'rev-parse', 'main')).toBe(mainTip);

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
      await server.legacy.setWorkspace(wsId, { taskPreMergeCommands: [{
          kind: 'local',
          enabled: true,
          command: verificationCommandSchema.parse({
            id: 'cmd-exit-1',
            command: process.execPath,
            args: ['-e', 'process.exit(1)'],
            timeoutSeconds: 30,
          }),
        }] });
      await server.app.ctx.workspaces.update(wsId, {
        workingDir: repo,
        maxAttempts: 1,
      });
      await server.app.ctx.settingsStore.updateGlobal({
        drive: { prompt: JSON.stringify({ writeFiles: { 'impl-{ref}.txt': 'implementation {ref}\n' }, mcpFinish: true }) },
      });

      const mirroredAfk = (trackerRef: number): MirrorInput => ({
        trackerRef: brandRef(trackerRef),
        prompt: `ticket ${trackerRef}\n\nbody`,
        issueWorkflow: 'implement',
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
