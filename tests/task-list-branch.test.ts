import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { Git } from '../src/execution/git.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed README. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

describe('task list payload: latest run branch', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('carries the latest run\'s branch once done, spawning no git process', async () => {
    const repo = makeRepo();
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'feature.txt': 'made by agent\n' } }),
      workingDir: repo,
      isolationMode: 'worktree',
    });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(
      async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done',
    );

    // No Git.* method may run during a list fetch — the list endpoint is read
    // from the persisted `runs.branch`/`runs.stat` columns, never shells out
    // (issue #36: a board of N cards spawns 0 git processes).
    const gitSpies = Object.keys(Git).map((method) => vi.spyOn(Git as any, method));
    const list = await server.api('GET', '/api/tasks');
    for (const spy of gitSpies) expect(spy).not.toHaveBeenCalled();
    gitSpies.forEach((s) => s.mockRestore());

    const task = list.body.tasks.find((t: any) => t.id === created.body.id);
    expect(task.branch).toBe(`harmonic/task-${created.body.id}`);
    // The diffstat was snapshotted at settle and rides the same payload.
    expect(task.stat).toContain('insertion');
    // The run-scoped endpoint serves that same snapshot, so the card and Task
    // detail can never show two different stats.
    const runs = await server.api('GET', `/api/tasks/${created.body.id}/attempts`);
    const diff = await server.api('GET', `/api/attempts/${runs.body.attempts.at(-1).id}/diff`);
    expect(diff.body.stat).toBe(task.stat);
  });

  it('is null for a direct-mode task (no run yet)', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'noop' });
    const list = await server.api('GET', '/api/tasks');
    const task = list.body.tasks.find((t: any) => t.id === created.body.id);
    expect(task.branch).toBeNull();
    expect(task.stat).toBeNull();
  });
});
