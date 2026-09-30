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

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-startoid-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

describe('Attempt start captures startOid', () => {
  let dir: string;
  let repo: string;
  let worktreesDir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let attempts: AttemptStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-startoid-'));
    repo = makeRepo();
    worktreesDir = mkdtempSync(join(tmpdir(), 'harmonic-startoid-worktrees-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb, repo);
    const settingsStore = await makeSettingsStore(dir);
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

  it('direct mode records the working directory HEAD before the harness runs', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'direct' });
    const run = await attempts.create(task.id);
    expect(run.startOid).toBeNull();

    await provisioner().prepareWorkspace(task, run, false);

    expect((await attempts.get(run.id)).startOid).toBe(head);
  });

  it('worktree mode records the commit the worktree was cut from', async () => {
    const head = git(repo, 'rev-parse', 'main');
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const run = await attempts.create(task.id);

    const workspace = await provisioner().prepareWorkspace(task, run, false);

    expect(git(workspace.cwd, 'rev-parse', 'HEAD')).toBe(head);
    expect((await attempts.get(run.id)).startOid).toBe(head);
  });

  it('a later Attempt records where its own work began, not the first Attempt start', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'direct' });
    const first = await attempts.create(task.id);
    await provisioner().prepareWorkspace(task, first, false);
    writeFileSync(join(repo, 'more.txt'), 'more\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'second');
    const second = await attempts.ensureForRun(task.id, 2, Date.now());

    await provisioner().prepareWorkspace(task, second, true);

    expect((await attempts.get(first.id)).startOid).not.toBe(git(repo, 'rev-parse', 'HEAD'));
    expect((await attempts.get(second.id)).startOid).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('keeps the original startOid when the same Attempt is prepared again', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'direct' });
    const run = await attempts.create(task.id);
    await provisioner().prepareWorkspace(task, run, false);
    const original = (await attempts.get(run.id)).startOid;
    writeFileSync(join(repo, 'more.txt'), 'more\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'second');

    await provisioner().prepareWorkspace(task, await attempts.get(run.id), true);

    expect((await attempts.get(run.id)).startOid).toBe(original);
  });

  it('stores null and still prepares the workspace when HEAD cannot be read', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'harmonic-startoid-empty-'));
    try {
      execFileSync('git', ['init', '-b', 'main', empty], { encoding: 'utf8' });
      const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: empty, isolationMode: 'direct' });
      const run = await attempts.create(task.id);

      const workspace = await provisioner().prepareWorkspace(task, run, false);

      expect(workspace.cwd).toBe(empty);
      expect((await attempts.get(run.id)).startOid).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
