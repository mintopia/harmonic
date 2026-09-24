import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { SessionStore } from '../src/domain/sessions.js';
import { TaskEventStore } from '../src/domain/task-events.js';
import { WorkspaceProvisioner } from '../src/execution/workspace-provisioner.js';
import { Git } from '../src/execution/git.js';
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

  it('reuses a worktree left dirty by a killed attempt without committing the leftover work (the start-of-Attempt rebase autostashes it instead)', async () => {
    const task = await tasks.create({ prompt: 'recover me', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const branch = `harmonic/task-${task.id}`;
    const run = await attempts.update((await attempts.create(task.id)).id, { branch, baseBranch: 'main' });
    const worktreePath = join(worktreesDir, `task-${task.id}`);

    // Simulate a prior attempt that provisioned the worktree and was killed mid-turn.
    git(repo, 'worktree', 'add', '-b', branch, worktreePath, 'main');
    writeFileSync(join(worktreePath, 'README.md'), 'uncommitted work from the killed attempt\n');
    expect(git(worktreePath, 'status', '--porcelain')).not.toBe('');
    const dirtyOid = git(worktreePath, 'rev-parse', 'HEAD');

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
    expect(git(worktreePath, 'status', '--porcelain')).not.toBe('');
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(dirtyOid);
    expect(git(worktreePath, 'diff', 'README.md')).toContain('uncommitted work from the killed attempt');

    const events = (await attempts.listEvents(run.id)).map((e) => e.payload as Record<string, unknown>);
    expect(events.find((e) => e.event === 'work-committed')).toBeUndefined();
  });
});

describe('WorkspaceProvisioner git-visibility events', () => {
  let dir: string;
  let repo: string;
  let worktreesDir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-provisioner-events-'));
    repo = makeRepo();
    worktreesDir = mkdtempSync(join(tmpdir(), 'harmonic-provisioner-events-worktrees-'));
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

  const provisioner = () =>
    new WorkspaceProvisioner({
      attempts,
      sessionStore: new SessionStore(asyncDb),
      mergeCoordinator: { resolveBaseBranch: async () => 'main' } as unknown as MergeCoordinator,
      autoDrive: undefined,
      sessionRetirement: undefined,
      events: {},
      worktreesDir,
    });

  const eventsFor = async (attemptId: number) => (await attempts.listEvents(attemptId)).map((e) => e.payload as Record<string, unknown>);

  it('records worktree-created for a fresh worktree cut from the base branch', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const run = await attempts.create(task.id);

    await provisioner().prepareWorkspace(task, run, false);

    expect(await eventsFor(run.id)).toContainEqual({
      event: 'worktree-created',
      worktree: `task-${task.id}`,
      branch: `harmonic/task-${task.id}`,
      baseBranch: 'main',
      fromExistingBranch: false,
    });
  });

  it('records worktree-created (fromExistingBranch) when checking out an already-cut branch', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const branch = `harmonic/task-${task.id}`;
    git(repo, 'branch', branch, 'main');
    const run = await attempts.create(task.id);

    await provisioner().prepareWorkspace(task, run, false);

    expect(await eventsFor(run.id)).toContainEqual({
      event: 'worktree-created',
      worktree: `task-${task.id}`,
      branch,
      baseBranch: null,
      fromExistingBranch: true,
    });
  });

  it('records worktree-create-failed and rethrows when git cannot cut the worktree', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const run = await attempts.create(task.id);
    const broken = new WorkspaceProvisioner({
      attempts,
      sessionStore: new SessionStore(asyncDb),
      mergeCoordinator: { resolveBaseBranch: async () => 'does-not-exist' } as unknown as MergeCoordinator,
      autoDrive: undefined,
      sessionRetirement: undefined,
      events: {},
      worktreesDir,
    });

    await expect(broken.prepareWorkspace(task, run, false)).rejects.toThrow();

    const events = await eventsFor(run.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'worktree-create-failed', worktree: `task-${task.id}`, branch: `harmonic/task-${task.id}`, baseBranch: 'does-not-exist' });
  });

  it('records worktree-discarded for an orphaned worktree path reused on resume', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const branch = `harmonic/task-${task.id}`;
    const run = await attempts.update((await attempts.create(task.id)).id, { branch, baseBranch: 'main' });
    git(repo, 'branch', branch, 'main');
    const worktreePath = join(worktreesDir, `task-${task.id}`);
    execFileSync('mkdir', ['-p', worktreePath]);
    writeFileSync(join(worktreePath, 'stray.txt'), 'orphaned\n');

    await provisioner().prepareWorkspace(task, run, true);

    expect(await eventsFor(run.id)).toContainEqual({ event: 'worktree-discarded', worktree: `task-${task.id}` });
  });

  it('finalizeWorkspace records worktree-removed when the worktree is not retained', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const run = await attempts.create(task.id);
    const provisionerInstance = provisioner();
    const workspace = await provisionerInstance.prepareWorkspace(task, run, false);

    await provisionerInstance.finalizeWorkspace(task, run, 1, workspace);

    expect(await eventsFor(run.id)).toContainEqual({ event: 'worktree-removed', worktree: `task-${task.id}` });
    expect(existsSync(workspace.cwd)).toBe(false);
  });

  it('finalizeWorkspace records worktree-retained when a Session binds the worktree', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const sessionStore = new SessionStore(asyncDb);
    const session = await sessionStore.recordDispatch({
      harness: 'claude',
      harnessSessionId: 'sess-1',
      model: 'm',
      cwd: '/tmp/work',
      workspaceId: (await allWorkspaces(asyncDb, settingsStore)())[0]!.id,
      mcpTemplates: [],
      capabilities: undefined,
      adapterVersion: 'claude@1',
      now: Date.now(),
    });
    const run = await attempts.update((await attempts.create(task.id)).id, { sessionRowId: session.id });
    const provisionerInstance = new WorkspaceProvisioner({
      attempts,
      sessionStore,
      mergeCoordinator: { resolveBaseBranch: async () => 'main' } as unknown as MergeCoordinator,
      autoDrive: undefined,
      sessionRetirement: undefined,
      events: {},
      worktreesDir,
    });
    const workspace = await provisionerInstance.prepareWorkspace(task, run, false);

    await provisionerInstance.finalizeWorkspace(task, run, 1, workspace);

    expect(await eventsFor(run.id)).toContainEqual({ event: 'worktree-retained', worktree: `task-${task.id}` });
    expect(existsSync(workspace.cwd)).toBe(true);
  });

  it('finalizeWorkspace leaves uncommitted work at attempt end uncommitted (no auto-commit)', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const run = await attempts.create(task.id);
    const provisionerInstance = provisioner();
    const workspace = await provisionerInstance.prepareWorkspace(task, run, false);
    writeFileSync(join(workspace.cwd, 'work.txt'), 'uncommitted\n');
    const headBefore = git(workspace.cwd, 'rev-parse', 'HEAD');

    await provisionerInstance.finalizeWorkspace(task, run, 3, workspace);

    const branch = (await attempts.get(run.id)).branch;
    expect(branch).toBeTruthy();
    expect(git(repo, 'rev-parse', branch!)).toBe(headBefore);
    const events = await eventsFor(run.id);
    expect(events.find((e) => e.event === 'work-committed')).toBeUndefined();
  });

  it('cleanupClosed falls back to the Task\'s own event log when there is no Attempt to attach worktree/branch cleanup to (owner decision: task_events)', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const branch = `harmonic/task-${task.id}`;
    const worktreePath = join(worktreesDir, `task-${task.id}`);
    git(repo, 'worktree', 'add', '-b', branch, worktreePath, 'main');

    const taskEvents = new TaskEventStore(asyncDb);
    const provisionerInstance = new WorkspaceProvisioner({
      attempts,
      sessionStore: new SessionStore(asyncDb),
      mergeCoordinator: { resolveBaseBranch: async () => 'main' } as unknown as MergeCoordinator,
      autoDrive: undefined,
      sessionRetirement: undefined,
      events: {},
      worktreesDir,
      taskEvents,
    });

    await provisionerInstance.cleanupClosed(task, undefined);

    expect(existsSync(worktreePath)).toBe(false);
    expect(await Git.branchExists(repo, branch)).toBe(false);
    const events = (await taskEvents.listEvents(task.id)).map((e) => e.payload as Record<string, unknown>);
    expect(events).toContainEqual({ event: 'worktree-removed', worktree: `task-${task.id}` });
    expect(events).toContainEqual({ event: 'branch-deleted', branch });
  });
});
