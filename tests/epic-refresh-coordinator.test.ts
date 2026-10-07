import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpicRefresh, type EpicRefreshOutcome } from '../src/execution/epic-coordinator.js';
import type { MergeIntoBaseOutcome } from '../src/execution/branch-merge.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { Runner } from '../src/execution/runner.js';
import { TrackerEpicService } from '../src/tracker/epic-service.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import { type Ticket, trackerRef, type TrackerRef } from '../src/tracker/adapter.js';
import type { CriticDriveRequest } from '../src/verification/critic.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import { EpicMergeEventStore } from '../src/domain/epic-merge-events.js';
import { readFileSync } from 'node:fs';
import { executionPlumbing, allWorkspaces, makeSettingsStore, waitFor, seedWorkspace } from './helpers.js';

const fakeGit = { revParse: async () => 'develop-tip' };

const ticket = (over: Partial<Ticket>): Ticket => ({
  ref: trackerRef(100),
  title: 'A ticket',
  state: 'open',
  body: '',
  createdAt: '2026-08-07T00:00:00Z',
  closedAt: null,
  labels: [],
  assignees: [],
  parent: null,
  blockedBy: [],
  blocking: [],
  isMap: false,
  url: 'https://github.com/mintopia/harmonic/issues/100',
  ...over,
});

const conflict = (detail = 'both changed package.json'): MergeIntoBaseOutcome => ({
  ok: false,
  reason: 'conflict',
  detail,
});

describe('EpicRefresh', () => {
  it('merges develop into an integration branch under the repo lock', async () => {
    const calls: string[] = [];
    const coordinator = new EpicRefresh({
      git: fakeGit,
      merge: async ({ baseBranch, branch }) => {
        calls.push(`${baseBranch}<-${branch}`);
        return { ok: true, mode: 'cas', oid: 'merge-oid', baseBranch, branch };
      },
      dispatchResolve: async () => ({ status: 'dispatched' }),
      escalate: () => {},
    });

    await expect(coordinator.refresh({ ref: trackerRef(42), repoDir: '/repo', defaultBranch: 'develop' })).resolves.toEqual({
      status: 'refreshed', oid: 'merge-oid',
    });
    expect(calls).toEqual(['epic/42<-develop']);
  });

  it('dispatches exactly one resolution turn, then escalates the Epic with the recorded conflict', async () => {
    const outcomes = [conflict('first conflict'), conflict('second conflict')];
    const resolutions: string[] = [];
    const escalations: Array<{ ref: TrackerRef; reason: string }> = [];
    const coordinator = new EpicRefresh({
      git: fakeGit,
      merge: async () => outcomes.shift()!,
      dispatchResolve: async (_target, detail) => {
        resolutions.push(detail);
        return { status: 'dispatched' };
      },
      escalate: (ref, reason) => { escalations.push({ ref, reason }); },
    });

    await expect(coordinator.refresh({ ref: trackerRef(7), repoDir: '/repo', defaultBranch: 'develop' })).resolves.toEqual({
      status: 'resolving', detail: 'first conflict',
    });
    await expect(coordinator.refresh({ ref: trackerRef(7), repoDir: '/repo', defaultBranch: 'develop' })).resolves.toMatchObject({
      status: 'escalated',
    });
    expect(resolutions).toEqual(['first conflict']);
    expect(escalations).toEqual([{ ref: '7', reason: expect.stringContaining('second conflict') }]);
  });

  it('serializes refreshes on the same base repo', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const starts: number[] = [];
    const coordinator = new EpicRefresh({
      git: fakeGit,
      merge: async () => {
        starts.push(starts.length + 1);
        if (starts.length === 1) await first;
        return { ok: true, mode: 'cas', oid: `oid-${starts.length}`, baseBranch: 'epic/9', branch: 'develop' };
      },
      dispatchResolve: async () => ({ status: 'dispatched' }),
      escalate: () => {},
    });

    const one = coordinator.refresh({ ref: trackerRef(9), repoDir: '/repo', defaultBranch: 'develop' });
    const two = coordinator.refresh({ ref: trackerRef(9), repoDir: '/repo', defaultBranch: 'develop' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(starts).toEqual([1]);
    release();
    await Promise.all([one, two]);
    expect(starts).toEqual([1, 2]);
  });

  it('defers a checked-out integration branch instead of falsely escalating it', async () => {
    const escalations: string[] = [];
    const coordinator = new EpicRefresh({
      git: fakeGit,
      merge: async () => ({ ok: false, reason: 'fallback-pr-manual', detail: 'branch is checked out' }),
      dispatchResolve: async () => ({ status: 'dispatched' }),
      escalate: (_ref, reason) => { escalations.push(reason); },
    });

    await expect(coordinator.refresh({ ref: trackerRef(12), repoDir: '/repo', defaultBranch: 'develop' })).resolves.toEqual({
      status: 'deferred', reason: 'branch is checked out',
    });
    expect(escalations).toEqual([]);
  });

  it('does not record a resolution attempt until dispatch succeeds', async () => {
    const dispatches: string[] = [];
    const escalations: string[] = [];
    const coordinator = new EpicRefresh({
      git: fakeGit,
      merge: async () => conflict('refresh conflict'),
      dispatchResolve: async (_target, detail) => {
        dispatches.push(detail);
        if (dispatches.length === 1) throw new Error('no corrective turn was dispatched');
        return { status: 'dispatched' };
      },
      escalate: (_ref, reason) => { escalations.push(reason); },
    });
    const target = { ref: trackerRef(13), repoDir: '/repo', defaultBranch: 'develop' };

    await expect(coordinator.refresh(target)).rejects.toThrow('no corrective turn was dispatched');
    await expect(coordinator.refresh(target)).resolves.toEqual({
      status: 'resolving', detail: 'refresh conflict',
    });
    expect(dispatches).toEqual(['refresh conflict', 'refresh conflict']);
    expect(escalations).toEqual([]);
  });

  it('returns an escalation when no running member can host a refresh resolution, without stranding the resolving flag', async () => {
    const coordinator = new EpicRefresh({
      git: fakeGit,
      merge: async () => conflict('refresh conflict'),
      dispatchResolve: async () => ({
        status: 'escalated',
        reason: 'no active Epic member is available to resolve refresh conflict for epic/14',
      }),
      escalate: () => {},
    });
    const target = { ref: trackerRef(14), repoDir: '/repo', defaultBranch: 'develop' };

    await expect(coordinator.refresh(target)).resolves.toEqual({
      status: 'escalated',
      reason: 'no active Epic member is available to resolve refresh conflict for epic/14',
    });
    await expect(coordinator.refresh(target)).resolves.toEqual({
      status: 'escalated',
      reason: 'no active Epic member is available to resolve refresh conflict for epic/14',
    });
  });
});

describe('epic refresh corrective turn (issue #315)', () => {
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  let dir: string;
  let repo: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-refresh-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    repo = join(dir, 'repo');
    execFileSync('git', ['init', '-b', 'develop', repo], { encoding: 'utf8' });
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repo, 'shared.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'branch', 'epic/5');
    writeFileSync(join(repo, 'shared.txt'), 'develop change\n');
    git(repo, 'commit', '-am', 'develop side');
    const epicWt = join(dir, 'epic-seed');
    git(repo, 'worktree', 'add', epicWt, 'epic/5');
    writeFileSync(join(epicWt, 'shared.txt'), 'epic change\n');
    git(epicWt, 'commit', '-am', 'epic side');
    git(repo, 'worktree', 'remove', '--force', epicWt);
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeRunner(drive: (req: CriticDriveRequest) => Promise<void>, archive?: TaskArchive): Runner {
    return new Runner(tasks, asyncDb, () => baselineConfig(), {
      ...executionPlumbing(),
      archive,
      worktreesDir: join(dir, 'worktrees'),
      criticDrive: {
        run: async (req) => {
          await drive(req);
          return { output: 'done', permissionRequests: [] };
        },
      },
    });
  }

  async function runningMember(baseBranch: string): Promise<void> {
    const task = await tasks.create({ prompt: 'member work' });
    await tasks.setBaseBranch(task.id, baseBranch);
    await tasks.setState(task.id, 'working');
  }

  const epicTickets = (): Ticket[] => [
    ticket({ ref: trackerRef(5), title: 'Resolver epic' }),
    ticket({ ref: trackerRef(6), parent: trackerRef(5) }),
  ];

  /** Mirrors a done, worktree-mode member for Epic 5 onto `workspaceId`, so the
   * whole-Epic integrate gate opens without a force override. */
  async function readyEpicMember(workspaceId: number, tickets: Ticket[]): Promise<void> {
    const mirrored = await mirrorScan(tasks, tickets, workspaceId);
    const member = mirrored.find((t) => t.trackerRef === trackerRef(6))!;
    await tasks.update(member.id, { isolationMode: 'worktree' });
    await tasks.setState(member.id, 'done');
  }

  describe('routed by the Epic Routing Label (ADR-0049)', () => {
    const routedConfig = () => ({
      ...baselineConfig(),
      routingLabels: [
        { label: 'reasoning', harness: 'claude' as const, model: 'claude-opus-5-5' },
        { label: 'cheap', harness: 'codex' as const, model: 'cheap-model' },
      ],
    });

    async function refreshOn(epicLabels: string[], config = routedConfig()) {
      const routedTasks = new TaskService(asyncDb, () => config, allWorkspaces(asyncDb, settingsStore));
      const workspaceId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
      const memberTicket = ticket({ ref: trackerRef(6), parent: trackerRef(5), labels: ['cheap'] });
      const mirrored = await mirrorScan(routedTasks, [ticket({ ref: trackerRef(5), labels: epicLabels }), memberTicket], workspaceId);
      const member = mirrored.find((t) => t.trackerRef === trackerRef(6))!;
      await routedTasks.setBaseBranch(member.id, 'epic/5');
      await routedTasks.setState(member.id, 'working');
      const driveCalls: CriticDriveRequest[] = [];
      const escalations: string[] = [];
      let retried = false;
      const runner = new Runner(routedTasks, asyncDb, () => config, {
        ...executionPlumbing(),
        worktreesDir: join(dir, 'worktrees'),
        criticDrive: {
          run: async (req) => {
            driveCalls.push(req);
            writeFileSync(join(req.cwd, 'shared.txt'), 'resolved\n');
            git(req.cwd, 'add', '-A');
            git(req.cwd, 'commit', '--no-edit');
            return { output: 'done', permissionRequests: [] };
          },
        },
      });
      git(repo, 'checkout', '--detach');
      const outcome = await runner.enqueueEpicRefreshResolution(
        { ref: trackerRef(5), workspaceId, repoDir: repo, defaultBranch: 'develop' },
        'both changed shared.txt',
        (_ref, reason) => { escalations.push(reason); },
        async () => { retried = true; },
      );
      if (outcome.status === 'dispatched') await waitFor(async () => retried);
      return { outcome, driveCalls, escalations };
    }

    it('an Epic labelled reasoning refreshes on the reasoning route while its member is labelled cheap', async () => {
      const { driveCalls, escalations } = await refreshOn(['epic', 'reasoning']);
      expect(escalations).toEqual([]);
      expect(driveCalls.map((c) => [c.harnessId, c.model])).toEqual([['claude', 'claude-opus-5-5']]);
    });

    it('an unlabelled Epic refreshes on the defaults while a cheap-labelled member works', async () => {
      const config = routedConfig();
      const { driveCalls } = await refreshOn(['epic'], config);
      expect(driveCalls.map((c) => [c.harnessId, c.model])).toEqual([[config.defaults.harness, config.harnesses[config.defaults.harness]!.defaultModel]]);
    });

    it('escalates the Epic when its routed Harness is not configured', async () => {
      const config = routedConfig();
      delete (config.harnesses as Record<string, unknown>).claude;
      const { outcome, driveCalls, escalations } = await refreshOn(['epic', 'reasoning'], config);
      expect(outcome.status).toBe('escalated');
      expect(driveCalls).toEqual([]);
      expect(escalations[0]).toContain("routed by label 'reasoning'");
    });
  });

  it('conflict → one corrective turn against epic/<ref> → the refresh completes', async () => {
    const driveCalls: CriticDriveRequest[] = [];
    const escalations: string[] = [];
    const retryOutcomes: EpicRefreshOutcome[] = [];
    const runner = makeRunner(async (req) => {
      driveCalls.push(req);
      expect(git(req.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('epic/5');
      expect(git(req.cwd, 'status', '--porcelain')).toContain('UU shared.txt');
      writeFileSync(join(req.cwd, 'shared.txt'), 'resolved\n');
      git(req.cwd, 'add', '-A');
      git(req.cwd, 'commit', '--no-edit');
    });
    await runningMember('epic/5');
    git(repo, 'checkout', '--detach');

    const target = { ref: trackerRef(5), repoDir: repo, defaultBranch: 'develop' };
    const coordinator: EpicRefresh = new EpicRefresh({
      dispatchResolve: (t, detail) =>
        runner.enqueueEpicRefreshResolution({ ...t, workspaceId: 1 }, detail, (_ref, reason) => { escalations.push(reason); }, async () => {
          const outcome = await coordinator.refresh(t);
          retryOutcomes.push(outcome);
          return outcome;
        }),
      escalate: (_ref, reason) => { escalations.push(reason); },
    });

    await expect(coordinator.refresh(target)).resolves.toMatchObject({ status: 'resolving' });

    await waitFor(async () => retryOutcomes.length === 1);
    expect(retryOutcomes[0]).toMatchObject({ status: 'refreshed' });
    expect(driveCalls).toHaveLength(1);
    expect(driveCalls[0]!.cwd).toContain('epic-refresh-5');
    expect(escalations).toEqual([]);
    git(repo, 'merge-base', '--is-ancestor', 'develop', 'epic/5');
    expect(git(repo, 'worktree', 'list').split('\n').filter(Boolean)).toHaveLength(1);
    await expect(coordinator.refresh(target)).resolves.toMatchObject({ status: 'refreshed' });
  });

  it('an unresolved corrective turn re-conflicts and escalates, leaving no worktree and no stranded flag', async () => {
    const escalations: string[] = [];
    const retryOutcomes: EpicRefreshOutcome[] = [];
    const runner = makeRunner(async () => {
    });
    await runningMember('epic/5');
    git(repo, 'checkout', '--detach');

    const target = { ref: trackerRef(5), repoDir: repo, defaultBranch: 'develop' };
    const coordinator: EpicRefresh = new EpicRefresh({
      dispatchResolve: (t, detail) =>
        runner.enqueueEpicRefreshResolution({ ...t, workspaceId: 1 }, detail, (_ref, reason) => { escalations.push(reason); }, async () => {
          const outcome = await coordinator.refresh(t);
          retryOutcomes.push(outcome);
          return outcome;
        }),
      escalate: (_ref, reason) => { escalations.push(reason); },
    });

    await expect(coordinator.refresh(target)).resolves.toMatchObject({ status: 'resolving' });

    await waitFor(async () => retryOutcomes.length === 1);
    expect(retryOutcomes[0]).toMatchObject({ status: 'escalated' });
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain('still conflicts after corrective turn');
    expect(git(repo, 'worktree', 'list').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('dispatch failure (integration branch missing) escalates with the conflict detail before any flag is set', async () => {
    const runner = makeRunner(async () => {
      throw new Error('the corrective turn must not run when the worktree cannot be prepared');
    });
    await runningMember('epic/9');

    const outcome = await runner.enqueueEpicRefreshResolution(
      { ref: trackerRef(9), repoDir: repo, defaultBranch: 'develop', workspaceId: 1 },
      'both changed shared.txt',
      () => {},
      async () => {
        throw new Error('retry must not run for a failed dispatch');
      },
    );
    expect(outcome.status).toBe('escalated');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('both changed shared.txt') });
    expect(git(repo, 'worktree', 'list').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('a finished Epic with no running member still resolves via the default harness', async () => {
    const driveCalls: CriticDriveRequest[] = [];
    const escalations: string[] = [];
    const retryOutcomes: EpicRefreshOutcome[] = [];
    const runner = makeRunner(async (req) => {
      driveCalls.push(req);
      expect(git(req.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('epic/5');
      expect(git(req.cwd, 'status', '--porcelain')).toContain('UU shared.txt');
      writeFileSync(join(req.cwd, 'shared.txt'), 'resolved\n');
      git(req.cwd, 'add', '-A');
      git(req.cwd, 'commit', '--no-edit');
    });
    git(repo, 'checkout', '--detach');

    const target = { ref: trackerRef(5), repoDir: repo, defaultBranch: 'develop' };
    const coordinator: EpicRefresh = new EpicRefresh({
      dispatchResolve: (t, detail) =>
        runner.enqueueEpicRefreshResolution({ ...t, workspaceId: 1 }, detail, (_ref, reason) => { escalations.push(reason); }, async () => {
          const outcome = await coordinator.refresh(t);
          retryOutcomes.push(outcome);
          return outcome;
        }),
      escalate: (_ref, reason) => { escalations.push(reason); },
    });

    await expect(coordinator.refresh(target)).resolves.toMatchObject({ status: 'resolving' });

    await waitFor(async () => retryOutcomes.length === 1);
    expect(retryOutcomes[0]).toMatchObject({ status: 'refreshed' });
    expect(escalations).toEqual([]);
    const cfg = baselineConfig();
    expect(driveCalls).toHaveLength(1);
    expect(driveCalls[0]!.harnessId).toBe(cfg.defaults.harness);
    expect(driveCalls[0]!.model).toBe(cfg.harnesses[cfg.defaults.harness]!.defaultModel);
    git(repo, 'merge-base', '--is-ancestor', 'develop', 'epic/5');
  });

  it('archives the refresh resolver prompt from config and records an epic-resolve event on the Epic Attempt', async () => {
    const workspace = await new WorkspaceService(asyncDb, settingsStore).create({ name: 'Refresh archive', workingDir: repo });
    await tasks.syncEpics(workspace.id, [{ ref: trackerRef(5), kind: 'epic' }]);
    const attempts = new AttemptStore(asyncDb);
    const attempt = await attempts.createForEpic({ workspaceId: workspace.id, epicRef: trackerRef(5) });
    const config = baselineConfig();
    config.merge.epicRefreshPrompt = 'CUSTOM refresh {branch} <- {defaultBranch}: {detail}';
    const archive = new TaskArchive({ dataDir: join(dir, 'data'), ensureArchiveId: async () => 'unused', workspaceName: async () => workspace.name });
    const driven: string[] = [];
    const runner = new Runner(tasks, asyncDb, () => config, {
      ...executionPlumbing(),
      archive,
      worktreesDir: join(dir, 'worktrees'),
      criticDrive: {
        run: async (req) => {
          driven.push(req.prompt);
          writeFileSync(join(req.cwd, 'shared.txt'), 'resolved\n');
          git(req.cwd, 'add', '-A');
          git(req.cwd, 'commit', '--no-edit');
          return { output: 'done', permissionRequests: [] };
        },
      },
    });
    git(repo, 'checkout', '--detach');
    let retried = false;
    await runner.enqueueEpicRefreshResolution(
      { ref: trackerRef(5), workspaceId: workspace.id, repoDir: repo, defaultBranch: 'develop' },
      'both changed shared.txt',
      () => {},
      async () => { retried = true; },
    );
    await waitFor(async () => retried);

    expect(driven).toHaveLength(1);
    expect(driven[0]).toMatch(/^CUSTOM refresh epic\/5 <- develop: /);
    const epicDir = await archive.ensureEpic(workspace.id, trackerRef(5));
    expect(readFileSync(join(epicDir, 'attempts', String(attempt.number), 'resolution', 'epic-refresh-1', 'prompt.md'), 'utf8')).toBe(driven[0]);
    expect((await attempts.listEvents(attempt.id)).map((e) => e.payload)).toContainEqual({
      event: 'epic-resolve',
      kind: 'refresh',
      locator: 'resolution/epic-refresh-1/prompt.md',
      promptIndex: 0,
    });
  });

  it('records the refresh resolver prompt in the Epic merge-event log when the Epic has no Attempt', async () => {
    const workspace = await new WorkspaceService(asyncDb, settingsStore).create({ name: 'Refresh no attempt', workingDir: repo });
    await tasks.syncEpics(workspace.id, [{ ref: trackerRef(5), kind: 'epic' }]);
    const archive = new TaskArchive({ dataDir: join(dir, 'data'), ensureArchiveId: async () => 'unused', workspaceName: async () => workspace.name });
    const driven: string[] = [];
    const runner = new Runner(tasks, asyncDb, () => baselineConfig(), {
      ...executionPlumbing(),
      archive,
      worktreesDir: join(dir, 'worktrees'),
      criticDrive: {
        run: async (req) => {
          driven.push(req.prompt);
          writeFileSync(join(req.cwd, 'shared.txt'), 'resolved\n');
          git(req.cwd, 'add', '-A');
          git(req.cwd, 'commit', '--no-edit');
          return { output: 'done', permissionRequests: [] };
        },
      },
    });
    git(repo, 'checkout', '--detach');
    let retried = false;
    await runner.enqueueEpicRefreshResolution(
      { ref: trackerRef(5), workspaceId: workspace.id, repoDir: repo, defaultBranch: 'develop' },
      'both changed shared.txt',
      () => {},
      async () => { retried = true; },
    );
    await waitFor(async () => retried);

    const step = { step: 'resolver-prompt', kind: 'refresh', attempt: 1, locator: 'resolution/epic-refresh-1/prompt.md', promptIndex: 0 };
    expect((await new EpicMergeEventStore(asyncDb).list(workspace.id, trackerRef(5))).map((e) => e.step)).toContainEqual(step);
    expect(await archive.readResolvedPrompt({ workspaceId: workspace.id, epicRef: trackerRef(5) }, 1, step.locator, 0)).toBe(driven[0]);
  });

  it('uses an existing Epic checkout and persists the resolver session, usage, process identity, and Step', async () => {
    const workspaces = new WorkspaceService(asyncDb, settingsStore);
    const workspace = await workspaces.create({ name: 'Epic resolver', workingDir: repo });
    await tasks.syncEpics(workspace.id, [{ ref: trackerRef(5), kind: 'epic' }]);
    const attempts = new AttemptStore(asyncDb);
    const attempt = await attempts.createForEpic({ workspaceId: workspace.id, epicRef: trackerRef(5) });
    const liveWorktree = join(dir, 'epic-live');
    git(repo, 'worktree', 'add', liveWorktree, 'epic/5');
    const cwd: string[] = [];
    const updates: { attemptId: number; payload: { sessionUpdate: string } }[] = [];
    const resolveConfig = baselineConfig();
    resolveConfig.verify.epic.resolveSuffix = 'CUSTOM SUFFIX for {branch}.';
    const archive = new TaskArchive({ dataDir: join(dir, 'data'), ensureArchiveId: async () => 'unused', workspaceName: async () => workspace.name });
    const runner = new Runner(tasks, asyncDb, () => resolveConfig, {
      ...executionPlumbing(),
      archive,
      worktreesDir: join(dir, 'worktrees'),
      events: {
        onAttemptLogEvent: (event) => updates.push(event),
      },
      criticDrive: {
        run: async (req) => {
          cwd.push(req.cwd);
          await req.onSessionCreated?.('epic-resolve-session', { agentCapabilities: {} });
          req.onUpdate?.({ sessionUpdate: 'tool_call', kind: 'read' });
          writeFileSync(join(req.cwd, 'resolved.txt'), 'fixed\n');
          git(req.cwd, 'add', 'resolved.txt');
          git(req.cwd, 'commit', '-m', 'Resolve verification');
          return {
            output: 'fixed',
            permissionRequests: [],
            sessionId: 'epic-resolve-session',
            usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
          };
        },
      },
    });

    await runner.resolveEpicVerification({
      workspaceId: workspace.id,
      epicRef: trackerRef(5),
      repoDir: repo,
      worktreePath: liveWorktree,
      attempt,
      verifiedHeadOid: git(repo, 'rev-parse', 'epic/5'),
      verificationReason: 'test failed',
      title: 'Resolver epic',
      body: 'Preserve the public API.',
      url: 'https://example.test/issues/5',
      resolvePrompt: 'Fix Epic {ref}: {title}\n{description}\n{url}',
    });

    const stored = await attempts.get(attempt.id);
    expect(cwd).toEqual([liveWorktree]);
    expect(stored).toMatchObject({ sessionId: 'epic-resolve-session' });
    expect(stored.prompt).toBeNull();
    expect(JSON.parse(stored.usage ?? '{}')).toMatchObject({ totals: { totalTokens: 15 } });
    expect(await attempts.listToolCalls(attempt.id)).toEqual(new Map([['Read', 1]]));
    const epicDir = await archive.ensureEpic(workspace.id, trackerRef(5));
    const archived = readFileSync(join(epicDir, 'attempts', String(attempt.number), 'resolution', 'epic-resolve-1', 'prompt.md'), 'utf8');
    expect(archived).toContain('Fix Epic 5: Resolver epic\nPreserve the public API.\nhttps://example.test/issues/5');
    expect(archived).toContain('## Failing Epic verification\ntest failed');
    expect(archived).toContain('CUSTOM SUFFIX for epic/5.');
    expect((await attempts.listEvents(attempt.id)).map((e) => e.payload)).toContainEqual({
      event: 'epic-resolve',
      kind: 'verification',
      locator: 'resolution/epic-resolve-1/prompt.md',
      promptIndex: 0,
    });
    expect(updates).toContainEqual(expect.objectContaining({ attemptId: attempt.id, payload: expect.objectContaining({ sessionUpdate: 'tool_call' }) }));
    expect(await attempts.listSteps(attempt.id)).toContainEqual(expect.objectContaining({ type: 'implementation', state: 'passed', logLocator: expect.stringContaining('session:') }));
    expect(git(repo, 'worktree', 'list')).toContain(liveWorktree);
    git(repo, 'worktree', 'remove', '--force', liveWorktree);
  });

  const refreshPromptDriven = async (name: string, override?: Parameters<WorkspaceService['update']>[1]): Promise<string> => {
    const workspaces = new WorkspaceService(asyncDb, settingsStore);
    const workspace = await workspaces.create({ name, workingDir: repo });
    await tasks.syncEpics(workspace.id, [{ ref: trackerRef(5), kind: 'epic' }]);
    if (override) await workspaces.update(workspace.id, override);
    const driven: string[] = [];
    const runner = new Runner(tasks, asyncDb, () => baselineConfig(), {
      ...executionPlumbing(),
      archive: new TaskArchive({ dataDir: join(dir, 'data'), ensureArchiveId: async () => 'unused', workspaceName: async () => workspace.name }),
      worktreesDir: join(dir, 'worktrees'),
      getWorkspace: async (id) => (id === null ? undefined : workspaces.get(id)),
      criticDrive: {
        run: async (req) => {
          driven.push(req.prompt);
          writeFileSync(join(req.cwd, 'shared.txt'), 'resolved\n');
          git(req.cwd, 'add', '-A');
          git(req.cwd, 'commit', '--no-edit');
          return { output: 'done', permissionRequests: [] };
        },
      },
    });
    git(repo, 'checkout', '--detach');
    let retried = false;
    await runner.enqueueEpicRefreshResolution(
      { ref: trackerRef(5), workspaceId: workspace.id, repoDir: repo, defaultBranch: 'develop' },
      'both changed shared.txt',
      () => {},
      async () => { retried = true; },
    );
    await waitFor(async () => retried);
    expect(driven).toHaveLength(1);
    return driven[0]!;
  };

  it('expands fragments in the default Epic refresh prompt, shared with the conflict prompts', async () => {
    const prompt = await refreshPromptDriven('Refresh default');
    expect(prompt).not.toContain('{fragment.');
    expect(prompt).toMatch(/^## Epic integration refresh — merge conflict resolution\nMerging `develop` into the Epic integration branch `epic\/5` conflicted:\n/);
    expect(prompt).toContain('has `epic/5` checked out with that merge in progress');
    expect(prompt).toContain("keeps both `epic/5`'s and `develop`'s work");
    expect(prompt.endsWith('Then complete the merge with `git commit --no-edit`.')).toBe(true);
    expect(prompt).not.toContain('Do not run `git commit`');
  });

  it('applies the Workspace Epic refresh prompt and conflict-resolution fragment over the global defaults', async () => {
    const prompt = await refreshPromptDriven('Refresh override', {
      mergeEpicRefreshPrompt: 'WS refresh {branch}: {fragment.conflictResolution}',
      promptFragmentConflictResolution: 'WS RESOLUTION for {taskBranch} into {baseBranch}',
    });
    expect(prompt).toBe('WS refresh epic/5: WS RESOLUTION for develop into epic/5');
  });

  it('applies the Workspace Epic verification suffix and failing-verification fragment, expanding fragments in the suffix', async () => {
    const workspaces = new WorkspaceService(asyncDb, settingsStore);
    const workspace = await workspaces.create({ name: 'Suffix override', workingDir: repo });
    await tasks.syncEpics(workspace.id, [{ ref: trackerRef(5), kind: 'epic' }]);
    const attempts = new AttemptStore(asyncDb);
    const attempt = await attempts.createForEpic({ workspaceId: workspace.id, epicRef: trackerRef(5) });
    await workspaces.update(workspace.id, {
      verifyEpicResolveSuffix: 'WS SUFFIX for {branch}. {fragment.readOnlyRestraint}',
      promptFragmentEpicFailingVerification: 'WS FAILURE: {reason}',
      promptFragmentReadOnlyRestraint: 'WS RESTRAINT',
    });
    const liveWorktree = join(dir, 'epic-suffix');
    git(repo, 'worktree', 'add', liveWorktree, 'epic/5');
    const driven: string[] = [];
    const runner = new Runner(tasks, asyncDb, () => baselineConfig(), {
      ...executionPlumbing(),
      archive: new TaskArchive({ dataDir: join(dir, 'data'), ensureArchiveId: async () => 'unused', workspaceName: async () => workspace.name }),
      worktreesDir: join(dir, 'worktrees'),
      getWorkspace: async (id) => (id === null ? undefined : workspaces.get(id)),
      criticDrive: {
        run: async (req) => {
          driven.push(req.prompt);
          writeFileSync(join(req.cwd, 'resolved.txt'), 'fixed\n');
          git(req.cwd, 'add', 'resolved.txt');
          git(req.cwd, 'commit', '-m', 'Resolve verification');
          return { output: 'fixed', permissionRequests: [] };
        },
      },
    });
    await runner.resolveEpicVerification({
      workspaceId: workspace.id,
      epicRef: trackerRef(5),
      repoDir: repo,
      worktreePath: liveWorktree,
      attempt,
      verifiedHeadOid: git(repo, 'rev-parse', 'epic/5'),
      verificationReason: 'tests red',
      resolvePrompt: 'Fix it {fragment.readOnlyRestraint}',
    });
    expect(driven).toHaveLength(1);
    expect(driven[0]).toBe('Fix it WS RESTRAINT\n\nWS FAILURE: tests red\n\nWS SUFFIX for epic/5. WS RESTRAINT');
    git(repo, 'worktree', 'remove', '--force', liveWorktree);
  });

  it('keeps the Epic checkout in place from failed verification through the resolver', async () => {
    const workspaces = new WorkspaceService(asyncDb, settingsStore);
    const workspace = await workspaces.create({ name: 'Epic attempt', workingDir: repo });
    const tickets = epicTickets();
    await readyEpicMember(workspace.id, tickets);
    const config = baselineConfig();
    config.verify.epic.preMerge.commands = [{
      id: 'cmd-exit-1',
      command: 'node',
      args: ['-e', 'process.exit(1)'],
      env: {},
      timeoutSeconds: 10,
    }];
    const worktreesDir = join(dir, 'worktrees');
    const paths: string[] = [];
    const attemptStates: string[] = [];
    const service = new TrackerEpicService(
      tasks,
      async () => [workspace],
      {
        fireAndForget: executionPlumbing().fireAndForget,
        integration: {
          getConfig: () => config,
          mergeEpicIntegration: async () => ({ kind: 'merged', mergeOid: 'unused' }),
          criticDrive: executionPlumbing().criticDrive,
          commandSpawn: executionPlumbing().commandSpawn,
        },
        epicAttempts: new AttemptStore(asyncDb),
        dispatchEpicResolution: async (input) => {
          paths.push(input.worktreePath);
          expect(git(input.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('epic/5');
          expect(existsSync(input.worktreePath)).toBe(true);
        },
        worktreesDir,
        onEpicAttemptChanged: (attempt) => { attemptStates.push(attempt.state); },
      },
    );
    const epics = service.startWorkspace(workspace);

    await epics.reconcile(tickets, await tasks.list({ workspaceId: workspace.id }));
    await waitFor(async () => (paths.length > 0 ? true : undefined));

    const [worktreePath] = paths;
    expect(worktreePath).toBe(join(worktreesDir, `epic-${workspace.id}-5`));
    expect(existsSync(worktreePath!)).toBe(true);
    expect(git(repo, 'worktree', 'list')).toContain(worktreePath!);
    await waitFor(async () => (attemptStates.includes('failed') ? true : undefined));
    expect(attemptStates).toEqual(['running', 'failed']);
  });

  it('requeues an escalated Epic with guidance and resets its resolver budget', async () => {
    const workspaces = new WorkspaceService(asyncDb, settingsStore);
    const workspace = await workspaces.create({ name: 'Epic manual resume', workingDir: repo });
    const tickets = epicTickets();
    await readyEpicMember(workspace.id, tickets);
    const config = baselineConfig();
    config.maxAttempts = 1;
    config.verify.epic.preMerge.commands = [{ id: 'cmd-exit-1', command: 'node', args: ['-e', 'process.exit(1)'], env: {}, timeoutSeconds: 10 }];
    const guidance: string[] = [];
    const attempts = new AttemptStore(asyncDb);
    const service = new TrackerEpicService(
      tasks,
      async () => [workspace],
      {
        fireAndForget: executionPlumbing().fireAndForget,
        integration: {
          getConfig: () => config,
          mergeEpicIntegration: async () => ({ kind: 'merged', mergeOid: 'unused' }),
          criticDrive: executionPlumbing().criticDrive,
          commandSpawn: executionPlumbing().commandSpawn,
        },
        epicAttempts: attempts,
        dispatchEpicResolution: async (input) => { guidance.push(input.verificationReason); },
        worktreesDir: join(dir, 'worktrees'),
      },
    );
    const epics = service.startWorkspace(workspace);

    await epics.reconcile(tickets, await tasks.list({ workspaceId: workspace.id }));

    const escalated = await waitFor(async () => {
      const rows = await attempts.listForEpic({ workspaceId: workspace.id, epicRef: trackerRef(5) });
      const row = rows.at(-1);
      return row?.state === 'escalated' ? row : undefined;
    });

    await expect(service.rejectEpic(workspace.id, trackerRef(5), 'Keep the public API compatible.', 'fresh')).resolves.toMatchObject({ status: 'waiting' });
    expect(await attempts.get(escalated.id)).toMatchObject({ id: escalated.id, number: escalated.number, state: 'failed', feedback: 'Keep the public API compatible.' });
    expect(guidance.at(-1)).toContain('Keep the public API compatible.');
  });

  it('reclaims a crashed deterministic Epic checkout before retrying verification', async () => {
    const workspaces = new WorkspaceService(asyncDb, settingsStore);
    const workspace = await workspaces.create({ name: 'Epic attempt recovery', workingDir: repo });
    const tickets = epicTickets();
    await readyEpicMember(workspace.id, tickets);
    const config = baselineConfig();
    const worktreesDir = join(dir, 'worktrees');
    const stale = join(worktreesDir, `epic-${workspace.id}-5`);
    mkdirSync(worktreesDir, { recursive: true });
    git(repo, 'worktree', 'add', stale, 'epic/5');
    const service = new TrackerEpicService(
      tasks,
      async () => [workspace],
      {
        fireAndForget: executionPlumbing().fireAndForget,
        integration: {
          getConfig: () => config,
          mergeEpicIntegration: async () => ({ kind: 'merged', mergeOid: 'unused' }),
          criticDrive: executionPlumbing().criticDrive,
          commandSpawn: executionPlumbing().commandSpawn,
        },
        epicAttempts: new AttemptStore(asyncDb),
        dispatchEpicResolution: async () => {},
        worktreesDir,
      },
    );
    const epics = service.startWorkspace(workspace);

    await epics.reconcile(tickets, await tasks.list({ workspaceId: workspace.id }));
    await waitFor(async () => ((await tasks.epicState(workspace.id, trackerRef(5))) === 'integrated' ? true : undefined));

    expect(existsSync(stale)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(stale);
  });
});
