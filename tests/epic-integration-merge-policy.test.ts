import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { Runner } from '../src/execution/runner.js';
import { runMergePolicy, type MergePolicyDeps, type PostMergeCheckResult } from '../src/execution/merge-policy.js';
import type { PostMergeHook } from '../src/execution/branch-merge.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

describe('Runner.mergeEpicIntegration (epic → develop, ADR-0001 #382)', () => {
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  let dir: string;
  let repo: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-integrate-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    repo = join(dir, 'repo');
    execFileSync('git', ['init', '-b', 'develop', repo], { encoding: 'utf8' });
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'branch', 'epic/5');
    writeFileSync(join(repo, 'develop.txt'), 'develop advance\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'develop side');
    const epicWt = join(dir, 'epic-seed');
    git(repo, 'worktree', 'add', epicWt, 'epic/5');
    writeFileSync(join(epicWt, 'epic.txt'), 'epic work\n');
    git(epicWt, 'add', '-A');
    git(epicWt, 'commit', '-m', 'epic side');
    git(repo, 'worktree', 'remove', '--force', epicWt);
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeRunner = (postMerge?: PostMergeHook): Runner =>
    new Runner(tasks, asyncDb, () => baselineConfig(), {
      worktreesDir: join(dir, 'worktrees'),
      criticDrive: { run: async () => ({ output: '', permissionRequests: [] }) },
      ...(postMerge ? { postMerge } : {}),
    });

  const green = async (): Promise<PostMergeCheckResult> => ({ pass: true, output: '' });

  it('merges epic/<ref> into develop with a merge commit and fires the post-merge refresh hook', async () => {
    const refreshed: string[] = [];
    const runner = makeRunner(async ({ baseBranch }) => {
      refreshed.push(baseBranch);
    });

    const outcome = await runner.mergeEpicIntegration({
      repoDir: repo,
      epicRef: 5,
      defaultBranch: 'develop',
      integrationBranch: 'epic/5',
      runPostMergeCheck: green,
    });

    expect(outcome.kind).toBe('merged');
    expect(() => git(repo, 'merge-base', '--is-ancestor', 'epic/5', 'develop')).not.toThrow();
    expect(() => git(repo, 'cat-file', '-e', 'develop:epic.txt')).not.toThrow();
    expect(() => git(repo, 'cat-file', '-e', 'develop:develop.txt')).not.toThrow();
    expect(refreshed).toEqual(['develop']);
  });

  it('reverts and escalates (post-merge-red) when the post-merge check fails, leaving develop green', async () => {
    const runner = makeRunner();
    const before = git(repo, 'rev-parse', 'develop');

    const outcome = await runner.mergeEpicIntegration({
      repoDir: repo,
      epicRef: 5,
      defaultBranch: 'develop',
      integrationBranch: 'epic/5',
      runPostMergeCheck: async () => ({ pass: false, output: 'suite failed on the merged tip' }),
    });

    expect(outcome).toMatchObject({ kind: 'escalated', reason: 'post-merge-red' });
    expect(() => git(repo, 'cat-file', '-e', 'develop:epic.txt')).toThrow();
    expect(git(repo, 'rev-parse', 'develop')).not.toBe(before);
  });

  it('escalates (conflict) when the epic and develop conflict and resolution is disabled', async () => {
    const conflictRepo = join(dir, 'conflict-repo');
    execFileSync('git', ['init', '-b', 'develop', conflictRepo], { encoding: 'utf8' });
    git(conflictRepo, 'config', 'user.name', 'Test');
    git(conflictRepo, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(conflictRepo, 'shared.txt'), 'base\n');
    git(conflictRepo, 'add', '-A');
    git(conflictRepo, 'commit', '-m', 'init');
    git(conflictRepo, 'branch', 'epic/9');
    writeFileSync(join(conflictRepo, 'shared.txt'), 'develop change\n');
    git(conflictRepo, 'commit', '-am', 'develop side');
    const wt = join(dir, 'epic9-seed');
    git(conflictRepo, 'worktree', 'add', wt, 'epic/9');
    writeFileSync(join(wt, 'shared.txt'), 'epic change\n');
    git(wt, 'commit', '-am', 'epic side');
    git(conflictRepo, 'worktree', 'remove', '--force', wt);

    const runner = makeRunner();
    const outcome = await runner.mergeEpicIntegration({
      repoDir: conflictRepo,
      epicRef: 9,
      defaultBranch: 'develop',
      integrationBranch: 'epic/9',
      runPostMergeCheck: green,
    });

    expect(outcome).toMatchObject({ kind: 'escalated', reason: 'conflict' });
    expect(git(conflictRepo, 'status', '--porcelain')).toBe('');
  });

  describe('base-repo restore after a non-default base merge (member → epic/<ref>)', () => {
    const noopDeps: MergePolicyDeps = {
      resolveConflictTurn: async () => {},
      runPostMergeCheck: async () => ({ pass: true, output: '' }),
      escalate: async () => {},
    };

    it('restores the parked default branch after merging a member onto epic/<ref>', async () => {
      const memberWt = join(dir, 'member-seed');
      git(repo, 'worktree', 'add', memberWt, '-b', 'harmonic/task-77', 'epic/5');
      writeFileSync(join(memberWt, 'member.txt'), 'member work\n');
      git(memberWt, 'add', '-A');
      git(memberWt, 'commit', '-m', 'member work');
      git(repo, 'worktree', 'remove', '--force', memberWt);
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
      const epicBefore = git(repo, 'rev-parse', 'epic/5');

      const outcome = await runMergePolicy(
        { baseDir: repo, baseBranch: 'epic/5', taskBranch: 'harmonic/task-77', conflictResolveTurns: 0, postMergeCheck: false },
        noopDeps,
      );

      expect(outcome.kind).toBe('merged');
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
      expect(git(repo, 'rev-parse', 'epic/5')).not.toBe(epicBefore);
      expect(() => git(repo, 'merge-base', '--is-ancestor', 'harmonic/task-77', 'epic/5')).not.toThrow();
    });

    it('restores the parked branch even when the merge escalates (post-merge-red revert)', async () => {
      const memberWt = join(dir, 'member-seed-2');
      git(repo, 'worktree', 'add', memberWt, '-b', 'harmonic/task-88', 'epic/5');
      writeFileSync(join(memberWt, 'member2.txt'), 'member work\n');
      git(memberWt, 'add', '-A');
      git(memberWt, 'commit', '-m', 'member work');
      git(repo, 'worktree', 'remove', '--force', memberWt);

      const outcome = await runMergePolicy(
        { baseDir: repo, baseBranch: 'epic/5', taskBranch: 'harmonic/task-88', conflictResolveTurns: 0, postMergeCheck: true },
        { ...noopDeps, runPostMergeCheck: async () => ({ pass: false, output: 'red' }) },
      );

      expect(outcome).toMatchObject({ kind: 'escalated', reason: 'post-merge-red' });
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
    });
  });
});
