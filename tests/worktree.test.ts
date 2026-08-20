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
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-repo-'));
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

  async function runWorktreeTask(
    repo: string,
    files: Record<string, string>,
    opts: { baseBranch?: string } = {},
  ): Promise<{ taskId: number; runId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: files }),
      workingDir: repo,
      isolationMode: 'worktree',
      ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(
      async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review',
    );
    return { taskId: created.body.id, runId: started.body.id };
  }

  it('executes on its own branch in a temp worktree RETAINED through review, removed at Session retirement (issue #148)', async () => {
    const repo = makeRepo();
    const { taskId, runId } = await runWorktreeTask(repo, { 'feature.txt': 'made by agent\n' });

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.branch).toBe(`harmonic/task-${taskId}-run-1`);
    expect(run.baseBranch).toBe('main');

    // The branch exists and carries the file; the checkout was never touched.
    expect(git(repo, 'branch', '--list', run.branch)).toContain(run.branch);
    expect(git(repo, 'show', `${run.branch}:feature.txt`)).toBe('made by agent');
    expect(existsSync(join(repo, 'feature.txt'))).toBe(false);

    // Issue #148: the builder worktree is RETAINED through the human-rejection
    // window — it survives alongside the main checkout while the task awaits
    // review (a reject-and-continue would land in the same workspace).
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(2);

    // Accepting lands the run + retires the Session, which is the sole owner of
    // builder-worktree removal; the async retirement drain then reclaims it.
    expect((await server.api('POST', `/api/tasks/${taskId}/accept`)).status).toBe(200);
    await waitFor(async () => git(repo, 'worktree', 'list').split('\n').length === 1);
    // Only the main checkout remains — the retained worktree was removed at retirement.
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

  it('a Task with an explicit baseBranch (issue #157, ADR-0024) forks from it, not the current branch, and lands back onto it', async () => {
    const repo = makeRepo(); // current branch is main
    // A second branch carrying a commit that never touches main — the tell
    // for "did the worktree fork from feature-base, or from main (today's
    // default)?"
    git(repo, 'branch', 'feature-base');
    git(repo, 'checkout', 'feature-base');
    writeFileSync(join(repo, 'base-marker.txt'), 'from feature-base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'feature-base marker');
    git(repo, 'checkout', 'main'); // main stays checked out and current throughout

    const { taskId, runId } = await runWorktreeTask(
      repo,
      { 'feature.txt': 'made on feature-base\n' },
      { baseBranch: 'feature-base' },
    );

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.branch).toBe(`harmonic/task-${taskId}-run-1`);
    // The explicit base is persisted on the run, not the resolved-from-current default.
    expect(run.baseBranch).toBe('feature-base');
    // Proof of the fork point: the run branch carries feature-base's marker
    // commit, which never touched main.
    expect(git(repo, 'show', `${run.branch}:base-marker.txt`)).toBe('from feature-base');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    // Accept lands the run onto feature-base — the recorded base — not main.
    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.state).toBe('completed');
    expect(git(repo, 'show', 'feature-base:feature.txt')).toBe('made on feature-base');
    // main's checkout was never touched by either the fork or the landing.
    expect(existsSync(join(repo, 'feature.txt'))).toBe(false);
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
    expect(diff.body.branch).toBe(`harmonic/task-${(await server.api('GET', `/api/runs/${runId}`)).body.taskId}-run-1`);
    expect(diff.body.stat).toContain('feature.txt');
  });

  it('serialises concurrent worktree Runs on one base repo without corrupting it (issue #121)', async () => {
    const repo = makeRepo();
    // Launch several worktree Runs against the same base repo at once. Their
    // create/remove windows mutate the shared base repo; the repo-operation
    // lock must serialise them so none is left half-mutated.
    const results = await Promise.all([
      runWorktreeTask(repo, { 'a.txt': 'A\n' }),
      runWorktreeTask(repo, { 'b.txt': 'B\n' }),
      runWorktreeTask(repo, { 'c.txt': 'C\n' }),
    ]);

    // Every Run produced its own branch carrying its own file — no create
    // clobbered another mid-mutation.
    for (const { taskId, runId } of results) {
      const run = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(run.branch).toBe(`harmonic/task-${taskId}-run-1`);
      expect(git(repo, 'branch', '--list', run.branch)).toContain(run.branch);
    }
    expect(git(repo, 'show', `${(await server.api('GET', `/api/runs/${results[0].runId}`)).body.branch}:a.txt`)).toBe('A');

    // The base repo is intact: a clean tree, still on main — the repo-op lock
    // (issue #121) serialised the concurrent create windows without corruption.
    // Issue #148: each Run's builder worktree is RETAINED (bound to its Session)
    // while it awaits review, so the base repo has its main checkout plus the
    // three retained builder worktrees — removed later at Session retirement.
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1 + results.length);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('two worktree Runs on the same base repo both proceed — distinct {path,branch} keys admit both (issue #119)', async () => {
    const repo = makeRepo();
    // Same base repo, both worktree mode: each Run gets its own worktree path
    // (`run-<runId>`) and branch (`harmonic/task-<id>-run-<attempt>`), so the
    // Work Context lease key is distinct per Run — worktree mode is genuinely
    // concurrent-safe here, unlike direct mode's single shared checkout
    // (ADR-0022's deliberate asymmetry).
    const [a, b] = await Promise.all([
      runWorktreeTask(repo, { 'a.txt': 'A\n' }),
      runWorktreeTask(repo, { 'b.txt': 'B\n' }),
    ]);

    const runA = (await server.api('GET', `/api/runs/${a.runId}`)).body;
    const runB = (await server.api('GET', `/api/runs/${b.runId}`)).body;
    // A native Run parks non-terminal in `phase:'review'` awaiting the human
    // gate — it is not `completed` until Accept lands it (issue #114).
    expect(runA.state).toBe('running');
    expect(runB.state).toBe('running');
    expect(runA.phase).toBe('review');
    expect(runB.phase).toBe('review');
    expect(runA.branch).not.toBe(runB.branch);

    const taskA = (await server.api('GET', `/api/tasks/${a.taskId}`)).body;
    const taskB = (await server.api('GET', `/api/tasks/${b.taskId}`)).body;
    expect(taskA.state).toBe('awaiting-review');
    expect(taskB.state).toBe('awaiting-review');
  });

  it('escalates instead of forking off "HEAD" when the base repo is detached and no base branch is set (issue #198)', async () => {
    const repo = makeRepo(); // on branch main
    // Simulate the state a prior landing/merge-train leaves behind: the base
    // repo detached at a commit (== main here, no divergence — the landing just
    // didn't return HEAD to the branch). `--abbrev-ref HEAD` now reports the
    // literal "HEAD"; the Run must NOT record that as its base branch.
    git(repo, 'checkout', '--detach', 'HEAD');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    const worktreesBefore = git(repo, 'worktree', 'list').split('\n').length;

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'feature.txt': 'nope\n' } }),
      workingDir: repo,
      isolationMode: 'worktree',
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);

    // The base can't be resolved to a real branch → the Run fails loudly and is
    // handed to a human, rather than recording `base_branch: "HEAD"` and forking
    // off the detached commit (silently defeating worktree isolation).
    await waitFor(async () => (await server.api('GET', `/api/runs/${started.body.id}`)).body.state === 'failed');
    const run = (await server.api('GET', `/api/runs/${started.body.id}`)).body;
    expect(run.reason ?? '').toMatch(/^escalated to human: /);
    expect((run.reason ?? '').toLowerCase()).toContain('detached');
    // The poison value never reaches the row; no run branch was created.
    expect(run.baseBranch).not.toBe('HEAD');
    expect(run.baseBranch ?? null).toBeNull();
    expect(run.branch ?? null).toBeNull();

    // The base repo is untouched: still detached, clean, no worktree added and
    // no `harmonic/task-*` branch forged off the detached HEAD.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(worktreesBefore);
    expect(git(repo, 'branch', '--list', `harmonic/task-${created.body.id}-run-*`)).toBe('');

    // The Task is handed back to a human (escalated), not silently failed.
    const task = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
    expect(task.escalated).toBe(true);
  });

  it('escalates the run when the working directory is not a git repo (permanent git-prep failure, issue #199)', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'harmonic-plain-'));
    const created = await server.api('POST', '/api/tasks', {
      prompt: 'anything',
      workingDir: notARepo,
      isolationMode: 'worktree',
    });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);
    // A non-git base can never succeed on retry (issue #199): the workspace-prep
    // git command fatally fails, so the Task is escalated to a human (→ hitl)
    // rather than settled a bare `failed` the scheduler would keep re-touching.
    const task = await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
      return t.escalated ? t : undefined;
    });
    expect(task.drive).toBe('hitl');
    const runs = (await server.api('GET', `/api/tasks/${created.body.id}/runs`)).body.runs;
    // The Run itself still fails with a legible reason; only one is ever created.
    expect(runs.length).toBe(1);
    expect(runs[0].state).toBe('failed');
    expect(runs[0].reason).toBeTruthy();
  });

  it('re-queues (does NOT escalate) a worktree Run whose Epic integration base is transiently missing (issue #159)', async () => {
    const repo = makeRepo();
    const worktreesBefore = git(repo, 'worktree', 'list').split('\n').length;
    // A member whose durable base points at an Epic integration branch that isn't
    // present (retired / lost to a restart before the reconcile re-cut it).
    const created = await server.api('POST', '/api/tasks', {
      prompt: 'anything',
      workingDir: repo,
      isolationMode: 'worktree',
      baseBranch: 'epic/999',
    });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);

    // The Run settles failed — but the Task returns to `ready` (not escalated to a
    // human): the branch is transiently absent, so it re-runs once the reconcile
    // re-cuts it, rather than a false PERMANENT git-prep escalation (issue #199).
    const task = await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
      return t.state === 'ready' ? t : undefined;
    });
    expect(task.escalated).toBe(false);
    expect(task.drive).not.toBe('hitl');

    const runs = (await server.api('GET', `/api/tasks/${created.body.id}/runs`)).body.runs;
    expect(runs.length).toBe(1);
    expect(runs[0].state).toBe('failed');
    expect(runs[0].reason).toContain('epic/999');

    // The base repo is untouched: no worktree added, no run branch forged.
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(worktreesBefore);
    expect(git(repo, 'branch', '--list', `harmonic/task-${created.body.id}-run-*`)).toBe('');
  });
});
