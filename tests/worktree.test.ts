import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed README. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

describe('worktree isolation mode', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  async function runWorktreeTask(repo: string, files: Record<string, string>): Promise<{ taskId: number; runId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: files }),
      workingDir: repo,
      isolationMode: 'worktree',
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(
      async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review',
    );
    return { taskId: created.body.id, runId: started.body.id };
  }

  it('executes on its own branch in a temp worktree, removed afterwards with the branch kept', async () => {
    const repo = makeRepo();
    const { taskId, runId } = await runWorktreeTask(repo, { 'feature.txt': 'made by agent\n' });

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.branch).toBe(`agentdeck/task-${taskId}-run-1`);
    expect(run.baseBranch).toBe('main');

    // The branch exists and carries the file; the checkout was never touched.
    expect(git(repo, 'branch', '--list', run.branch)).toContain(run.branch);
    expect(git(repo, 'show', `${run.branch}:feature.txt`)).toBe('made by agent');
    expect(existsSync(join(repo, 'feature.txt'))).toBe(false);

    // The temporary worktree is gone — only the main checkout remains.
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('accept merges the run branch into the base branch', async () => {
    const repo = makeRepo();
    const { taskId } = await runWorktreeTask(repo, { 'feature.txt': 'merged\n' });

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.state).toBe('completed');
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('merged\n');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('a merge conflict on accept returns the task to awaiting-review with the conflict surfaced', async () => {
    const repo = makeRepo();
    // Two tasks branch off the same main and touch the same file.
    const a = await runWorktreeTask(repo, { 'conflict.txt': 'version A\n' });
    const b = await runWorktreeTask(repo, { 'conflict.txt': 'version B\n' });

    expect((await server.api('POST', `/api/tasks/${a.taskId}/accept`)).status).toBe(200);

    const conflicted = await server.api('POST', `/api/tasks/${b.taskId}/accept`);
    expect(conflicted.status).toBe(409);
    expect(conflicted.body.error.message.toLowerCase()).toContain('conflict');

    const task = (await server.api('GET', `/api/tasks/${b.taskId}`)).body;
    expect(task.state).toBe('awaiting-review');
    // The conflict detail is stored on the run for the inbox.
    const run = (await server.api('GET', `/api/runs/${b.runId}`)).body;
    expect(run.reviewFeedback.toLowerCase()).toContain('conflict');
    // Nothing half-merged left behind.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('reject leaves the branch untouched and the base branch unchanged', async () => {
    const repo = makeRepo();
    const { taskId, runId } = await runWorktreeTask(repo, { 'feature.txt': 'unwanted\n' });

    const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, { feedback: 'nope' });
    expect(rejected.status).toBe(200);

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(git(repo, 'branch', '--list', run.branch)).toContain(run.branch);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(false);
  });

  it('serves diffstat and branch info for the review inbox', async () => {
    const repo = makeRepo();
    const { runId } = await runWorktreeTask(repo, { 'feature.txt': 'diff me\n' });

    const diff = await server.api('GET', `/api/runs/${runId}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.body.branch).toBe(`agentdeck/task-${(await server.api('GET', `/api/runs/${runId}`)).body.taskId}-run-1`);
    expect(diff.body.stat).toContain('feature.txt');
  });

  it('fails the run cleanly when the working directory is not a git repo', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'agentdeck-plain-'));
    const created = await server.api('POST', '/api/tasks', {
      prompt: 'anything',
      workingDir: notARepo,
      isolationMode: 'worktree',
    });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'failed');
    const runs = (await server.api('GET', `/api/tasks/${created.body.id}/runs`)).body.runs;
    expect(runs[0].reason).toBeTruthy();
  });
});
