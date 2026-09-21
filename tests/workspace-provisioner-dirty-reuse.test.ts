import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { SessionStore } from '../src/domain/sessions.js';
import { WorkspaceProvisioner } from '../src/execution/workspace-provisioner.js';
import type { MergeCoordinator } from '../src/execution/merge-coordinator.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';
import type { SettingsStore } from '../src/server/settings-store.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-provisioner-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

describe('WorkspaceProvisioner.prepareWorkspace reusing a worktree left dirty by a killed attempt (worktree isolation)', () => {
  let dir: string;
  let repo: string;
  let worktreesDir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-provisioner-'));
    repo = makeRepo();
    worktreesDir = mkdtempSync(join(tmpdir(), 'harmonic-provisioner-worktrees-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb, repo);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    attempts = new AttemptStore(asyncDb);
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
  });

  it('commits leftover uncommitted work onto the branch so the rebase step no longer refuses a dirty tree (issue: killed attempt skips finalizeWorkspace)', async () => {
    const task = await tasks.create({ prompt: 'recover me', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const branch = `harmonic/task-${task.id}`;
    const run = await attempts.update((await attempts.create(task.id)).id, { branch, baseBranch: 'main' });
    const worktreePath = join(worktreesDir, `task-${task.id}`);

    // Simulate a prior attempt that provisioned the worktree and got killed
    // before finalizeWorkspace's commitAll ran.
    git(repo, 'worktree', 'add', '-b', branch, worktreePath, 'main');
    writeFileSync(join(worktreePath, 'README.md'), 'uncommitted work from the killed attempt\n');
    expect(git(worktreePath, 'status', '--porcelain')).not.toBe('');

    // Base branch advances externally, so a real rebase has something to replay.
    writeFileSync(join(repo, 'unrelated.txt'), 'advanced on main\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'main advanced externally');

    const rebaseFailsOnDirtyTree = () => git(worktreePath, 'rebase', 'main');
    expect(rebaseFailsOnDirtyTree).toThrow();

    const provisioner = new WorkspaceProvisioner({
      attempts,
      sessionStore: new SessionStore(asyncDb),
      mergeCoordinator: { resolveBaseBranch: async () => 'main' } as unknown as MergeCoordinator,
      autoDrive: undefined,
      sessionRetirement: undefined,
      events: {},
      worktreesDir,
    });

    const workspace = await provisioner.prepareWorkspace(task, run, true);

    expect(workspace.cwd).toBe(worktreePath);
    expect(git(worktreePath, 'status', '--porcelain')).toBe('');
    expect(git(worktreePath, 'log', '-1', '--format=%s')).toBe(`harmonic: task ${task.id} recovered leftover work`);

    expect(() => git(worktreePath, 'rebase', 'main')).not.toThrow();
    expect(git(worktreePath, 'log', '--format=%s').split('\n')).toContain('main advanced externally');
  });
});
