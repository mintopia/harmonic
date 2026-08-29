import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { Runner } from '../src/execution/runner.js';
import { DomainError } from '../src/domain/errors.js';
import type { MergeTrainMember } from '../src/execution/merge-train-coordinator.js';
import { startServer, stubHarness, waitFor, allWorkspaces, makeSettingsStore, seedLocalMarkdownTicket, type TestServer } from './helpers.js';

/**
 * Issue #163 / #381 — the single-writer merge train wired into the Epic
 * member-finish merging path. Since #381 (ADR-0001, the one merge policy)
 * deleted the freshness gate's rebase re-entry machinery, a `stale` train
 * result can no longer be resolved by rebasing and resubmitting: it escalates
 * plainly instead. This is DEGRADED behaviour, tracked by #382 (which is
 * expected to delete this coordinator wholesale in favour of the base merge
 * policy) — not the intended long-term shape.
 *
 *  - `Runner.settleEscalatedForMember`: the adapter the coordinator's
 *    `escalate` is bound to (unit, no server).
 *  - Two Epic members finishing near-simultaneously submit to ONE integration
 *    branch through the REAL wired Runner (a real server via `startServer`,
 *    so the process-global `MergeTrainCoordinator` built in `app.ts` is the
 *    one under test): the first fast-forwards the branch, and the second is
 *    stale (the branch moved out from under it) and escalates plainly — no
 *    rebase re-entry, no second verification.
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
    const settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
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
        memberBranch: `harmonic/task-${task.id}`,
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

describe('MergeTrainCoordinator wired into the Runner (issue #163; degraded pending #382)', () => {
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

  const timelineFor = async (taskId: number) =>
    (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts as Array<{
      number: number;
      state: string;
      feedback: string | null;
      tasks: Array<{ type: string; state: string; verdict: string | null }>;
    }>;

  it('two Epic members finishing near-simultaneously: the first fast-forwards the integration branch, the second is stale and escalates plainly (no rebase re-entry, degraded pending #382)', async () => {
    const repo = makeRepo();
    const epic = 'epic/1630';
    git(repo, 'branch', epic, 'main');
    await server.app.ctx.workspaces.update(wsId, { workingDir: repo });
    // `{ref}` is substituted per-Task (AutoDrive.prompt's buildDrivePrompt), so
    // one global template still gives each concurrently-merging member its own
    // distinct file — proving the two attempts are genuinely independent work.
    await server.app.ctx.configStore.update({
      drive: { prompt: JSON.stringify({ writeFiles: { 'member-{ref}.txt': 'member {ref}\n' }, mcpFinish: true }) },
    });
    const countBefore = Number(git(repo, 'rev-list', '--count', epic));

    // Submitted without awaiting the first — the merge train, not the test,
    // must impose the serial order between the two submits.
    const m1Promise = launchEpicMember(epic);
    const m2Promise = launchEpicMember(epic);
    const m1 = await m1Promise;
    const m2 = await m2Promise;

    const settled = (taskId: number) =>
      waitFor(async () => {
        const t = await server.app.ctx.tasks.get(taskId);
        return t.state === 'done' || t.state === 'escalated' ? t : undefined;
      });
    const [t1, t2] = await Promise.all([settled(m1.taskId), settled(m2.taskId)]);

    // Exactly one of the two merged and the other was stale (whichever's
    // submit reached the train's FIFO second, once the branch had already
    // moved) — under #381 a stale train result is no longer resolved by
    // rebasing and resubmitting; it escalates plainly.
    const states = [t1.state, t2.state].sort();
    expect(states).toEqual(['done', 'escalated']);
    const merged = t1.state === 'done' ? { task: t1, member: m1 } : { task: t2, member: m2 };
    const escalated = t1.state === 'escalated' ? { task: t1, member: m1 } : { task: t2, member: m2 };

    // The integration tip advanced exactly once — the winner's own verified
    // tip, never a merge commit (the train fast-forwards).
    const countAfter = Number(git(repo, 'rev-list', '--count', epic));
    expect(countAfter - countBefore).toBe(1);
    expect(git(repo, 'log', '--merges', epic)).toBe('');
    expect(git(repo, 'show', `${epic}:member-${merged.member.trackerRef}.txt`)).toBe(`member ${merged.member.trackerRef}`);
    const mergedRun = await server.app.ctx.runs.get(merged.member.runId);
    expect(mergedRun.candidateOid).toBe(git(repo, 'rev-parse', epic));

    // The escalated member's reason is plain language, names the stale cause,
    // and never leaks a raw git conflict/CAS dump.
    expect(escalated.task.escalationReason).toMatch(
      /integration branch advanced before .* could merge \(integration branch advanced after verification\)/,
    );
    expect(escalated.task.escalationReason).not.toMatch(/<<<<<<<|CONFLICT/);

    // No rebase re-entry: the escalated member's single Attempt has exactly
    // the Attempt-start Rebase Task and the implementation — then nothing
    // more (this workspace configures no verifier, so no verification row is
    // expected either; the point is there is no SECOND rebase/verification).
    const escalatedRun = await server.app.ctx.runs.get(escalated.member.runId);
    expect(escalatedRun.attempt).toBe(1);
    const timeline = await timelineFor(escalated.member.taskId);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.tasks.filter((t) => t.type === 'rebase')).toHaveLength(1);
    expect(timeline[0]!.tasks.filter((t) => t.type === 'implementation')).toHaveLength(1);
  });

  // A rebase conflict discovered at merging time used to feed a corrective
  // turn as feedback and resubmit (AC3, pre-#381). That re-entry no longer
  // exists on the runner side — the case above ("stale escalates plainly")
  // is now the only merging-time outcome for a moved integration branch.
  // #382 is expected to delete this coordinator (and its freshness-gate-era
  // stale/rebase distinction) wholesale in favour of the base merge policy.
});
