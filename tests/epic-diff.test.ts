/**
 * The whole-Epic diff (ADR-0018, issue #441): {@link TrackerPollerManager.epicDiff}
 * resolves the raw unified diff — the live `base...epic/<ref>` range while open,
 * the frozen `git diff <M>^1 <M>^2` from the stored merge commit once integrated
 * (surviving the branch's own retirement), and the empty string for a
 * branchless/no-op Epic or any git failure, never an error.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { TrackerPollerManager } from '../src/tracker/manager.js';
import { integrationBranchName } from '../src/execution/epic-integration.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';
import type { SettingsStore } from '../src/server/settings-store.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** A throwaway git repo on branch main with one committed file. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-diff-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

describe('TrackerPollerManager.epicDiff (ADR-0018, issue #441)', () => {
  let dataDir: string;
  let repo: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let workspaces: WorkspaceService;
  let manager: TrackerPollerManager;
  let wsId: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-epic-diff-'));
    repo = makeRepo();
    asyncDb = await openAsyncDb(dataDir);
    settingsStore = await makeSettingsStore(dataDir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    workspaces = new WorkspaceService(asyncDb, settingsStore);
    wsId = (await workspaces.create({ name: 'WS', workingDir: repo, trackerEnabled: true })).id;
    manager = new TrackerPollerManager(tasks, () => workspaces.list());
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('an open Epic diffs the live base...epic/<ref> range, showing what the branch adds', async () => {
    const ref = 10;
    git(repo, 'checkout', '-b', integrationBranchName(ref), 'main');
    writeFileSync(join(repo, 'feature.txt'), 'added by the epic\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'add feature.txt');
    git(repo, 'checkout', 'main');
    await tasks.syncEpics(wsId, [{ ref, kind: 'epic' }]);

    const raw = await manager.epicDiff(wsId, ref);
    expect(raw).toContain('feature.txt');
    expect(raw).toContain('+added by the epic');
  });

  it('an integrated Epic diffs the frozen merge commit, surviving the branch\'s own retirement', async () => {
    const ref = 11;
    const branch = integrationBranchName(ref);
    git(repo, 'checkout', '-b', branch, 'main');
    writeFileSync(join(repo, 'integrated.txt'), 'landed via the merge commit\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'epic work');
    git(repo, 'checkout', 'main');
    git(repo, 'merge', '--no-ff', '-m', 'integrate epic', branch);
    const mergeCommit = git(repo, 'rev-parse', 'HEAD');
    // The branch is retired after integration — the frozen diff must not depend on it.
    git(repo, 'branch', '-D', branch);

    await tasks.syncEpics(wsId, [{ ref, kind: 'epic' }]);
    await tasks.markEpicIntegrated(wsId, ref, { mergeCommit, memberRefs: [] });

    const raw = await manager.epicDiff(wsId, ref);
    expect(raw).toContain('integrated.txt');
    expect(raw).toContain('+landed via the merge commit');
  });

  it('a branchless/open Epic (no epic/<ref> branch ever cut) yields the empty string, not an error', async () => {
    const ref = 12;
    await tasks.syncEpics(wsId, [{ ref, kind: 'epic' }]);
    await expect(manager.epicDiff(wsId, ref)).resolves.toBe('');
  });

  it('an integrated no-op Epic (branch already matched base, null merge commit) yields the empty string', async () => {
    const ref = 13;
    await tasks.syncEpics(wsId, [{ ref, kind: 'epic' }]);
    await tasks.markEpicIntegrated(wsId, ref, { mergeCommit: null, memberRefs: [] });
    await expect(manager.epicDiff(wsId, ref)).resolves.toBe('');
  });

  it('an Epic ref with no stored row at all still resolves the live range, and yields empty when the branch is absent', async () => {
    await expect(manager.epicDiff(wsId, 999)).resolves.toBe('');
  });

  it('an unknown workspace yields the empty string rather than throwing', async () => {
    await expect(manager.epicDiff(999_999, 1)).resolves.toBe('');
  });
});
