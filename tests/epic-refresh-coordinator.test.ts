import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpicRefreshCoordinator, type EpicRefreshOutcome } from '../src/execution/epic-refresh-coordinator.js';
import { MergeTrainCoordinator } from '../src/execution/merge-train-coordinator.js';
import type { MergeIntoBaseOutcome } from '../src/execution/branch-merge.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { Runner } from '../src/execution/runner.js';
import type { CriticDriveRequest } from '../src/verification/critic.js';
import { allWorkspaces, waitFor } from './helpers.js';

const train = () => new MergeTrainCoordinator({
  escalate: async () => {},
});

/** The unit cases fake the merge, so the default-branch tip the refresh pins is faked too. */
const fakeGit = { revParse: async () => 'develop-tip' };

const conflict = (detail = 'both changed package.json'): MergeIntoBaseOutcome => ({
  ok: false,
  reason: 'conflict',
  detail,
});

describe('EpicRefreshCoordinator', () => {
  it('merges develop into an integration branch through the merge train', async () => {
    const calls: string[] = [];
    const coordinator = new EpicRefreshCoordinator({
      train: train(),
      git: fakeGit,
      merge: async ({ baseBranch, branch }) => {
        calls.push(`${baseBranch}<-${branch}`);
        return { ok: true, mode: 'cas', oid: 'merge-oid', baseBranch, branch, rebased: false };
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
    const coordinator = new EpicRefreshCoordinator({
      train: train(),
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

  it('serializes refreshes for the same integration branch', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const starts: number[] = [];
    const coordinator = new EpicRefreshCoordinator({
      train: train(),
      git: fakeGit,
      merge: async () => {
        starts.push(starts.length + 1);
        if (starts.length === 1) await first;
        return { ok: true, mode: 'cas', oid: `oid-${starts.length}`, baseBranch: 'epic/9', branch: 'develop', rebased: false };
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
    const coordinator = new EpicRefreshCoordinator({
      train: train(),
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
    const coordinator = new EpicRefreshCoordinator({
      train: train(),
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
    const coordinator = new EpicRefreshCoordinator({
      train: train(),
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
    // The failed dispatch set no `resolving` flag: the next conflict routes to
    // dispatch again, never to the still-conflicts-after-corrective-turn path.
    await expect(coordinator.refresh(target)).resolves.toEqual({
      status: 'escalated',
      reason: 'no active Epic member is available to resolve refresh conflict for epic/14',
    });
  });
});

/**
 * Issue #315 — the corrective turn operates on the Epic integration branch
 * itself: `epic/<ref>` is checked out into a dedicated worktree, the
 * conflicted default-branch merge is reproduced there (markers in place), and
 * one bounded agent turn resolves and commits it; the refresh then re-merges to
 * completion. Exercised through the REAL `Runner.enqueueEpicRefreshResolution`
 * and the real `mergeIntoBase` against a throwaway git repo — only the agent
 * drive is faked.
 */
describe('epic refresh corrective turn (issue #315)', () => {
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  let dir: string;
  let repo: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runs: RunStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-refresh-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    runs = new RunStore(asyncDb);
    // A repo whose default branch is develop, with epic/5 cut off it and BOTH
    // sides editing shared.txt — the develop→epic/5 refresh merge conflicts.
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

  function makeRunner(drive: (req: CriticDriveRequest) => Promise<void>, mergeTrain?: MergeTrainCoordinator): Runner {
    return new Runner(runs, tasks, new WorkContextLeaseStore(asyncDb), asyncDb, () => defaultConfig(), {
      worktreesDir: join(dir, 'worktrees'),
      criticDrive: {
        run: async (req) => {
          await drive(req);
          return { output: 'done', permissionRequests: [] };
        },
      },
      ...(mergeTrain ? { mergeTrain } : {}),
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
    const sharedTrain = train();
    const runner = makeRunner(async (req) => {
      driveCalls.push(req);
      // The reproduced merge is in progress in the epic/5 worktree — resolve
      // the markers and complete it, exactly what the prompt asks the agent to do.
      expect(git(req.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('epic/5');
      expect(git(req.cwd, 'status', '--porcelain')).toContain('UU shared.txt');
      writeFileSync(join(req.cwd, 'shared.txt'), 'resolved\n');
      git(req.cwd, 'add', '-A');
      git(req.cwd, 'commit', '--no-edit');
    }, sharedTrain);
    await runningMember('epic/5');
    // Nobody has develop checked out, so the refresh merge takes the CAS path.
    git(repo, 'checkout', '--detach');

    const target = { ref: 5, repoDir: repo, defaultBranch: 'develop' };
    const coordinator: EpicRefreshCoordinator = new EpicRefreshCoordinator({
      train: sharedTrain,
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
    // epic/5 now contains develop's advance, and the resolution worktree is gone.
    git(repo, 'merge-base', '--is-ancestor', 'develop', 'epic/5');
    expect(git(repo, 'worktree', 'list').split('\n').filter(Boolean)).toHaveLength(1);
    // The flag settled: a fresh conflict-free refresh is an ordinary refresh.
    await expect(coordinator.refresh(target)).resolves.toMatchObject({ status: 'refreshed' });
  });

  it('an unresolved corrective turn re-conflicts and escalates, leaving no worktree and no stranded flag', async () => {
    const escalations: string[] = [];
    const retryOutcomes: EpicRefreshOutcome[] = [];
    const runner = makeRunner(async () => {
      // The agent turn achieves nothing: the half-merge is discarded with the worktree.
    });
    await runningMember('epic/5');
    git(repo, 'checkout', '--detach');

    const target = { ref: 5, repoDir: repo, defaultBranch: 'develop' };
    const coordinator: EpicRefreshCoordinator = new EpicRefreshCoordinator({
      train: train(),
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
    await runningMember('epic/9'); // a host exists, but no epic/9 branch does

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
    const sharedTrain = train();
    const runner = makeRunner(async (req) => {
      driveCalls.push(req);
      expect(git(req.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('epic/5');
      expect(git(req.cwd, 'status', '--porcelain')).toContain('UU shared.txt');
      writeFileSync(join(req.cwd, 'shared.txt'), 'resolved\n');
      git(req.cwd, 'add', '-A');
      git(req.cwd, 'commit', '--no-edit');
    }, sharedTrain);
    // No member is `working` — the Epic is done. The refresh must still run the
    // corrective turn, borrowing the Workspace default harness/model.
    git(repo, 'checkout', '--detach');

    const target = { ref: 5, repoDir: repo, defaultBranch: 'develop' };
    const coordinator: EpicRefreshCoordinator = new EpicRefreshCoordinator({
      train: sharedTrain,
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
    // The corrective turn ran on the default harness (no member to borrow from).
    const cfg = defaultConfig();
    expect(driveCalls).toHaveLength(1);
    expect(driveCalls[0]!.harnessId).toBe(cfg.defaults.harness);
    expect(driveCalls[0]!.model).toBe(cfg.harnesses[cfg.defaults.harness]!.defaultModel);
    git(repo, 'merge-base', '--is-ancestor', 'develop', 'epic/5');
  });
});
