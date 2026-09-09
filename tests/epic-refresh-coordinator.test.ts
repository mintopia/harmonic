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
import type { CriticDriveRequest } from '../src/verification/critic.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, waitFor } from './helpers.js';

const fakeGit = { revParse: async () => 'develop-tip' };

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

    await expect(coordinator.refresh({ ref: 42, repoDir: '/repo', defaultBranch: 'develop' })).resolves.toEqual({
      status: 'refreshed', oid: 'merge-oid',
    });
    expect(calls).toEqual(['epic/42<-develop']);
  });

  it('dispatches exactly one resolution turn, then escalates the Epic with the recorded conflict', async () => {
    const outcomes = [conflict('first conflict'), conflict('second conflict')];
    const resolutions: string[] = [];
    const escalations: Array<{ ref: number; reason: string }> = [];
    const coordinator = new EpicRefresh({
      git: fakeGit,
      merge: async () => outcomes.shift()!,
      dispatchResolve: async (_target, detail) => {
        resolutions.push(detail);
        return { status: 'dispatched' };
      },
      escalate: (ref, reason) => { escalations.push({ ref, reason }); },
    });

    await expect(coordinator.refresh({ ref: 7, repoDir: '/repo', defaultBranch: 'develop' })).resolves.toEqual({
      status: 'resolving', detail: 'first conflict',
    });
    await expect(coordinator.refresh({ ref: 7, repoDir: '/repo', defaultBranch: 'develop' })).resolves.toMatchObject({
      status: 'escalated',
    });
    expect(resolutions).toEqual(['first conflict']);
    expect(escalations).toEqual([{ ref: 7, reason: expect.stringContaining('second conflict') }]);
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

    const one = coordinator.refresh({ ref: 9, repoDir: '/repo', defaultBranch: 'develop' });
    const two = coordinator.refresh({ ref: 9, repoDir: '/repo', defaultBranch: 'develop' });
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

    await expect(coordinator.refresh({ ref: 12, repoDir: '/repo', defaultBranch: 'develop' })).resolves.toEqual({
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
    const target = { ref: 13, repoDir: '/repo', defaultBranch: 'develop' };

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
    const target = { ref: 14, repoDir: '/repo', defaultBranch: 'develop' };

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

  function makeRunner(drive: (req: CriticDriveRequest) => Promise<void>): Runner {
    return new Runner(tasks, asyncDb, () => baselineConfig(), {
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

    const target = { ref: 5, repoDir: repo, defaultBranch: 'develop' };
    const coordinator: EpicRefresh = new EpicRefresh({
      dispatchResolve: (t, detail) =>
        runner.enqueueEpicRefreshResolution(t, detail, (_ref, reason) => { escalations.push(reason); }, async () => {
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

    const target = { ref: 5, repoDir: repo, defaultBranch: 'develop' };
    const coordinator: EpicRefresh = new EpicRefresh({
      dispatchResolve: (t, detail) =>
        runner.enqueueEpicRefreshResolution(t, detail, (_ref, reason) => { escalations.push(reason); }, async () => {
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
      { ref: 9, repoDir: repo, defaultBranch: 'develop' },
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

    const target = { ref: 5, repoDir: repo, defaultBranch: 'develop' };
    const coordinator: EpicRefresh = new EpicRefresh({
      dispatchResolve: (t, detail) =>
        runner.enqueueEpicRefreshResolution(t, detail, (_ref, reason) => { escalations.push(reason); }, async () => {
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

  it('uses an existing Epic checkout and persists the resolver session, usage, process identity, and Step', async () => {
    const workspaces = new WorkspaceService(asyncDb, settingsStore);
    const workspace = await workspaces.create({ name: 'Epic resolver', workingDir: repo });
    await tasks.syncEpics(workspace.id, [{ ref: 5, kind: 'epic' }]);
    const attempts = new AttemptStore(asyncDb);
    const attempt = await attempts.createForEpic({ workspaceId: workspace.id, epicRef: 5 });
    const liveWorktree = join(dir, 'epic-live');
    git(repo, 'worktree', 'add', liveWorktree, 'epic/5');
    const cwd: string[] = [];
    const updates: { attemptId: number; payload: { sessionUpdate: string } }[] = [];
    const runner = new Runner(tasks, asyncDb, () => baselineConfig(), {
      worktreesDir: join(dir, 'worktrees'),
      events: {
        onAttemptLogEvent: (event) => updates.push(event),
      },
      criticDrive: {
        run: async (req) => {
          cwd.push(req.cwd);
          await req.onProcessStart?.(process.pid);
          await req.onSessionCreated?.('epic-resolve-session', { agentCapabilities: {} });
          req.onUpdate?.({ sessionUpdate: 'tool_call', kind: 'read' });
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
      epicRef: 5,
      repoDir: repo,
      worktreePath: liveWorktree,
      attempt,
      verifiedHeadOid: git(repo, 'rev-parse', 'epic/5'),
      verificationReason: 'test failed',
      resolvePrompt: 'Fix Epic {ref}: {title}',
    });

    const stored = await attempts.get(attempt.id);
    expect(cwd).toEqual([liveWorktree]);
    expect(stored).toMatchObject({ sessionId: 'epic-resolve-session', pid: null, pgid: null, procStartToken: null });
    expect(stored.prompt).toContain('Fix Epic 5: Epic #5');
    expect(JSON.parse(stored.usage ?? '{}')).toMatchObject({ totals: { totalTokens: 15 } });
    expect(await attempts.listToolCalls(attempt.id)).toEqual(new Map([['Read', 1]]));
    expect(updates).toContainEqual(expect.objectContaining({ attemptId: attempt.id, payload: expect.objectContaining({ sessionUpdate: 'tool_call' }) }));
    expect(await attempts.listSteps(attempt.id)).toContainEqual(expect.objectContaining({ type: 'implementation', state: 'passed', logLocator: expect.stringContaining('session:') }));
    expect(git(repo, 'worktree', 'list')).toContain(liveWorktree);
    git(repo, 'worktree', 'remove', '--force', liveWorktree);
  });

  it('keeps one managed Epic checkout from failed verification through the resolver, then retires it', async () => {
    const workspaces = new WorkspaceService(asyncDb, settingsStore);
    const workspace = await workspaces.create({ name: 'Epic attempt', workingDir: repo });
    await tasks.syncEpics(workspace.id, [{ ref: 5, kind: 'epic' }]);
    const config = baselineConfig();
    config.verify.epic.preMerge.commands = [{
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
      undefined,
      undefined,
      () => config,
      undefined,
      async () => ({ kind: 'merged', mergeOid: 'unused' }),
      undefined,
      undefined,
      new AttemptStore(asyncDb),
      async (input) => {
        paths.push(input.worktreePath);
        expect(git(input.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('epic/5');
        expect(existsSync(input.worktreePath)).toBe(true);
      },
      worktreesDir,
      (attempt) => { attemptStates.push(attempt.state); },
    );
    service.startWorkspace(workspace);

    await expect(service.forceIntegrateEpic(workspace.id, 5)).resolves.toEqual({
      status: 'waiting', reason: 'whole-Epic verification failed; resolver dispatched',
    });

    const [worktreePath] = paths;
    expect(worktreePath).toBe(join(worktreesDir, `epic-attempt-${workspace.id}-5`));
    expect(existsSync(worktreePath!)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(worktreePath!);
    expect(attemptStates).toEqual(['running', 'failed']);
  });

  it('requeues an escalated Epic with guidance and resets its resolver budget', async () => {
    const workspaces = new WorkspaceService(asyncDb, settingsStore);
    const workspace = await workspaces.create({ name: 'Epic manual resume', workingDir: repo });
    await tasks.syncEpics(workspace.id, [{ ref: 5, kind: 'epic' }]);
    const config = baselineConfig();
    config.maxAttempts = 1;
    config.verify.epic.preMerge.commands = [{ command: 'node', args: ['-e', 'process.exit(1)'], env: {}, timeoutSeconds: 10 }];
    const guidance: string[] = [];
    const attempts = new AttemptStore(asyncDb);
    const service = new TrackerEpicService(
      tasks,
      async () => [workspace],
      undefined,
      undefined,
      () => config,
      undefined,
      async () => ({ kind: 'merged', mergeOid: 'unused' }),
      undefined,
      undefined,
      attempts,
      async (input) => { guidance.push(input.verificationReason); },
      join(dir, 'worktrees'),
    );
    service.startWorkspace(workspace);

    await expect(service.forceIntegrateEpic(workspace.id, 5)).resolves.toMatchObject({ status: 'waiting' });
    await expect(service.forceIntegrateEpic(workspace.id, 5)).resolves.toMatchObject({ status: 'escalated' });
    const escalated = await attempts.currentForEpic({ workspaceId: workspace.id, epicRef: 5 });
    expect(escalated.state).toBe('escalated');

    await expect(service.rejectEpic(workspace.id, 5, 'Keep the public API compatible.', 'fresh')).resolves.toMatchObject({ status: 'waiting' });
    expect(await attempts.get(escalated.id)).toMatchObject({ id: escalated.id, number: escalated.number, state: 'failed', feedback: 'Keep the public API compatible.' });
    expect(guidance.at(-1)).toContain('Keep the public API compatible.');
  });

  it('reclaims a crashed deterministic Epic Attempt checkout before retrying verification', async () => {
    const workspaces = new WorkspaceService(asyncDb, settingsStore);
    const workspace = await workspaces.create({ name: 'Epic attempt recovery', workingDir: repo });
    await tasks.syncEpics(workspace.id, [{ ref: 5, kind: 'epic' }]);
    const config = baselineConfig();
    const worktreesDir = join(dir, 'worktrees');
    const stale = join(worktreesDir, `epic-attempt-${workspace.id}-5`);
    mkdirSync(worktreesDir, { recursive: true });
    git(repo, 'worktree', 'add', stale, 'epic/5');
    const service = new TrackerEpicService(
      tasks,
      async () => [workspace],
      undefined,
      undefined,
      () => config,
      undefined,
      async () => ({ kind: 'merged', mergeOid: 'unused' }),
      undefined,
      undefined,
      new AttemptStore(asyncDb),
      async () => {},
      worktreesDir,
    );
    service.startWorkspace(workspace);

    await expect(service.forceIntegrateEpic(workspace.id, 5)).resolves.toEqual({
      status: 'integrated',
      oid: 'unused',
    });

    expect(existsSync(stale)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(stale);
  });
});
