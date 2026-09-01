import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig, type AppConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AutoRunner, type MirrorClaim } from '../src/execution/auto-runner.js';
import { GitCircuitBreaker } from '../src/execution/git-failure.js';
import { repoKey } from '../src/execution/repo-lock.js';
import type { AttemptStore } from '../src/domain/attempts.js';
import type { Runner } from '../src/execution/runner.js';
import type { MirrorInput } from '../src/domain/tasks.js';
import type { TrackerFacts } from '../src/db/schema.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

const agentFacts = (ref: number): TrackerFacts => ({
  state: 'open',
  parent: null,
  blockedBy: [],
  labels: ['ready-for-agent'],
  title: `ticket ${ref}`,
  body: '',
  url: `https://example.test/${ref}`,
  createdAt: '2026-08-01T00:00:00Z',
});

const mirroredAfk = (ref: number, over: Partial<MirrorInput> = {}): MirrorInput => ({
  trackerRef: ref,
  prompt: `ticket ${ref}`,
  workflow: 'implement',
  wayfinderType: null,
  mapRef: null,
  closed: false,
  facts: agentFacts(ref),
  ...over,
});

const humanOnlyFacts = (ref: number): TrackerFacts => ({ ...agentFacts(ref), labels: ['ready-for-human'] });

describe('AutoRunner — mirrored afk pick predicate + flip→claim ordering (issue #32)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-arun-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(
      asyncDb,
      () => ({ ...defaultConfig(), defaults: { ...defaultConfig().defaults, isolationMode: 'worktree' } }),
      allWorkspaces(asyncDb, settingsStore),
    );
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('picks agent-workable tickets regardless of assignment, flips ready→working before claim, and spawns through a failed claim', async () => {
    const native = await tasks.create({ prompt: 'native', state: 'ready' });
    const afk = await tasks.upsertMirrored(mirroredAfk(42));
    const hitl = await tasks.upsertMirrored(mirroredAfk(43, { facts: humanOnlyFacts(43) }));
    const assigned = await tasks.upsertMirrored(mirroredAfk(44));
    const failedClaim = await tasks.upsertMirrored(mirroredAfk(45));

    const throwRefs = new Set([45]);
    const claims: Array<{ ref: number | null; stateAtClaim: string }> = [];
    const mirror: MirrorClaim = {
      advertiseClaim: async (t) => {
        claims.push({ ref: t.trackerRef, stateAtClaim: t.state });
        if (t.trackerRef != null && throwRefs.has(t.trackerRef)) throw new Error('claim exploded');
      },
    };

    const started: Array<{ id: number; via: 'start' | 'launchClaimed' }> = [];
    const runner = {
      escalateUnspawned: async () => {},
      start: async (id: number) => {
        started.push({ id, via: 'start' });
        await tasks.setState(id, 'working');
      },
      launchClaimed: (id: number) => {
        started.push({ id, via: 'launchClaimed' });
      },
    } as unknown as Runner;
    const runStore = {
      countRunning: () => started.length,
      countRunningByWorkspace: () => new Map<number, number>(),
    } as unknown as AttemptStore;
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentAttempts: 10 } };

    const runner$ = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb, settingsStore), { mirror });
    runner$.poke();
    await vi.waitFor(() => expect(started).toHaveLength(4));

    const startedIds = started.map((s) => s.id);
    expect(startedIds).toContain(native.id);
    expect(started).toContainEqual({ id: afk.id, via: 'launchClaimed' });
    expect(started).toContainEqual({ id: assigned.id, via: 'launchClaimed' });
    expect(started).toContainEqual({ id: failedClaim.id, via: 'launchClaimed' });
    expect(startedIds).not.toContain(hitl.id);

    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) expect(claim.stateAtClaim).toBe('working');
    expect(claims.map((claim) => claim.ref).sort()).toEqual([42, 44, 45]);
  });
});

describe('AutoRunner — self-scheduling from DB (issue #236)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let autoRunner: AutoRunner | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-arun-scheduler-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
  });
  afterEach(async () => {
    autoRunner?.stop();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts ready work on its interval without a poll or poke', async () => {
    const low = await tasks.create({ prompt: 'low priority interval task', priority: 'low', isolationMode: 'worktree' });
    const high = await tasks.create({ prompt: 'high priority interval task', priority: 'high', isolationMode: 'worktree' });
    const started: number[] = [];
    const runner = {
      escalateUnspawned: async () => {},
      launchClaimed: async (id: number) => started.push(id),
    };
    const runStore = {
      countRunning: async () => started.length,
      countRunningByWorkspace: async () => new Map<number, number>(),
    };
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentAttempts: 1 } };
    autoRunner = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb, settingsStore), { intervalMs: 10 });

    autoRunner.start();
    await vi.waitFor(() => expect(started).toEqual([high.id]));

    expect(started).not.toContain(low.id);
  });

  it('allows only one independent DB handle to claim a ready task', async () => {
    const task = await tasks.create({ prompt: 'cross-handle claim', isolationMode: 'worktree' });
    const secondDb = await openAsyncDb(dir);
    const secondTasks = new TaskService(secondDb, () => defaultConfig(), allWorkspaces(secondDb, settingsStore));

    try {
      const claims = await Promise.all([tasks.claimReady(task.id), secondTasks.claimReady(task.id)]);
      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
      expect((await tasks.get(task.id)).state).toBe('working');
    } finally {
      await secondDb.close();
    }
  });
});

describe('AutoRunner — parallel-Epic base pick gate (issue #159)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-arun-epic-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(
      asyncDb,
      () => ({ ...defaultConfig(), defaults: { ...defaultConfig().defaults, isolationMode: 'worktree' } }),
      allWorkspaces(asyncDb, settingsStore),
    );
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const build = (awaitsEpicBase: (t: { id: number }) => boolean) => {
    const started: number[] = [];
    const runner = {
      escalateUnspawned: async () => {},
      start: async (id: number) => {
        started.push(id);
        await tasks.setState(id, 'working');
      },
      launchClaimed: (id: number) => started.push(id),
    } as unknown as Runner;
    const runStore = {
      countRunning: () => started.length,
      countRunningByWorkspace: () => new Map<number, number>(),
    } as unknown as AttemptStore;
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentAttempts: 10 } };
    const ar = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb, settingsStore), {
      epicBaseNotReady: (t) => awaitsEpicBase(t),
    });
    return { ar, started };
  };

  it('skips a base-pending Epic member, admits a non-gated Task, and picks it once the gate opens', async () => {
    const gated = await tasks.upsertMirrored(mirroredAfk(11));
    const free = await tasks.upsertMirrored(mirroredAfk(99));
    const pending = new Set<number>([gated.id]);

    const { ar, started } = build((t) => pending.has(t.id));
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(free.id));

    expect(started).not.toContain(gated.id);
    expect((await tasks.get(gated.id)).state).toBe('ready');

    pending.delete(gated.id);
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(gated.id));
  });
});

describe('AutoRunner — skip reasons and unresolvable integration bases (issue #238)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-arun-skips-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(
      asyncDb,
      () => ({ ...defaultConfig(), defaults: { ...defaultConfig().defaults, isolationMode: 'worktree' } }),
      allWorkspaces(asyncDb, settingsStore),
    );
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('clears capacity and an expired git-backoff reason, then starts the Task', async () => {
    const task = await tasks.create({ prompt: 'wait for a slot' });
    const started: number[] = [];
    let running = 1;
    let now = 0;
    const breaker = new GitCircuitBreaker({ threshold: 3, baseMs: 10_000, maxMs: 10_000 }, () => now);
    breaker.recordFailure(repoKey(task.workingDir));
    const runner = {
      escalateUnspawned: async () => {},
      launchClaimed: async (id: number) => {
        started.push(id);
        running += 1;
      },
    };
    const runStore = {
      countRunning: async () => running,
      countRunningByWorkspace: async () => new Map<number, number>(),
    };
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentAttempts: 1 } };
    const autoRunner = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb, settingsStore), { gitBreaker: breaker });

    autoRunner.poke();
    await vi.waitFor(() => expect(autoRunner.skipReasonFor(task.id)).toBe('at capacity'));
    expect(started).toEqual([]);

    running = 0;
    autoRunner.poke();
    await vi.waitFor(() => expect(autoRunner.skipReasonFor(task.id)).toContain('git workspace-prep backoff'));
    expect(started).toEqual([]);

    now = 10_000;
    autoRunner.poke();
    await vi.waitFor(() => expect(started).toEqual([task.id]));
    expect(autoRunner.skipReasonFor(task.id)).toBeUndefined();
  });

  it('escalates an Epic member only after its assigned integration branch stays missing past the reconciliation grace window', async () => {
    const task = await tasks.upsertMirrored(mirroredAfk(208));
    await tasks.setBaseBranch(task.id, 'epic/208');
    const started: number[] = [];
    const runner = { launchClaimed: async (id: number) => started.push(id), escalateUnspawned: (id: number, reason: string) => tasks.escalate(id, reason).then(() => {}) };
    const runStore = {
      countRunning: async () => started.length,
      countRunningByWorkspace: async () => new Map<number, number>(),
    };
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentAttempts: 1 } };
    let now = 0;
    const autoRunner = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb, settingsStore), {
      epicBaseNotReady: (candidate) => candidate.baseBranch === 'epic/208',
      missingEpicBaseGraceMs: 100,
      clock: () => now,
    });

    autoRunner.poke();
    await vi.waitFor(() => expect(autoRunner.skipReasonFor(task.id)).toBe('integration branch missing'));
    expect(started).toEqual([]);

    autoRunner.poke();
    await vi.waitFor(async () => expect((await tasks.get(task.id)).state).not.toBe('escalated'));

    now = 100;
    autoRunner.poke();
    await vi.waitFor(async () => {
      expect(await tasks.get(task.id)).toMatchObject({
        state: 'escalated',
        escalationReason: expect.stringContaining('integration branch epic/208 missing'),
      });
      expect(autoRunner.skipReasonFor(task.id)).toBeUndefined();
    }, { timeout: 5000 });
    expect(started).toEqual([]);
  });

  it('clears a missing integration-branch reason when the branch reappears inside the grace window', async () => {
    const task = await tasks.upsertMirrored(mirroredAfk(209));
    await tasks.setBaseBranch(task.id, 'epic/209');
    const started: number[] = [];
    let now = 0;
    let missing = true;
    const runner = { launchClaimed: async (id: number) => started.push(id), escalateUnspawned: (id: number, reason: string) => tasks.escalate(id, reason).then(() => {}) };
    const runStore = {
      countRunning: async () => started.length,
      countRunningByWorkspace: async () => new Map<number, number>(),
    };
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentAttempts: 1 } };
    const autoRunner = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb, settingsStore), {
      epicBaseNotReady: (candidate) => missing && candidate.baseBranch === 'epic/209',
      missingEpicBaseGraceMs: 100,
      clock: () => now,
    });

    autoRunner.poke();
    await vi.waitFor(() => expect(autoRunner.skipReasonFor(task.id)).toBe('integration branch missing'));

    now = 99;
    missing = false;
    autoRunner.poke();
    await vi.waitFor(() => expect(started).toEqual([task.id]));
    expect(autoRunner.skipReasonFor(task.id)).toBeUndefined();
    expect((await tasks.get(task.id)).state).not.toBe('escalated');
  });
});

describe('AutoRunner — Work Context House Rule pick predicate (ADR-0001)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-arun-hr-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const build = () => {
    const started: number[] = [];
    const runner = {
      escalateUnspawned: async () => {},
      start: async (id: number) => {
        started.push(id);
        await tasks.setState(id, 'working');
      },
      launchClaimed: (id: number) => started.push(id),
    } as unknown as Runner;
    const runStore = {
      countRunning: () => started.length,
      countRunningByWorkspace: () => new Map<number, number>(),
    } as unknown as AttemptStore;
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentAttempts: 10 } };
    const ar = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb, settingsStore), undefined);
    return { ar, started };
  };

  const freshDir = () => mkdtempSync(join(tmpdir(), 'harmonic-hr-ctx-'));
  const directTask = (workingDir: string, prompt: string) =>
    tasks.create({ prompt, workingDir, isolationMode: 'direct' });

  it('skips a ready afk Task whose direct Work Context holds a running afk Run; admits a distinct-context Task, with a reason naming the occupant', async () => {
    const busy = freshDir();
    const occupant = await directTask(busy, 'occupant');
    await tasks.setState(occupant.id, 'working');
    const blocked = await directTask(busy, 'same context');
    const free = await directTask(freshDir(), 'other context');

    const { ar, started } = build();
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(free.id));

    expect(started).not.toContain(blocked.id);
    expect((await tasks.get(blocked.id)).state).toBe('ready');
    expect(ar.skipReasonFor(blocked.id)).toBe(`Work Context held by task ${occupant.id} (working)`);
    expect(ar.skipReasonFor(free.id)).toBeUndefined();
  });

  it('reports only open blocker edges in a ready task dependency diagnostic', async () => {
    const completedBlocker = await directTask(freshDir(), 'completed blocker');
    await tasks.setState(completedBlocker.id, 'done');
    const openBlocker = await tasks.create({ prompt: 'open blocker', workingDir: freshDir() });
    const dependent = await directTask(freshDir(), 'dependent');
    await tasks.addDependency(dependent.id, completedBlocker.id);
    await tasks.addDependency(dependent.id, openBlocker.id);

    const { ar } = build();
    ar.poke();

    await vi.waitFor(() => expect(ar.skipReasonFor(dependent.id)).toBe(`blocked-by #${openBlocker.id}`));
  });

  it('an escalated occupant no longer holds the context — its Run settled and the branch is evidence, not live work (ADR-0041)', async () => {
    const busy = freshDir();
    const escalated = await directTask(busy, 'escalated');
    await tasks.escalate(escalated.id, 'escalated to human: attempt 2 of 2 failed');
    const next = await directTask(busy, 'same context');

    const { ar, started } = build();
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(next.id));

    expect(started).not.toContain(escalated.id);
    expect((await tasks.get(escalated.id)).state).toBe('escalated');
    expect(ar.skipReasonFor(next.id)).toBeUndefined();
  });

  it('exempts worktree-mode Tasks — a unique key per Run means they parallelize even off a shared base dir', async () => {
    const shared = freshDir();
    const occupant = await tasks.create({ prompt: 'wt occupant', workingDir: shared, isolationMode: 'worktree' });
    await tasks.setState(occupant.id, 'working');
    const candidate = await tasks.create({ prompt: 'wt candidate', workingDir: shared, isolationMode: 'worktree' });

    const { ar, started } = build();
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(candidate.id));
    expect(ar.skipReasonFor(candidate.id)).toBeUndefined();
  });

  it('leaves priority-then-FIFO ordering intact among the other ready Tasks while one is context-blocked', async () => {
    const busy = freshDir();
    const occupant = await directTask(busy, 'occupant');
    await tasks.setState(occupant.id, 'working');
    const blocked = await tasks.create({ prompt: 'blocked high', workingDir: busy, isolationMode: 'direct', priority: 'high' });
    const low = await tasks.create({ prompt: 'low', workingDir: freshDir(), isolationMode: 'direct', priority: 'low' });
    const high = await tasks.create({ prompt: 'high', workingDir: freshDir(), isolationMode: 'direct', priority: 'high' });
    const normalFirst = await tasks.create({ prompt: 'normal 1', workingDir: freshDir(), isolationMode: 'direct', priority: 'normal' });
    const normalSecond = await tasks.create({ prompt: 'normal 2', workingDir: freshDir(), isolationMode: 'direct', priority: 'normal' });

    const { ar, started } = build();
    ar.poke();
    await vi.waitFor(() => expect(started).toHaveLength(4));

    expect(started).toEqual([high.id, normalFirst.id, normalSecond.id, low.id]);
    expect(started).not.toContain(blocked.id);
    expect(ar.skipReasonFor(blocked.id)).toBe(`Work Context held by task ${occupant.id} (working)`);
  });

  it('waitingSince (issue #125): starts a clock on the first House-Rule-blocked pass and clears it once unblocked', async () => {
    const busy = freshDir();
    const occupant = await directTask(busy, 'occupant');
    await tasks.setState(occupant.id, 'working');
    const blocked = await directTask(busy, 'same context');
    const free = await directTask(freshDir(), 'other context');

    const { ar, started } = build();
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(free.id));

    expect(ar.skipReasonFor(blocked.id)).toBeDefined();
    const startedWaiting = ar.waitingSince(blocked.id);
    expect(startedWaiting).toBeDefined();
    expect(ar.waitingSince(free.id)).toBeUndefined();

    ar.poke();
    await new Promise((r) => setTimeout(r, 20));
    expect(ar.waitingSince(blocked.id)).toBe(startedWaiting);

    await tasks.setState(occupant.id, 'done');
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(blocked.id));
    expect(ar.waitingSince(blocked.id)).toBeUndefined();
  });
});
