import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { Runner } from '../src/execution/runner.js';
import { DomainError } from '../src/domain/errors.js';
import type { MergeTrainMember } from '../src/execution/merge-train-coordinator.js';
import { turnQueue } from '../src/db/schema.js';
import { startServer, stubHarness, waitFor, allWorkspaces, seedLocalMarkdownTicket, type TestServer } from './helpers.js';

/**
 * Issue #163 / #313 — the single-writer merge train wired into the Epic
 * member-finish merging path, behind the ADR-0041 freshness gate:
 *
 *  - `Runner.settleEscalatedForMember`: the adapter the coordinator's
 *    `escalate` is bound to (unit, no server).
 *  - AC2: two Epic members finishing near-simultaneously merge serially onto ONE
 *    integration branch, each asserting its own verified SHA, through the REAL
 *    wired Runner (a real server via `startServer`, so the process-global
 *    `MergeTrainCoordinator` built in `app.ts` is the one under test). The
 *    second member's verdict is stale once the first merges, so it re-enters
 *    Rebase → Verification on the SAME Attempt before merging.
 *  - AC3: a rebase conflict on that re-entry is a failed Rebase Task, fed to
 *    the unified Attempt loop's corrective turn as feedback (one attempt
 *    consumed), and escalates at maxAttempts — never a merged conflict.
 */

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const tmpDirs: string[] = [];
const tmpPath = (prefix: string) => {
  const p = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(p);
  return p;
};

/**
 * A throwaway git repo on branch main with a committed README and a
 * local-markdown tracker declaration, so `AutoDrive.closeCompleted` (#139,
 * the merge-train merge path's ticket close) resolves a real no-op-close
 * adapter instead of escalating on a missing tracker.
 */
function makeRepo(): string {
  const dir = tmpPath('harmonic-mergetrain-wiring-');
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  mkdirSync(join(dir, 'docs', 'agents'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: local-markdown\n\nPath: tickets\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** Advance `branch` in `repo` by one commit writing `file`, off to the side. */
function advanceBranch(repo: string, branch: string, file: string, content: string): void {
  const scratch = tmpPath('harmonic-mergetrain-advance-');
  git(repo, 'worktree', 'add', scratch, branch);
  writeFileSync(join(scratch, file), content);
  git(scratch, 'add', '-A');
  git(scratch, 'commit', '-m', `${branch} advances independently`);
  git(repo, 'worktree', 'remove', '--force', scratch);
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('Runner merge-train adapters (issue #163)', () => {
  let dir: string;
  // RunStore migrated to the async libsql Db (ADR-0029 #203).
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runs: RunStore;
  let runner: Runner;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-mergetrain-adapters-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    runs = new RunStore(asyncDb);
    runner = new Runner(runs, tasks, new WorkContextLeaseStore(asyncDb), asyncDb, () => defaultConfig());
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed(): Promise<{ taskId: number; runId: number; member: MergeTrainMember }> {
    const task = await tasks.create({ prompt: 'do work' });
    await tasks.setState(task.id, 'working');
    const run = await runs.create(task.id);
    return {
      taskId: task.id,
      runId: run.id,
      member: {
        runId: run.id,
        taskId: task.id,
        repoDir: '/repo',
        integrationBranch: 'epic/1',
        memberBranch: `harmonic/task-${task.id}-run-1`,
        verifiedTip: 'a'.repeat(40),
      },
    };
  }

  it('settleEscalatedForMember settles the member\'s Run failed and hands the Task back to a human, escalated', async () => {
    const { taskId, runId, member } = await seed();

    await runner.settleEscalatedForMember(member, 'integration branch unexpectedly checked out');

    const settledRun = await runs.get(runId);
    expect(settledRun.state).toBe('failed');
    expect(settledRun.reason).toContain('escalated to human');
    expect(settledRun.reason).toContain('integration branch unexpectedly checked out');

    const settledTask = await tasks.get(taskId);
    expect(settledTask.state).toBe('escalated');
    expect(settledTask.escalationReason).toContain('integration branch unexpectedly checked out');
  });

  it('settleEscalatedForMember is the sole settle authority: driveOnce never re-settles what it already resolved', async () => {
    // Structural check that the adapter resolves task/run purely from the
    // member's ids (not from any Runner in-memory "active" bookkeeping) — the
    // same lookup driveOnce relies on to skip its own settle after an
    // escalate (issue #163's "no double settle" invariant).
    const { taskId, runId, member } = await seed();
    await runner.settleEscalatedForMember(member, 'integration branch missing');
    // Calling it again (as a defensive double-invocation would) is a no-op:
    // the run's already `failed`, task already `escalated` — nothing throws,
    // nothing flips back.
    await expect(runner.settleEscalatedForMember(member, 'integration branch missing')).resolves.toBeUndefined();
    expect((await runs.get(runId)).state).toBe('failed');
    expect((await tasks.get(taskId)).state).toBe('escalated');
  });

  it('start refuses to spawn an Epic member whose integration base is not ready — no run row, Task stays ready (funnel gate, issue #159)', async () => {
    // The shared start funnel consults the injected gate: a hand-started member
    // (REST/MCP) whose `epic/<ref>` base the poll hasn't confirmed live must be
    // rejected before a run is created — the same gate the Auto-Runner's pick
    // side uses, so neither path forks off a missing integration branch.
    const gated = new Runner(runs, tasks, new WorkContextLeaseStore(asyncDb), asyncDb, () => defaultConfig(), {
      epicBaseNotReady: (t) => t.baseBranch === 'epic/1',
    });
    const task = await tasks.create({ prompt: 'member work' });
    await tasks.setBaseBranch(task.id, 'epic/1');

    let err: unknown;
    try {
      await gated.start(task.id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('invalid_state'); // → HTTP 409
    expect((err as DomainError).message).toContain('epic/1');

    // The gate fires before `beginRun` creates the row or flips the Task, so no
    // orphan run and the Task stays on the frontier for the next poll.
    expect(await runs.listForTask(task.id)).toHaveLength(0);
    expect((await tasks.get(task.id)).state).toBe('ready');
  });
});

describe('MergeTrainCoordinator wired into the Runner (issue #163, ADR-0041 freshness gate)', () => {
  let server: TestServer;
  let wsId: number;
  let ref = 16_300;

  beforeAll(async () => {
    server = await startServer({
      ...stubHarness(),
      defaults: { isolationMode: 'worktree' },
      maxAttempts: 2,
      drive: { continueAttempts: 0, mergeFate: 'auto-merge' },
    });
    wsId = (await server.app.ctx.workspaces.list())[0]!.id;
  });
  afterAll(async () => {
    await server.close();
  });

  const mirroredAfk = (trackerRef: number): MirrorInput => ({
    trackerRef,
    prompt: `ticket ${trackerRef}\n\nbody`,
    workflow: 'implement',
    wayfinderType: null,
    mapRef: null,
    closed: false,
  });

  /** Launch a mirrored afk worktree Task whose base is an Epic integration branch. */
  async function launchEpicMember(epicBranch: string): Promise<{ taskId: number; runId: number; trackerRef: number }> {
    const trackerRef = ref++;
    const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(trackerRef));
    seedLocalMarkdownTicket(task.workingDir, trackerRef);
    await server.app.ctx.tasks.setBaseBranch(task.id, epicBranch);
    await server.app.ctx.tasks.setState(task.id, 'working');
    const run = await server.app.ctx.runner.launchClaimed(task.id);
    return { taskId: task.id, runId: run.id, trackerRef };
  }

  const turnsFor = (runId: number) =>
    server.app.ctx.asyncDb.read((d) => d.select().from(turnQueue).where(eq(turnQueue.runId, runId)).all());
  const timelineFor = async (taskId: number) =>
    (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts as Array<{
      number: number;
      state: string;
      feedback: string | null;
      tasks: Array<{ type: string; state: string; verdict: string | null }>;
    }>;

  it('AC2: two Epic members finishing near-simultaneously merge serially, each asserting its own verified SHA; the second re-enters rebase+verify on the same Attempt', async () => {
    const repo = makeRepo();
    const epic = 'epic/1630';
    git(repo, 'branch', epic, 'main');
    await server.app.ctx.workspaces.update(wsId, { workingDir: repo });
    // `{ref}` is substituted per-Task (AutoDrive.prompt's buildDrivePrompt), so
    // one global template still gives each concurrently-merging member its own
    // distinct file — proving the two merges are genuinely independent work.
    await server.app.ctx.configStore.update({
      drive: { prompt: JSON.stringify({ writeFiles: { 'member-{ref}.txt': 'member {ref}\n' }, mcpFinish: true }) },
    });
    const countBefore = Number(git(repo, 'rev-list', '--count', epic));

    // Submitted without awaiting the first — the merge train, not the test,
    // must impose the serial order.
    const m1Promise = launchEpicMember(epic);
    const m2Promise = launchEpicMember(epic);
    const m1 = await m1Promise;
    const m2 = await m2Promise;

    const completed = (taskId: number) =>
      waitFor(async () => {
        const t = await server.app.ctx.tasks.get(taskId);
        if (t.state === 'escalated') throw new Error(`member ${taskId} escalated instead of merging`);
        return t.state === 'done' ? t : undefined;
      });
    const t1 = await completed(m1.taskId);
    const t2 = await completed(m2.taskId);
    expect(t1.state).not.toBe('escalated');
    expect(t2.state).not.toBe('escalated');

    // The integration tip advanced exactly once per member (two new commits) —
    // never merge commits, so each merge was a fast-forward of a verified tip.
    const countAfter = Number(git(repo, 'rev-list', '--count', epic));
    expect(countAfter - countBefore).toBe(2);
    expect(git(repo, 'log', '--merges', epic)).toBe('');
    expect(git(repo, 'show', `${epic}:member-${m1.trackerRef}.txt`)).toBe(`member ${m1.trackerRef}`);
    expect(git(repo, 'show', `${epic}:member-${m2.trackerRef}.txt`)).toBe(`member ${m2.trackerRef}`);

    // The integration tip IS a member's verified SHA: the runs' pinned
    // candidates are the two commits now on the branch.
    const [r1, r2] = await Promise.all([server.app.ctx.runs.get(m1.runId), server.app.ctx.runs.get(m2.runId)]);
    const tip = git(repo, 'rev-parse', epic);
    expect([r1.candidateOid, r2.candidateOid]).toContain(tip);
    expect([r1.candidateOid, r2.candidateOid]).toContain(git(repo, 'rev-parse', `${epic}~1`));

    // Clean merges: no corrective turn, and both Runs stayed on Attempt 1. One of
    // the two was stale when its turn on the train came and re-entered
    // Rebase → Verification on that same Attempt: a second passed Rebase Task
    // row, no second implementation.
    expect(await turnsFor(m1.runId)).toHaveLength(0);
    expect(await turnsFor(m2.runId)).toHaveLength(0);
    expect(r1.attempt).toBe(1);
    expect(r2.attempt).toBe(1);
    const timelines = [await timelineFor(m1.taskId), await timelineFor(m2.taskId)];
    for (const timeline of timelines) {
      expect(timeline).toHaveLength(1);
      expect(timeline[0]!.tasks.filter((t) => t.type === 'implementation')).toHaveLength(1);
      expect(timeline[0]!.tasks.every((t) => t.state === 'passed')).toBe(true);
    }
    const rebaseCounts = timelines.map((timeline) => timeline[0]!.tasks.filter((t) => t.type === 'rebase').length).sort();
    expect(rebaseCounts).toEqual([1, 2]);
  });

  it('AC3: a rebase conflict at merging is a failed Rebase Task fed to a corrective turn as feedback, then escalates at maxAttempts — the conflict never merges', async () => {
    const repo = makeRepo();
    const epic = 'epic/1631';
    git(repo, 'branch', epic, 'main');
    await server.app.ctx.workspaces.update(wsId, { workingDir: repo });
    // conflictResolveTurns generous (5) so the global maxAttempts cap (2) is the
    // unambiguous binding constraint here — the N-bound itself is covered in
    // freshness-gate.test.ts (ADR-0046, #367).
    await server.app.ctx.workspaces.update(wsId, { conflictResolveTurns: 5 });
    // Both turns touch the SAME file the test independently advances on the
    // integration branch below, so the merging rebase conflicts and the
    // corrective turn (which does not resolve the conflict) conflicts again.
    await server.app.ctx.configStore.update({
      drive: { prompt: JSON.stringify({ writeFiles: { 'README.md': 'member turn\n' }, mcpFinish: true }) },
    });

    const { taskId, runId } = await launchEpicMember(epic);

    // Wait until the member's worktree has forked from the integration
    // branch's CURRENT tip (prepareWorkspace sets `run.branch` only after the
    // `git worktree add` that resolves the fork point has completed) — only
    // then does advancing the integration branch independently guarantee a
    // genuine divergence (a real rebase conflict), rather than racing the fork.
    await waitFor(async () => ((await server.app.ctx.runs.get(runId)).branch ? true : undefined));
    advanceBranch(repo, epic, 'README.md', 'integration advanced independently\n');

    const settledTask = await waitFor(async () => {
      const t = await server.app.ctx.tasks.get(taskId);
      return t.state === 'escalated' ? t : undefined;
    });
    expect(settledTask.escalationReason).toMatch(/attempt 2 of 2 failed: rebase onto 'epic\/1631' hit a content conflict/);

    const settledRun = await server.app.ctx.runs.get(runId);
    expect(settledRun.state).toBe('failed');
    expect(settledRun.reason).toMatch(/attempt 2 of 2 failed: rebase onto 'epic\/1631' hit a content conflict/);

    // Attempt 1: rebase (fresh fork, no-op) → implementation → the merging
    // rebase conflicts → that Rebase Task fails, and the Attempt fails with the
    // conflict as its feedback. Attempt 2 opens with its own Rebase Task, which
    // conflicts again (left in progress for the agent, who did not resolve it).
    const timeline = await timelineFor(taskId);
    expect(timeline.map((a) => a.number)).toEqual([1, 2]);
    const first = timeline[0]!;
    expect(first.state).toBe('failed');
    // The Attempt feedback is plain language (ADR-0046, #367): it names the
    // content conflict but never leaks the raw git conflict dump to the operator.
    expect(first.feedback).toMatch(/content conflict/);
    expect(first.feedback).not.toMatch(/CONFLICT \(content\)|<<<<<<<|git rebase/);
    expect(first.tasks.map((t) => `${t.type}:${t.state}`)).toEqual([
      'rebase:passed',
      'implementation:passed',
      'rebase:failed',
    ]);
    expect(timeline[1]!.tasks[0]).toMatchObject({ type: 'rebase', state: 'failed', verdict: 'fail' });

    // Exactly one corrective turn was dispatched through the Session queue,
    // settled `done` once it ran.
    const turns = await turnsFor(runId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ purpose: 'self-heal', status: 'done' });

    // The integration branch never took the conflicting member's work.
    expect(git(repo, 'log', '--merges', epic)).toBe('');
    expect(git(repo, 'show', `${epic}:README.md`)).toBe('integration advanced independently');
  });
});
