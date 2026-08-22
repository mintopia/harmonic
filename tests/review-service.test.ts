import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { RunFactStore } from '../src/domain/run-facts.js';
import { LandingJournalStore } from '../src/domain/landing-journal.js';
import { RunSettleCoordinator } from '../src/domain/run-settle.js';
import { LandingCoordinator } from '../src/domain/landing-coordinator.js';
import { ReviewService } from '../src/domain/review.js';
import { allWorkspaces } from './helpers.js';

describe('ReviewService sweepExpiredReviews', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runStore: RunStore;
  let leases: WorkContextLeaseStore;
  let runFacts: RunFactStore;
  let journal: LandingJournalStore;
  let settle: RunSettleCoordinator;
  let landing: LandingCoordinator;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-review-service-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    runStore = new RunStore(asyncDb);
    leases = new WorkContextLeaseStore(asyncDb);
    runFacts = new RunFactStore(asyncDb);
    journal = new LandingJournalStore(asyncDb);
    settle = new RunSettleCoordinator(runStore, tasks, leases, runFacts, undefined, journal);
    landing = new LandingCoordinator(runStore, asyncDb, journal, settle);
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('yields while sweeping a large overdue review backlog', async () => {
    for (let i = 0; i < 30; i++) {
      const created = await tasks.create({ prompt: `review ${i}`, state: 'ready' });
      await tasks.setState(created.id, 'awaiting-review');
      const run = await runStore.create(created.id);
      await runStore.update(run.id, { phase: 'review', reviewDeadline: 1 });
    }
    let tick = 0;
    let yields = 0;
    const review = new ReviewService(runStore, tasks, settle, landing, undefined, undefined, {
      yieldOptions: {
        budgetMs: 0,
        now: () => tick++,
        yieldNow: async () => {
          yields++;
          await Promise.resolve();
        },
      },
    });

    const swept = await review.sweepExpiredReviews(2);

    expect(swept).toBe(30);
    expect(yields).toBeGreaterThan(0);
    expect((await tasks.list()).every((task) => task.state === 'failed')).toBe(true);
  });
});
