import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskArchive } from '../src/archive/task-archive.js';
import { type AppConfig, baselineConfig, type DeepPartial } from '../src/config.js';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import { workspaces as workspacesTable } from '../src/db/schema.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import type { EpicWorktreePool } from '../src/execution/epic-worktree-pool.js';
import { EpicVerificationRunner } from '../src/tracker/epic-verification-runner.js';
import type { CriticDriveRequest, CriticHarnessDrive } from '../src/verification/critic.js';
import { createPostMergeCheck } from '../src/verification/post-merge-check.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace, startServer, stubHarness, type TestServer, waitFor } from './helpers.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const localCritics = (...critics: Array<{ id: string; prompt: string }>) =>
  critics.map(({ id, prompt }) => ({
    kind: 'local' as const,
    enabled: true,
    critic: { id, name: id, prompt, issuePrompt: prompt, noIssuePrompt: prompt, model: 'stub-model', timeoutSeconds: 300 },
  }));

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-critic-archive-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

function makeDrive(logDir: string): { drive: CriticHarnessDrive; markerOf: (req: CriticDriveRequest) => string | undefined } {
  const markers = ['alpha', 'beta'];
  const markerOf = (req: CriticDriveRequest) => markers.find((marker) => req.prompt.includes(`review-${marker}`));
  const drive: CriticHarnessDrive = {
    async run(req) {
      const marker = markerOf(req) ?? 'unknown';
      const sessionId = `session-${marker}`;
      req.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${marker}-first` } });
      await delay(marker === 'alpha' ? 30 : 10);
      req.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${marker}-second` } });
      await delay(20);
      mkdirSync(join(logDir, 'project'), { recursive: true });
      writeFileSync(join(logDir, 'project', `${sessionId}.jsonl`), `native-${marker}\n`);
      return { output: JSON.stringify({ verdict: 'pass', summary: `${marker} ok` }), permissionRequests: [], sessionId };
    },
  };
  return { drive, markerOf };
}

function expectStepTrio(stepDir: string, marker: string): void {
  expect(readFileSync(join(stepDir, 'prompt.md'), 'utf8')).toContain(`review-${marker}`);
  const acp = readFileSync(join(stepDir, 'acp.jsonl'), 'utf8');
  expect(acp).toContain(`${marker}-first`);
  expect(acp).toContain(`${marker}-second`);
  const other = marker === 'alpha' ? 'beta' : 'alpha';
  expect(acp).not.toContain(`${other}-first`);
  expect(acp).not.toContain(`${other}-second`);
  expect(readFileSync(join(stepDir, 'native', `session-${marker}.jsonl`), 'utf8')).toBe(`native-${marker}\n`);
}

function findDir(root: string, prefix: string): string {
  for (const slug of readdirSync(root)) {
    const match = readdirSync(join(root, slug)).find((name) => name.startsWith(prefix));
    if (match) return join(root, slug, match);
  }
  throw new Error(`no archive dir starting with ${prefix}`);
}

function criticConfig(logDir: string): AppConfig {
  const config = baselineConfig();
  return { ...config, harnesses: { ...config.harnesses, claude: { ...config.harnesses.claude, sessionLogDir: logDir } } };
}

describe('Critic Step archive wiring (#730)', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'harmonic-critic-archive-native-'));
  const { drive } = makeDrive(logDir);
  const twoCritics = localCritics({ id: 'critic-alpha', prompt: 'review-alpha' }, { id: 'critic-beta', prompt: 'review-beta' });

  afterAll(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  describe('Task pre-merge critics', () => {
    let server: TestServer;
    let repoDir: string;
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-critic-archive-data-'));

    beforeAll(async () => {
      repoDir = makeRepo();
      const base = stubHarness() as { harnesses: { claude: Record<string, unknown> } };
      const config = { ...base, harnesses: { claude: { ...base.harnesses.claude, sessionLogDir: logDir } } } as DeepPartial<AppConfig>;
      server = await startServer(config, { criticDrive: drive, dataDir });
      const ws = (await server.app.ctx.workspaces.list())[0]!;
      await server.app.ctx.workspaces.update(ws.id, {
        workingDir: repoDir,
        isolationMode: 'worktree',
        taskPreMergeCritics: twoCritics,
      });
    });

    afterAll(async () => {
      await server?.close();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('gives each parallel critic its own Step directory with prompt, ACP updates and native transcript', async () => {
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ writeFiles: { 'feature.txt': 'work\n' } }),
        workingDir: repoDir,
        isolationMode: 'worktree',
      });
      expect(created.status).toBe(201);
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      expect(started.status).toBe(201);
      await waitFor(async () => ((await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done' ? true : undefined));

      const preMerge = join(findDir(join(dataDir, 'archive'), `${created.body.id}-`), 'attempts', '1', 'verification', 'pre-merge');
      const stepDirs = readdirSync(preMerge);
      expect(stepDirs).toHaveLength(2);
      const byMarker = new Map(
        stepDirs.map((name) => {
          const prompt = readFileSync(join(preMerge, name, 'prompt.md'), 'utf8');
          return [prompt.includes('review-alpha') ? 'alpha' : 'beta', join(preMerge, name)] as const;
        }),
      );
      expect([...byMarker.keys()].sort()).toEqual(['alpha', 'beta']);
      expectStepTrio(byMarker.get('alpha')!, 'alpha');
      expectStepTrio(byMarker.get('beta')!, 'beta');
    });
  });

  describe('crash-recovery post-merge critics and Epic pre-merge critics', () => {
    let dir: string;
    let repoDir: string;
    let asyncDb: AsyncDbHandle;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'harmonic-critic-archive-unit-'));
      repoDir = makeRepo();
      asyncDb = await openAsyncDb(dir);
      await seedWorkspace(asyncDb, repoDir);
    });

    afterAll(async () => {
      await asyncDb.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    });

    it('writes post-merge critic Steps as critic-<n> under verification/post-merge', async () => {
      const settingsStore = await makeSettingsStore(dir);
      const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
      const attempts = new AttemptStore(asyncDb);
      const archive = new TaskArchive({ dataDir: dir, ensureArchiveId: (id) => tasks.ensureArchiveId(id), workspaceName: async () => 'ws' });
      const task = await tasks.create({ prompt: 'post-merge', state: 'ready', workingDir: repoDir, isolationMode: 'direct' });
      const run = await attempts.create(task.id);
      const ws = { taskPostMergeCommands: null, taskPostMergeCritics: JSON.stringify(twoCritics), taskPreMergeCommands: null, taskPreMergeCritics: null, epicPreMergeCommands: null, epicPreMergeCritics: null };
      const check = createPostMergeCheck({
        workspaces: { get: async () => ws } as never,
        settingsStore: { getGlobal: () => criticConfig(logDir) } as never,
        verificationAttempts: new VerificationAttemptStore(asyncDb),
        criticDrive: drive,
        archive,
      });

      const result = await check({ task, run, mergeOid: git(repoDir, 'rev-parse', 'HEAD'), baseDir: repoDir });

      expect(result.pass).toBe(true);
      const postMerge = join(findDir(join(dir, 'archive'), `${task.id}-`), 'attempts', String(run.number), 'verification', 'post-merge');
      expect(readdirSync(postMerge).sort()).toEqual(['critic-1', 'critic-2']);
      expectStepTrio(join(postMerge, 'critic-1'), 'alpha');
      expectStepTrio(join(postMerge, 'critic-2'), 'beta');
    });

    it('writes Epic critic Steps keyed by the review Step id under epic-<ref>/attempts/<n>/verification/pre-merge', async () => {
      const wsRow = (await asyncDb.read((d) => d.select().from(workspacesTable).get()))!;
      const settingsStore = await makeSettingsStore(dir);
      const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
      const epicAttempts = new AttemptStore(asyncDb);
      const archive = new TaskArchive({ dataDir: dir, ensureArchiveId: (id) => tasks.ensureArchiveId(id), workspaceName: async () => 'ws' });
      await tasks.syncEpics(wsRow.id, [{ ref: 77, kind: 'epic' }]);
      const workspace = { ...wsRow, epicPreMergeCommands: null, epicPreMergeCritics: JSON.stringify(twoCritics) };
      const runner = new EpicVerificationRunner({
        workspace: workspace as never,
        getWorkspaces: async () => [workspace as never],
        getConfig: () => criticConfig(logDir),
        worktrees: { acquire: async () => repoDir, get: () => repoDir } as unknown as EpicWorktreePool,
        epicAttempts,
        verificationAttemptStore: new VerificationAttemptStore(asyncDb),
        criticDrive: drive,
        archive,
      });

      const decision = await runner.verify({ repoDir, epicRef: 77, verifiedHeadOid: git(repoDir, 'rev-parse', 'HEAD') });

      expect(decision.outcome).toBe('proceed');
      const epicAttempt = (await epicAttempts.listForEpic({ workspaceId: wsRow.id, epicRef: 77 }))[0]!;
      const steps = (await epicAttempts.listSteps(epicAttempt.id)).filter((step) => step.type === 'review');
      expect(steps).toHaveLength(2);
      const preMerge = join(dir, 'archive', readdirSync(join(dir, 'archive'))[0]!, 'epic-77', 'attempts', String(epicAttempt.number), 'verification', 'pre-merge');
      expect(readdirSync(preMerge).sort()).toEqual(steps.map((step) => String(step.id)).sort());
      const byMarker = new Map(
        readdirSync(preMerge).map((name) => [readFileSync(join(preMerge, name, 'prompt.md'), 'utf8').includes('review-alpha') ? 'alpha' : 'beta', join(preMerge, name)] as const),
      );
      expectStepTrio(byMarker.get('alpha')!, 'alpha');
      expectStepTrio(byMarker.get('beta')!, 'beta');
      expect(steps.every((step) => step.state === 'passed' && step.logLocator?.startsWith('verification_attempt:'))).toBe(true);
    });

    it('fails the Epic review Step instead of leaving it running when recording the critic throws', async () => {
      const wsRow = (await asyncDb.read((d) => d.select().from(workspacesTable).get()))!;
      const settingsStore = await makeSettingsStore(dir);
      const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
      const epicAttempts = new AttemptStore(asyncDb);
      await tasks.syncEpics(wsRow.id, [{ ref: 78, kind: 'epic' }]);
      const workspace = { ...wsRow, epicPreMergeCommands: null, epicPreMergeCritics: JSON.stringify(twoCritics) };
      const store = new VerificationAttemptStore(asyncDb);
      store.append = async () => { throw new Error('db down'); };
      const runner = new EpicVerificationRunner({
        workspace: workspace as never,
        getWorkspaces: async () => [workspace as never],
        getConfig: () => criticConfig(logDir),
        worktrees: { acquire: async () => repoDir, get: () => repoDir } as unknown as EpicWorktreePool,
        epicAttempts,
        verificationAttemptStore: store,
        criticDrive: drive,
      });

      await runner.verify({ repoDir, epicRef: 78, verifiedHeadOid: git(repoDir, 'rev-parse', 'HEAD') }).catch(() => undefined);

      const epicAttempt = (await epicAttempts.listForEpic({ workspaceId: wsRow.id, epicRef: 78 }))[0]!;
      await vi.waitFor(async () => {
        const steps = (await epicAttempts.listSteps(epicAttempt.id)).filter((step) => step.type === 'review');
        expect(steps.map((step) => [step.state, step.endedAt !== null])).toEqual([['failed', true], ['failed', true]]);
      });
    });
  });
});
