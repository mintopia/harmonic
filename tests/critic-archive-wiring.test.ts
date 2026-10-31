import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskArchive } from '../src/archive/task-archive.js';
import { type AppConfig, baselineConfig } from '../src/config.js';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import { workspaces as workspacesTable } from '../src/db/schema.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import type { EpicWorktreePool } from '../src/execution/epic-worktree-pool.js';
import { EpicVerificationRunner } from '../src/tracker/epic-verification-runner.js';
import type { CriticDriveRequest, CriticHarnessDrive } from '../src/verification/critic.js';
import { executionPlumbing, allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';
import { trackerRef } from '../src/tracker/adapter.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const localCritics = (...critics: Array<{ id: string; prompt: string }>) =>
  critics.map(({ id, prompt }) => ({
    kind: 'local' as const,
    enabled: true,
    critic: { id, name: id, prompt, issuePrompt: prompt, noIssuePrompt: prompt, harness: 'claude' as const, model: 'stub-model', timeoutSeconds: 300 },
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

function criticConfig(logDir: string): AppConfig {
  const config = baselineConfig();
  return { ...config, harnesses: { ...config.harnesses, claude: { ...config.harnesses.claude, sessionLogDir: logDir } } };
}

function withoutClaude(config: AppConfig): AppConfig {
  const { claude: _claude, ...harnesses } = config.harnesses;
  return { ...config, harnesses: harnesses as AppConfig["harnesses"] };
}

describe('Critic Step archive wiring (#730)', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'harmonic-critic-archive-native-'));
  const { drive } = makeDrive(logDir);
  const twoCritics = localCritics({ id: 'critic-alpha', prompt: 'review-alpha' }, { id: 'critic-beta', prompt: 'review-beta' });

  afterAll(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  describe('Epic pre-merge critics', () => {
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

    it('writes Epic critic Steps keyed by the review Step id under epic-<ref>/attempts/<n>/verification/pre-merge', async () => {
      const wsRow = (await asyncDb.read((d) => d.select().from(workspacesTable).get()))!;
      const settingsStore = await makeSettingsStore(dir);
      const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
      const epicAttempts = new AttemptStore(asyncDb);
      const epicVerificationAttempts = new VerificationAttemptStore(asyncDb);
      const archive = new TaskArchive({ dataDir: dir, ensureArchiveId: (id) => tasks.ensureArchiveId(id), workspaceName: async () => 'ws' });
      await tasks.syncEpics(wsRow.id, [{ ref: trackerRef(77), kind: 'epic' }]);
      const workspace = { ...wsRow, epicPreMergeCommands: null, epicPreMergeCritics: JSON.stringify(twoCritics) };
      const runner = new EpicVerificationRunner({
        commandSpawn: executionPlumbing().commandSpawn,
        workspace: workspace as never,
        getWorkspaces: async () => [workspace as never],
        getConfig: () => criticConfig(logDir),
        prompts: bundledEnginePrompts,
        worktrees: { acquire: async () => repoDir, get: () => repoDir } as unknown as EpicWorktreePool,
        epicAttempts,
        verificationAttemptStore: epicVerificationAttempts,
        criticDrive: drive,
        archive,
      });

      const decision = await runner.verify({ repoDir, epicRef: trackerRef(77), verifiedHeadOid: git(repoDir, 'rev-parse', 'HEAD') });

      expect(decision.outcome).toBe('proceed');
      const epicAttempt = (await epicAttempts.listForEpic({ workspaceId: wsRow.id, epicRef: trackerRef(77) }))[0]!;
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
      const rows = await epicVerificationAttempts.list(epicAttempt.id);
      expect(rows.map((row) => row.promptKey).sort()).toEqual(steps.map((step) => `verification/pre-merge/${step.id}/prompt.md`).sort());
      for (const row of rows) expect(await archive.readArchivedPrompt({ workspaceId: wsRow.id, epicRef: trackerRef(77) }, epicAttempt.number, row.promptKey!)).toContain('review-');
    });

    it('runs an Epic critic on its own Harness, not the configured default', async () => {
      const wsRow = (await asyncDb.read((d) => d.select().from(workspacesTable).get()))!;
      const workspace = { ...wsRow, epicPreMergeCommands: null, epicPreMergeCritics: JSON.stringify(twoCritics.slice(0, 1)) };
      const harnessIds: string[] = [];
      const config = criticConfig(logDir);
      const runner = new EpicVerificationRunner({
        commandSpawn: executionPlumbing().commandSpawn,
        workspace: workspace as never,
        getWorkspaces: async () => [workspace as never],
        getConfig: () => ({ ...config, defaults: { ...config.defaults, harness: 'codex' } }),
        prompts: bundledEnginePrompts,
        worktrees: { acquire: async () => repoDir, get: () => repoDir } as unknown as EpicWorktreePool,
        criticDrive: { run: (request) => { harnessIds.push(request.harnessId); return drive.run(request); } },
      });

      await runner.verify({ repoDir, epicRef: trackerRef(79), verifiedHeadOid: git(repoDir, 'rev-parse', 'HEAD') });

      expect(harnessIds).toEqual(['claude']);
    });

    it('returns an inconclusive verdict naming an Epic critic Harness that is not configured', async () => {
      const wsRow = (await asyncDb.read((d) => d.select().from(workspacesTable).get()))!;
      const workspace = { ...wsRow, epicPreMergeCommands: null, epicPreMergeCritics: JSON.stringify(twoCritics.slice(0, 1)) };
      const harnessIds: string[] = [];
      const runner = new EpicVerificationRunner({
        commandSpawn: executionPlumbing().commandSpawn,
        workspace: workspace as never,
        getWorkspaces: async () => [workspace as never],
        getConfig: () => withoutClaude(criticConfig(logDir)),
        prompts: bundledEnginePrompts,
        worktrees: { acquire: async () => repoDir, get: () => repoDir } as unknown as EpicWorktreePool,
        criticDrive: { run: (request) => { harnessIds.push(request.harnessId); return drive.run(request); } },
      });

      const decision = await runner.verify({ repoDir, epicRef: trackerRef(80), verifiedHeadOid: git(repoDir, 'rev-parse', 'HEAD') });

      expect(JSON.stringify(decision)).toContain("critic harness 'claude' is not configured");
      expect(decision.outcome).not.toBe('proceed');
      expect(harnessIds).toEqual([]);
    });

    it('fails the Epic review Step instead of leaving it running when recording the critic throws', async () => {
      const wsRow = (await asyncDb.read((d) => d.select().from(workspacesTable).get()))!;
      const settingsStore = await makeSettingsStore(dir);
      const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
      const epicAttempts = new AttemptStore(asyncDb);
      await tasks.syncEpics(wsRow.id, [{ ref: trackerRef(78), kind: 'epic' }]);
      const workspace = { ...wsRow, epicPreMergeCommands: null, epicPreMergeCritics: JSON.stringify(twoCritics) };
      const store = new VerificationAttemptStore(asyncDb);
      store.append = async () => { throw new Error('db down'); };
      const runner = new EpicVerificationRunner({
        commandSpawn: executionPlumbing().commandSpawn,
        workspace: workspace as never,
        getWorkspaces: async () => [workspace as never],
        getConfig: () => criticConfig(logDir),
        prompts: bundledEnginePrompts,
        worktrees: { acquire: async () => repoDir, get: () => repoDir } as unknown as EpicWorktreePool,
        epicAttempts,
        verificationAttemptStore: store,
        criticDrive: drive,
      });

      await runner.verify({ repoDir, epicRef: trackerRef(78), verifiedHeadOid: git(repoDir, 'rev-parse', 'HEAD') }).catch(() => undefined);

      const epicAttempt = (await epicAttempts.listForEpic({ workspaceId: wsRow.id, epicRef: trackerRef(78) }))[0]!;
      await vi.waitFor(async () => {
        const steps = (await epicAttempts.listSteps(epicAttempt.id)).filter((step) => step.type === 'review');
        expect(steps.map((step) => [step.state, step.endedAt !== null])).toEqual([['failed', true], ['failed', true]]);
      });
    });
  });
});
