import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb, type Db } from '../src/db/index.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { Runner } from '../src/execution/runner.js';
import { DomainError } from '../src/domain/errors.js';
import type { MergeTrainMember } from '../src/execution/merge-train-coordinator.js';
import { turnQueue } from '../src/db/schema.js';
import { startServer, stubHarness, waitFor, allWorkspaces, type TestServer } from './helpers.js';

/**
 * Issue #163 — the single-writer merge train wired into the Epic member-finish
 * landing path. Three seams:
 *
 *  - `Runner.enqueueReMergeForMember` / `settleEscalatedForMember`: the plain
 *    adapters the coordinator's `dispatchHeal`/`escalate` are bound to (unit,
 *    no server, mirrors the "Runner auto-drive settle" harness style).
 *  - AC2: two Epic members finishing near-simultaneously land serially onto
 *    ONE integration branch via rebase→ff, through the REAL wired Runner (a
 *    real server via `startServer`, so the process-global `MergeTrainCoordinator`
 *    built in `app.ts` is the one under test, not a hand-rolled stand-in).
 *  - AC3: a rebase conflict on a member's land dispatches exactly ONE
 *    corrective turn in that member's Session, and a second conflict Escalates
 *    — again through the wired Runner, not the coordinator in isolation (#160
 *    already covers the coordinator's own serial-landing/heal-once unit tests).
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
 * the merge-train land path's ticket close) resolves a real no-op-close
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

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('Runner merge-train adapters (issue #163)', () => {
  let dir: string;
  let db: Db;
  // RunStore migrated to the async libsql Db (ADR-0029 #203); this fixture
  // runs both connections on the one file.
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runs: RunStore;
  let runner: Runner;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-mergetrain-adapters-'));
    db = openDb(dir);
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(db));
    runs = new RunStore(asyncDb);
    runner = new Runner(runs, tasks, new WorkContextLeaseStore(asyncDb), db, asyncDb, () => defaultConfig());
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed(): Promise<{ taskId: number; runId: number; member: MergeTrainMember }> {
    const task = await tasks.create({ prompt: 'do work' });
    await tasks.setState(task.id, 'running');
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
        memberWorktreeDir: '/wt/1',
      },
    };
  }

  it('enqueueReMergeForMember records exactly one re-merge turn on the member\'s Session queue and stashes its row id', async () => {
    const { runId, member } = await seed();

    await runner.enqueueReMergeForMember(member);

    // The observable contract: exactly one in-flight `re-merge` turn on the
    // member's Session queue. The stashed row id (a private field) is not peeked
    // at here — the AC3 e2e test exercises the full stash→settle round-trip
    // through the real `drive()` loop (it asserts the row ends up settled `done`).
    const rows = db.select().from(turnQueue).where(eq(turnQueue.runId, runId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 're-merge', status: 'in_flight', sessionId: `run-${runId}` });
  });

  it('settleEscalatedForMember settles the member\'s Run failed and hands the Task back to a human, escalated', async () => {
    const { taskId, runId, member } = await seed();

    await runner.settleEscalatedForMember(member, 'rebase still conflicts after corrective turn');

    const settledRun = await runs.get(runId);
    expect(settledRun.state).toBe('failed');
    expect(settledRun.reason).toContain('escalated to human');
    expect(settledRun.reason).toContain('rebase still conflicts after corrective turn');

    const settledTask = await tasks.get(taskId);
    expect(settledTask.state).toBe('ready');
    expect(settledTask.escalated).toBe(true);
    expect(settledTask.drive).toBe('hitl');
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
    expect((await tasks.get(taskId)).escalated).toBe(true);
  });

  it('start refuses to spawn an Epic member whose integration base is not ready — no run row, Task stays ready (funnel gate, issue #159)', async () => {
    // The shared start funnel consults the injected gate: a hand-started member
    // (REST/MCP) whose `epic/<ref>` base the poll hasn't confirmed live must be
    // rejected before a run is created — the same gate the Auto-Runner's pick
    // side uses, so neither path forks off a missing integration branch.
    const gated = new Runner(runs, tasks, new WorkContextLeaseStore(asyncDb), db, asyncDb, () => defaultConfig(), {
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

describe('MergeTrainCoordinator wired into the Runner (issue #163)', () => {
  let server: TestServer;
  let wsId: number;
  let ref = 16_300;

  beforeAll(async () => {
    server = await startServer({
      ...stubHarness(),
      defaults: { isolationMode: 'worktree' },
      drive: { autoRetry: 0, continueAttempts: 0, mergeFate: 'auto-merge' },
    });
    wsId = server.app.ctx.workspaces.list()[0]!.id;
  });
  afterAll(async () => {
    await server.close();
  });

  const mirroredAfk = (trackerRef: number): MirrorInput => ({
    trackerRef,
    prompt: `ticket ${trackerRef}\n\nbody`,
    workflow: 'implement',
    wayfinderType: null,
    drive: 'afk',
    mapRef: null,
    closed: false,
  });

  /** Launch a mirrored afk worktree Task whose base is an Epic integration branch. */
  async function launchEpicMember(epicBranch: string): Promise<{ taskId: number; runId: number; trackerRef: number }> {
    const trackerRef = ref++;
    const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(trackerRef));
    expect(task.drive).toBe('afk');
    await server.app.ctx.tasks.setBaseBranch(task.id, epicBranch);
    await server.app.ctx.tasks.setState(task.id, 'running');
    const run = await server.app.ctx.runner.launchClaimed(task.id);
    return { taskId: task.id, runId: run.id, trackerRef };
  }

  const turnsFor = (runId: number) => server.app.ctx.db.select().from(turnQueue).where(eq(turnQueue.runId, runId)).all();

  it('AC2: two Epic members finishing near-simultaneously land serially via rebase→ff, no PR/manual fallback', async () => {
    const repo = makeRepo();
    const epic = 'epic/1630';
    git(repo, 'branch', epic, 'main');
    server.app.ctx.workspaces.update(wsId, { workingDir: repo });
    // `{ref}` is substituted per-Task (AutoDrive.prompt's buildDrivePrompt), so
    // one global template still gives each concurrently-landing member its own
    // distinct file — proving the two lands are genuinely independent work.
    server.app.ctx.configStore.update({
      drive: { prompt: JSON.stringify({ writeFiles: { 'member-{ref}.txt': 'member {ref}\n' }, mcpFinish: true }) },
    });
    const countBefore = Number(git(repo, 'rev-list', '--count', epic));

    // Submitted without awaiting the first — the merge train, not the test,
    // must impose the serial order (mirrors merge-train-coordinator.test.ts's
    // own near-simultaneous case, but through the real Runner this time).
    const m1Promise = launchEpicMember(epic);
    const m2Promise = launchEpicMember(epic);
    const m1 = await m1Promise;
    const m2 = await m2Promise;

    const completed = (taskId: number) =>
      waitFor(async () => {
        const t = await server.app.ctx.tasks.get(taskId);
        if (t.escalated) throw new Error(`member ${taskId} escalated instead of landing`);
        return t.state === 'completed' ? t : undefined;
      });
    const t1 = await completed(m1.taskId);
    const t2 = await completed(m2.taskId);

    expect(t1.state).toBe('completed');
    expect(t2.state).toBe('completed');
    expect(t1.escalated).toBe(false);
    expect(t2.escalated).toBe(false);

    // The integration tip advanced exactly once per member (two new commits) —
    // never merge commits, so this was a pure rebase→ff land per member, not a
    // PR/manual fallback.
    const countAfter = Number(git(repo, 'rev-list', '--count', epic));
    expect(countAfter - countBefore).toBe(2);
    expect(git(repo, 'log', '--merges', epic)).toBe('');
    expect(git(repo, 'show', `${epic}:member-${m1.trackerRef}.txt`)).toBe(`member ${m1.trackerRef}`);
    expect(git(repo, 'show', `${epic}:member-${m2.trackerRef}.txt`)).toBe(`member ${m2.trackerRef}`);

    // Clean lands: neither member's Session ever needed a corrective turn.
    expect(turnsFor(m1.runId)).toHaveLength(0);
    expect(turnsFor(m2.runId)).toHaveLength(0);
  });

  it('AC3: a rebase conflict on a member\'s land dispatches exactly one corrective turn, and a second conflict Escalates', async () => {
    const repo = makeRepo();
    const epic = 'epic/1631';
    git(repo, 'branch', epic, 'main');
    server.app.ctx.workspaces.update(wsId, { workingDir: repo });
    // Both the first turn and the one corrective turn touch the SAME file the
    // test independently advances on the integration branch below, so BOTH the
    // first land attempt and the corrective turn's re-attempt conflict.
    server.app.ctx.configStore.update({
      drive: {
        prompt: JSON.stringify({
          turns: [
            { writeFiles: { 'README.md': 'member turn 0\n' }, mcpFinish: true },
            { writeFiles: { 'README.md': 'member turn 1\n' }, mcpFinish: true },
          ],
        }),
      },
    });

    const { taskId, runId } = await launchEpicMember(epic);

    // Wait until the member's worktree has forked from the integration
    // branch's CURRENT tip (prepareWorkspace sets `run.branch` only after the
    // `git worktree add` that resolves the fork point has completed) — only
    // then does advancing the integration branch independently guarantee a
    // genuine divergence (a real rebase conflict), rather than racing the fork.
    await waitFor(async () => ((await server.app.ctx.runs.get(runId)).branch ? true : undefined));
    const scratch = tmpPath('harmonic-mergetrain-conflict-');
    git(repo, 'worktree', 'add', scratch, epic);
    writeFileSync(join(scratch, 'README.md'), 'integration advanced independently\n');
    git(scratch, 'commit', '-am', 'integration advances independently');
    git(repo, 'worktree', 'remove', '--force', scratch);

    // First conflict → the coordinator's dispatchHeal → enqueueReMergeForMember
    // records exactly ONE `re-merge` turn on this member's own Session queue.
    await waitFor(async () => (turnsFor(runId).length > 0 ? true : undefined));
    const afterFirstConflict = turnsFor(runId);
    expect(afterFirstConflict).toHaveLength(1);
    expect(afterFirstConflict[0]).toMatchObject({ purpose: 're-merge', sessionId: `run-${runId}` });

    // The corrective turn runs automatically (the `drive()` loop dispatches it
    // without further test action) and its own land ALSO conflicts → the
    // coordinator's `escalate` (→ settleEscalatedForMember) is the sole settle
    // authority — no second heal, no second mutating turn.
    const settledTask = await waitFor(async () => {
      const t = await server.app.ctx.tasks.get(taskId);
      return t.escalated ? t : undefined;
    });
    expect(settledTask.escalated).toBe(true);
    expect(settledTask.state).toBe('ready');
    expect(settledTask.drive).toBe('hitl');

    const settledRun = await server.app.ctx.runs.get(runId);
    expect(settledRun.state).toBe('failed');
    expect(settledRun.reason).toMatch(/rebase still conflicts after corrective turn/);

    // Still exactly ONE corrective turn ever recorded — settled `done` by the
    // `drive()` loop once the corrective turn ran its course, regardless of
    // its (escalating) verdict.
    const finalTurns = turnsFor(runId);
    expect(finalTurns.filter((t) => t.purpose === 're-merge')).toHaveLength(1);
    expect(finalTurns[0]!.status).toBe('done');

    // The integration branch never advanced — the conflicting member's work
    // never landed.
    expect(git(repo, 'log', '--merges', epic)).toBe('');
  });
});
