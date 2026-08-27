import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { tasks, workspaces } from '../src/db/schema.js';

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
      async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done',
    );
    return { taskId: created.body.id, runId: started.body.id };
  }

  it('executes on its own branch in a temp worktree, lands, and the worktree is removed at Session retirement (issue #148)', async () => {
    const repo = makeRepo();
    const { taskId, runId } = await runWorktreeTask(repo, { 'feature.txt': 'made by agent\n' });

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.branch).toBe(`harmonic/task-${taskId}-run-1`);
    expect(run.baseBranch).toBe('main');

    // The branch exists and carries the file; the checkout was never touched.
    expect(git(repo, 'show', `${run.branch}:feature.txt`)).toBe('made by agent');
    // The verified head landed on main by fast-forward (ADR-0041: no human gate).
    expect(git(repo, 'show', 'main:feature.txt')).toBe('made by agent');
    expect(git(repo, 'rev-parse', 'main')).toBe(run.candidateOid);

    // Issue #148: landing retires the Session, which is the sole owner of
    // builder-worktree removal; the async retirement drain reclaims it.
    await waitFor(async () => git(repo, 'worktree', 'list').split('\n').length === 1);
    // Only the main checkout remains — the retained worktree was removed at retirement.
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('a worktree run whose base branch advances externally mid-turn still verifies and merges normally (ADR-0046)', async () => {
    const repo = makeRepo();
    const mainBefore = git(repo, 'rev-parse', 'main');

    // The stub does its legit work in its own worktree, and — simulating the
    // base moving underneath the run (a push, a pull, another Run's merge; here
    // an empty commit onto the checked-out main via the trailing absolute
    // `-C repo`) — advances main during the turn. A worktree Run is isolated in
    // its own worktree, so a moving base is legitimate and must never fail it:
    // the merge path reconciles the moved target and the run lands normally.
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({
        writeFiles: { 'feature.txt': 'legit worktree work\n' },
        gitExec: [['-C', repo, 'commit', '--allow-empty', '-m', 'base advanced externally']],
      }),
      workingDir: repo,
      isolationMode: 'worktree',
    });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);

    const task = await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
      return t.state === 'done' || t.state === 'escalated' ? t : undefined;
    });

    // No canonical-mutation escalation — the run verified against its own
    // candidate and merged onto the moved base.
    expect(task.state).toBe('done');
    // main carries BOTH the external advance and the run's merged work.
    expect(git(repo, 'show', 'main:feature.txt')).toBe('legit worktree work');
    expect(git(repo, 'log', 'main', '--format=%s').split('\n')).toContain('base advanced externally');
    expect(git(repo, 'rev-parse', 'main')).not.toBe(mainBefore);
  });

  it('landing merges the run branch into the base branch and refreshes its checkout', async () => {
    const repo = makeRepo();
    const { taskId } = await runWorktreeTask(repo, { 'feature.txt': 'merged\n' });

    expect((await server.api('GET', `/api/tasks/${taskId}`)).body.state).toBe('done');
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

    // The landing put the run onto feature-base — the recorded base — not main.
    expect((await server.api('GET', `/api/tasks/${taskId}`)).body.state).toBe('done');
    expect(git(repo, 'show', 'feature-base:feature.txt')).toBe('made on feature-base');
    // main's checkout was never touched by either the fork or the landing.
    expect(existsSync(join(repo, 'feature.txt'))).toBe(false);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('two Runs forking the same main and touching the same file: the first lands, the conflicting second never merges a tree nobody verified', async () => {
    const repo = makeRepo();
    // Both fork the same main before either lands.
    const startBoth = async () => {
      const created = await Promise.all(
        [{ 'conflict.txt': 'version A\n' }, { 'conflict.txt': 'version B\n' }].map((files) =>
          server.api('POST', '/api/tasks', { prompt: JSON.stringify({ writeFiles: files }), workingDir: repo, isolationMode: 'worktree' }),
        ),
      );
      const ids = created.map((c) => c.body.id as number);
      for (const id of ids) expect((await server.api('POST', `/api/tasks/${id}/run`)).status).toBe(201);
      return ids;
    };
    const [a, b] = await startBoth();
    const settled = async (id: number) =>
      waitFor(async () => {
        const t = (await server.api('GET', `/api/tasks/${id}`)).body;
        return t.state === 'done' || t.state === 'escalated' ? t : undefined;
      });
    const [ta, tb] = [await settled(a!), await settled(b!)];

    // Exactly one landed (the other's stale landing re-entered Rebase, where
    // the conflict is agent work the stub never resolves — a failed Attempt
    // per try, escalated at the cap). Nothing half-merged, no merge commit.
    const states = [ta.state, tb.state].sort();
    expect(states).toEqual(['done', 'escalated']);
    const escalated = ta.state === 'escalated' ? ta : tb;
    expect(escalated.escalationReason).toMatch(/rebase|advanced after verification|branch head moved/);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'log', '--merges', 'main')).toBe('');
    expect(['version A', 'version B']).toContain(git(repo, 'show', 'main:conflict.txt'));
    expect(git(repo, 'rev-list', '--count', 'main')).toBe('2');
  });

  it('Close on an escalated worktree ticket removes its branch and leaves the base branch unchanged', async () => {
    const repo = makeRepo();
    const mainBefore = git(repo, 'rev-parse', 'main');
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'feature.txt': 'unwanted\n' }, exit: 'crash-before-response' }),
      workingDir: repo,
      isolationMode: 'worktree',
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated');
    const run = (await server.api('GET', `/api/runs/${started.body.id}`)).body;
    expect(git(repo, 'branch', '--list', run.branch)).toContain(run.branch);

    const closed = await server.api('POST', `/api/tasks/${created.body.id}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body.state).toBe('cancelled');

    await waitFor(async () => (git(repo, 'branch', '--list', run.branch) === '' ? true : undefined));
    expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
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

  it('serves a completed Run\'s file diff after its temporary branch is removed (issue #323)', async () => {
    const repo = makeRepo();
    const { runId } = await runWorktreeTask(repo, { 'feature.txt': 'diff me\n' });
    const run = (await server.api('GET', `/api/runs/${runId}`)).body;

    git(repo, 'branch', '-D', run.branch);

    const diff = await server.api('GET', `/api/runs/${runId}/diff/files`);
    expect(diff.status).toBe(200);
    expect(diff.body.files).toHaveLength(1);
    expect(diff.body.files[0]).toMatchObject({ path: 'feature.txt', status: 'A' });
    expect(diff.body.files[0].lines).toContainEqual(expect.objectContaining({ kind: 'add', text: 'diff me' }));
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
    // Every Run landed (fast-forward, serialised by the freshness gate: a Run
    // whose base moved re-based and re-verified before landing), and each
    // builder worktree is reclaimed at Session retirement (issue #148).
    for (const file of ['a.txt', 'b.txt', 'c.txt']) expect(git(repo, 'ls-tree', '--name-only', 'main', file)).toBe(file);
    await waitFor(async () => (git(repo, 'worktree', 'list').split('\n').length === 1 ? true : undefined));
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
    // Both landed: distinct keys admitted both, and the freshness gate
    // serialised their fast-forwards onto main.
    expect(runA.state).toBe('completed');
    expect(runB.state).toBe('completed');
    expect(runA.phase).toBe('terminal');
    expect(runB.phase).toBe('terminal');
    expect(runA.branch).not.toBe(runB.branch);

    const taskA = (await server.api('GET', `/api/tasks/${a.taskId}`)).body;
    const taskB = (await server.api('GET', `/api/tasks/${b.taskId}`)).body;
    expect(taskA.state).toBe('done');
    expect(taskB.state).toBe('done');
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
    expect(task.state).toBe('escalated');
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
    // git command fatally fails, so the Task is escalated to a human rather than
    // re-queued for the scheduler to keep re-touching.
    await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
      return t.state === 'escalated' ? t : undefined;
    });
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
    expect(task.state).not.toBe('escalated');

    const runs = (await server.api('GET', `/api/tasks/${created.body.id}/runs`)).body.runs;
    expect(runs.length).toBe(1);
    expect(runs[0].state).toBe('failed');
    expect(runs[0].reason).toContain('epic/999');

    // The base repo is untouched: no worktree added, no run branch forged.
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(worktreesBefore);
    expect(git(repo, 'branch', '--list', `harmonic/task-${created.body.id}-run-*`)).toBe('');
  });

  it('an Epic member (mapRef) never forks off the current branch: an unresolved epic base re-queues instead (issue #334)', async () => {
    const repo = makeRepo(); // on branch main
    git(repo, 'branch', 'epic/424'); // the Epic's integration branch exists
    const worktreesBefore = git(repo, 'worktree', 'list').split('\n').length;

    // A recognised Epic member (durable `mapRef`) whose base has NOT been
    // retargeted onto its integration branch yet — the #332 shape. Created as a
    // worktree Task so `resolveBaseBranch` runs, then stamped with the membership
    // the mirror would set.
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'f.txt': 'nope\n' } }),
      workingDir: repo,
      isolationMode: 'worktree',
    });
    await server.app.ctx.asyncDb.write((d) =>
      d.update(tasks).set({ mapRef: 424 }).where(eq(tasks.id, created.body.id)).run(),
    );
    await server.api('POST', `/api/tasks/${created.body.id}/run`);

    // It must NOT resolve to main and fork off it: base is unresolved under a live
    // integration branch, so the Run re-queues (ready, not escalated) until the
    // reconcile points it at epic/424 — never a run recorded with base main.
    const task = await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
      return t.state === 'ready' ? t : undefined;
    });
    expect(task.state).toBe('ready');
    const runs = (await server.api('GET', `/api/tasks/${created.body.id}/runs`)).body.runs;
    expect(runs.length).toBe(1);
    expect(runs[0].state).toBe('failed');
    expect(runs[0].reason).toContain('epic/424');
    expect(runs[0].baseBranch ?? null).toBeNull(); // never resolved to main
    // Base repo untouched: no worktree, no run branch forged off main.
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(worktreesBefore);
    expect(git(repo, 'branch', '--list', `harmonic/task-${created.body.id}-run-*`)).toBe('');
  });
});

describe('worktree isolation — afk no-candidate fail-closed (ADR-0046)', () => {
  let server: TestServer;
  let ref = 4630;

  beforeAll(async () => {
    // One attempt so the first terminal settle stands; continueAttempts:0 so an
    // unfinished afk turn isn't re-prompted before it settles unresolved.
    server = await startServer({ ...stubHarness(), maxAttempts: 1, drive: { continueAttempts: 0 } });
  });
  afterAll(async () => {
    await server.close();
  });

  it('an afk worktree run that produced no candidate of its own fails closed (Escalates) rather than landing', async () => {
    const repo = makeRepo();
    const mainBefore = git(repo, 'rev-parse', 'main');

    // Point the sole workspace at this repo and script a mirrored (afk) drive
    // turn whose agent writes nothing — the run's own worktree gains no commit,
    // the genuine "work went to the wrong place" case. With the canonical guard
    // deleted, this must still fail closed via the existing no-candidate path.
    await server.app.ctx.asyncDb.write((d) => d.update(workspaces).set({ workingDir: repo }).run());
    await server.app.ctx.configStore.update({ drive: { prompt: JSON.stringify({ writeFiles: {}, stopReason: 'end_turn' }) } });

    const task = await server.app.ctx.tasks.upsertMirrored({
      trackerRef: ref++,
      prompt: 'go',
      workflow: 'implement',
      wayfinderType: null,
      mapRef: null,
      closed: false,
    });
    // Force worktree isolation on the mirrored Task — the run path the guard protected.
    await server.app.ctx.asyncDb.write((d) => d.update(tasks).set({ isolationMode: 'worktree' }).where(eq(tasks.id, task.id)).run());
    await server.app.ctx.tasks.setState(task.id, 'working');
    await server.app.ctx.runner.launchClaimed(task.id);

    const settled = await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${task.id}`)).body;
      return t.state === 'escalated' ? t : undefined;
    });
    // Fails closed with a surfaced reason; the base branch was never touched.
    expect(settled.state).toBe('escalated');
    expect(settled.escalationReason).toBeTruthy();
    expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
  });
});
