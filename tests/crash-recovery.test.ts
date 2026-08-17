import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
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
  let tasks: TaskService;
  let runStore: RunStore;
  let leases: WorkContextLeaseStore;
  let runFacts: RunFactStore;
  let journal: LandingJournalStore;
  let settle: RunSettleCoordinator;
  let landing: LandingCoordinator;
  let turnQueue: TurnQueueStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-crash-recovery-'));
    repo = makeRepo();
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    runStore = new RunStore(db);
    leases = new WorkContextLeaseStore(db);
    runFacts = new RunFactStore(db);
    journal = new LandingJournalStore(db);
    settle = new RunSettleCoordinator(runStore, tasks, leases, runFacts, undefined, journal);
    landing = new LandingCoordinator(runStore, runFacts, journal, settle);
    turnQueue = new TurnQueueStore(db);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** A Task+Run pair parked mid-landing exactly as a crashed `land()` would
   * leave them: Task `awaiting-review`, Run `running`/`phase:'landing'`, with
   * a land fact frozen (PONC) and an intent recorded for the `target-ref`
   * effect but NO result — died between intent and result. */
  function seedMidLanding(branch: string, baseBranch: string): { task: TaskRow; run: RunRow; idempotencyKey: string } {
    const created = tasks.create({ prompt: 'land me', state: 'ready', workingDir: repo });
    tasks.setState(created.id, 'running');
    let run = runStore.create(created.id);
    run = runStore.update(run.id, { phase: 'landing', branch, baseBranch });
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
    const { run, idempotencyKey } = seedMidLanding(branch, baseBranch);

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

    const landedRun = runStore.get(run.id);
    expect(landedRun.state).toBe('completed');
    expect(landedRun.phase).toBe('terminal');
    expect(tasks.get(run.taskId).state).toBe('completed');
  });

  it('leaves the Run parked when the world says NOT merged and the real re-apply fails (no such branch to merge)', async () => {
    const branch = 'nonexistent-branch';
    const baseBranch = 'main';
    const { run } = seedMidLanding(branch, baseBranch);

    const coord = new CrashRecoveryCoordinator(runStore, tasks, leases, settle, landing, journal, turnQueue, {
      now: () => 1_000_000,
      isMerged: async () => false,
    });

    await coord.reconcile();

    // The re-apply genuinely failed (no such branch in the real repo) —
    // `foldJournal` shows not-all-ok, so the finishing settle never ran: the
    // Run stays parked mid-landing for a human to retry, same as a real
    // merge-conflict leaves it.
    const parkedRun = runStore.get(run.id);
    expect(parkedRun.state).toBe('running');
    expect(parkedRun.phase).toBe('landing');
    expect(tasks.get(run.taskId).state).toBe('awaiting-review');
  });
});
