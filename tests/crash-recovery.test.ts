import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { RunFactStore } from '../src/domain/run-facts.js';
import { LandingJournalStore } from '../src/domain/landing-journal.js';
import { RunSettleCoordinator } from '../src/domain/run-settle.js';
import { LandingCoordinator } from '../src/domain/landing-coordinator.js';
import { TurnQueueStore } from '../src/domain/turn-queue-store.js';
import { CrashRecoveryCoordinator } from '../src/domain/crash-recovery.js';
import { Git } from '../src/execution/git.js';
import { workContextKey } from '../src/domain/work-context-key.js';
import { DomainError } from '../src/domain/errors.js';
import type { TaskRow, RunRow } from '../src/db/schema.js';
import { allWorkspaces } from './helpers.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed README — mirrors
 * task-list-branch.test.ts's `makeRepo`. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-crash-recovery-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/**
 * Direct unit coverage for `CrashRecoveryCoordinator`'s `opts.isMerged` /
 * `opts.now` injection seams (issue #117 review) — exercised hermetically
 * over a real (temp) sqlite DB, following the same store-construction idiom
 * as landing-coordinator.test.ts, rather than through the full HTTP server
 * boot path (boot-recovery.test.ts already covers that end-to-end).
 */
describe('CrashRecoveryCoordinator (issue #117, isMerged/now seams)', () => {
  let dir: string;
  let repo: string;
  let db: Db;
  // RunStore migrated to the async libsql Db (ADR-0029 #203); the other stores
  // here are still on the sync Db, so this fixture runs both connections on
  // the one file (same pattern as tests/run-facts.test.ts).
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runStore: RunStore;
  let leases: WorkContextLeaseStore;
  let runFacts: RunFactStore;
  let journal: LandingJournalStore;
  let settle: RunSettleCoordinator;
  let landing: LandingCoordinator;
  let turnQueue: TurnQueueStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-crash-recovery-'));
    repo = makeRepo();
    db = openDb(dir);
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    runStore = new RunStore(asyncDb);
    leases = new WorkContextLeaseStore(db);
    runFacts = new RunFactStore(db);
    journal = new LandingJournalStore(db);
    settle = new RunSettleCoordinator(runStore, tasks, leases, runFacts, undefined, journal);
    landing = new LandingCoordinator(runStore, runFacts, journal, settle);
    turnQueue = new TurnQueueStore(db);
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** A Task+Run pair parked mid-landing exactly as a crashed `land()` would
   * leave them: Task `awaiting-review`, Run `running`/`phase:'landing'`, with
   * a land fact frozen (PONC) and an intent recorded for the `target-ref`
   * effect but NO result — died between intent and result. */
  async function seedMidLanding(branch: string, baseBranch: string): Promise<{ task: TaskRow; run: RunRow; idempotencyKey: string }> {
    const created = tasks.create({ prompt: 'land me', state: 'ready', workingDir: repo });
    tasks.setState(created.id, 'running');
    let run = await runStore.create(created.id);
    run = await runStore.update(run.id, { phase: 'landing', branch, baseBranch });
    tasks.setState(created.id, 'awaiting-review');
    const task = tasks.get(created.id);

    const idempotencyKey = `${baseBranch}<-${branch}`;
    const landFact = runFacts.append(run.id, 'agent-finish/unresolved', { runState: 'completed', taskAction: 'completed', reason: null });
    journal.writePonc(run.id, landFact.seq);
    journal.recordIntent(run.id, { effect: 'target-ref', idempotencyKey, expected: { baseBranch, branch } });
    // No result row: the process died before `apply()` resolved.

    return { task, run, idempotencyKey };
  }

  it('adopts an already-merged effect when the world says merged: records a result without re-applying, and completes the Run (ADOPT path)', async () => {
    const branch = 'run-branch';
    const baseBranch = 'main';
    const { run, idempotencyKey } = await seedMidLanding(branch, baseBranch);

    const mergeSpy = vi.spyOn(Git, 'merge');
    const isMerged = vi.fn(async () => true);
    const coord = new CrashRecoveryCoordinator(runStore, tasks, leases, settle, landing, journal, turnQueue, {
      now: () => 1_000_000,
      isMerged,
    });

    await coord.reconcile();

    // isMerged was actually consulted (the injected seam, not the real Git.isAncestor).
    expect(isMerged).toHaveBeenCalledWith(repo, baseBranch, branch);
    // Adopted, never re-applied.
    expect(mergeSpy).not.toHaveBeenCalled();

    const rows = journal.views(run.id);
    const result = rows.find((r) => r.kind === 'result' && r.idempotencyKey === idempotencyKey);
    expect(result).toMatchObject({ payload: { ok: true, observed: { adopted: true } } });

    const landedRun = await runStore.get(run.id);
    expect(landedRun.state).toBe('completed');
    expect(landedRun.phase).toBe('terminal');
    expect(tasks.get(run.taskId).state).toBe('completed');
  });

  it('leaves the Run parked when the world says NOT merged and the real re-apply fails (no such branch to merge)', async () => {
    const branch = 'nonexistent-branch';
    const baseBranch = 'main';
    const { run } = await seedMidLanding(branch, baseBranch);

    const coord = new CrashRecoveryCoordinator(runStore, tasks, leases, settle, landing, journal, turnQueue, {
      now: () => 1_000_000,
      isMerged: async () => false,
    });

    await coord.reconcile();

    // The re-apply genuinely failed (no such branch in the real repo) —
    // `foldJournal` shows not-all-ok, so the finishing settle never ran: the
    // Run stays parked mid-landing for a human to retry, same as a real
    // merge-conflict leaves it.
    const parkedRun = await runStore.get(run.id);
    expect(parkedRun.state).toBe('running');
    expect(parkedRun.phase).toBe('landing');
    expect(tasks.get(run.taskId).state).toBe('awaiting-review');
  });
});

/**
 * Boot reconciliation of Work Context leases left behind by a dead owner
 * (issue #123, reliability-design §0.5): a fresh process is executing
 * nothing, so every lease still in `work_context_leases` at boot belongs to a
 * Run whose process is gone. Pass D reconciles each: a provably-clean
 * `direct` context is released (freeing the key); anything not provably safe
 * (dirty tree, detached HEAD, worktree mode, unreadable) flips to `suspect` —
 * still owned, still blocking acquires, awaiting operator disposition.
 */
describe('CrashRecoveryCoordinator lease reconciliation (issue #123)', () => {
  let dir: string;
  let repo: string;
  let db: Db;
  // RunStore migrated to the async libsql Db (ADR-0029 #203); the other stores
  // here are still on the sync Db, so this fixture runs both connections on
  // the one file (same pattern as tests/run-facts.test.ts).
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runStore: RunStore;
  let leases: WorkContextLeaseStore;
  let runFacts: RunFactStore;
  let journal: LandingJournalStore;
  let settle: RunSettleCoordinator;
  let landing: LandingCoordinator;
  let turnQueue: TurnQueueStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-crash-recovery-leases-'));
    repo = makeRepo();
    db = openDb(dir);
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    runStore = new RunStore(asyncDb);
    leases = new WorkContextLeaseStore(db);
    runFacts = new RunFactStore(db);
    journal = new LandingJournalStore(db);
    settle = new RunSettleCoordinator(runStore, tasks, leases, runFacts, undefined, journal);
    landing = new LandingCoordinator(runStore, runFacts, journal, settle);
    turnQueue = new TurnQueueStore(db);
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Seed a held lease owned by a Run whose process is (fictitiously) dead:
   * a Task + a freshly-created Run (phase `executing` — a live orphan, exactly
   * what a mid-flight crash leaves), with a lease acquired against it. */
  async function seedDeadOwnerLease(
    workingDir: string,
    isolationMode: 'direct' | 'worktree' = 'direct',
  ): Promise<{ task: TaskRow; run: RunRow; key: string }> {
    const created = tasks.create({ prompt: 'own a work context', state: 'ready', workingDir, isolationMode });
    const run = await runStore.create(created.id);
    const task = tasks.get(created.id);
    const key =
      isolationMode === 'direct'
        ? workContextKey({ isolationMode: 'direct', workingDir })
        : workContextKey({
            isolationMode: 'worktree',
            workingDir,
            worktreePath: join(workingDir, 'wt'),
            branch: 'harmonic/task-x-run-1',
          });
    leases.acquire(key, run.id, 'running');
    return { task, run, key };
  }

  it('direct + provably clean → released, and the freed key is admissible again (AC#3)', async () => {
    const { key } = await seedDeadOwnerLease(repo, 'direct');

    const coord = new CrashRecoveryCoordinator(runStore, tasks, leases, settle, landing, journal, turnQueue, {
      now: () => 1_000_000,
      isDirectContextClean: async () => true,
    });
    await coord.reconcile();

    expect(leases.getByKey(key)).toBeUndefined();

    // The freed key is admissible again.
    const otherTask = tasks.create({ prompt: 'contend for the freed key', state: 'ready' });
    const otherRun = await runStore.create(otherTask.id);
    expect(() => leases.acquire(key, otherRun.id, 'running')).not.toThrow();
  });

  it('direct + not provably clean → suspect, still held, and still blocks acquires', async () => {
    const { key } = await seedDeadOwnerLease(repo, 'direct');

    const coord = new CrashRecoveryCoordinator(runStore, tasks, leases, settle, landing, journal, turnQueue, {
      now: () => 1_000_000,
      isDirectContextClean: async () => false,
    });
    await coord.reconcile();

    const lease = leases.getByKey(key);
    expect(lease).toBeDefined();
    expect(lease?.state).toBe('suspect');

    const otherTask = tasks.create({ prompt: 'contend for a suspect key', state: 'ready' });
    const otherRun = await runStore.create(otherTask.id);
    let caught: unknown;
    try {
      leases.acquire(key, otherRun.id, 'running');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('conflict');
  });

  it('worktree mode → suspect even when the clean-probe would say clean (mode routing, not cleanliness)', async () => {
    const { key } = await seedDeadOwnerLease(repo, 'worktree');

    const coord = new CrashRecoveryCoordinator(runStore, tasks, leases, settle, landing, journal, turnQueue, {
      now: () => 1_000_000,
      isDirectContextClean: async () => true,
    });
    await coord.reconcile();

    const lease = leases.getByKey(key);
    expect(lease).toBeDefined();
    expect(lease?.state).toBe('suspect');
  });

  it('is idempotent across boots — a suspect lease is left untouched even if it now looks clean', async () => {
    const { key } = await seedDeadOwnerLease(repo, 'direct');

    const firstBoot = new CrashRecoveryCoordinator(runStore, tasks, leases, settle, landing, journal, turnQueue, {
      now: () => 1_000_000,
      isDirectContextClean: async () => false,
    });
    await firstBoot.reconcile();
    expect(leases.getByKey(key)?.state).toBe('suspect');

    const secondBoot = new CrashRecoveryCoordinator(runStore, tasks, leases, settle, landing, journal, turnQueue, {
      now: () => 2_000_000,
      isDirectContextClean: async () => true,
    });
    await secondBoot.reconcile();

    const lease = leases.getByKey(key);
    expect(lease).toBeDefined();
    expect(lease?.state).toBe('suspect'); // never auto-released on a later boot
  });

  it('default clean-probe (no injection): a clean committed direct repo is released; a dirtied one becomes suspect', async () => {
    const { key: cleanKey } = await seedDeadOwnerLease(repo, 'direct');

    const coord = new CrashRecoveryCoordinator(runStore, tasks, leases, settle, landing, journal, turnQueue, {
      now: () => 1_000_000,
      // no isDirectContextClean override — exercises the real Git.isDirty/symbolicBranch
    });
    await coord.reconcile();
    expect(leases.getByKey(cleanKey)).toBeUndefined();

    // Dirty the repo, then seed a second dead-owner lease on the same repo.
    writeFileSync(join(repo, 'x.txt'), 'x');
    const secondTask = tasks.create({ prompt: 'own a dirty work context', state: 'ready', workingDir: repo, isolationMode: 'direct' });
    const secondRun = await runStore.create(secondTask.id);
    const dirtyKey = workContextKey({ isolationMode: 'direct', workingDir: repo });
    leases.acquire(dirtyKey, secondRun.id, 'running');

    await coord.reconcile();
    expect(leases.getByKey(dirtyKey)?.state).toBe('suspect');
  });

  it('direct + clean tree but DETACHED HEAD → suspect (a mid-flight crash before #152 restored the live checkout is not safe to free)', async () => {
    // Clean working tree, but HEAD detached — exactly what a direct Run leaves
    // when it crashes after #152 detaches onto a private ref and before settle
    // restores the live branch. `git status` reads clean, yet the context is
    // not coherently on its landing branch, so it must NOT be released.
    git(repo, 'checkout', '--detach', 'HEAD');
    const { key } = await seedDeadOwnerLease(repo, 'direct');

    const coord = new CrashRecoveryCoordinator(runStore, tasks, leases, settle, landing, journal, turnQueue, {
      now: () => 1_000_000,
      // no override — exercises the real `directContextProvablyClean` detached-HEAD branch
    });
    await coord.reconcile();

    const lease = leases.getByKey(key);
    expect(lease).toBeDefined();
    expect(lease?.state).toBe('suspect');
  });

  it('direct + unreadable/non-git working dir → suspect (a probe error is not proof of clean)', async () => {
    const { key } = await seedDeadOwnerLease('/nonexistent/definitely/not/a/repo', 'direct');

    const coord = new CrashRecoveryCoordinator(runStore, tasks, leases, settle, landing, journal, turnQueue, {
      now: () => 1_000_000,
      // no override — exercises the real `directContextProvablyClean` catch branch
    });
    await coord.reconcile();

    const lease = leases.getByKey(key);
    expect(lease).toBeDefined();
    expect(lease?.state).toBe('suspect');
  });
});
