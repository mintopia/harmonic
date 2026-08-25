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
import type { RunStore } from '../src/domain/runs.js';
import type { Runner } from '../src/execution/runner.js';
import type { MirrorInput } from '../src/domain/tasks.js';
import { allWorkspaces } from './helpers.js';

const mirroredAfk = (ref: number, over: Partial<MirrorInput> = {}): MirrorInput => ({
  trackerRef: ref,
  prompt: `ticket ${ref}`,
  workflow: 'implement',
  wayfinderType: null,
  drive: 'afk',
  mapRef: null,
  closed: false,
  ...over,
});

describe('AutoRunner — mirrored afk pick predicate + flip→claim ordering (issue #32)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-arun-'));
    asyncDb = await openAsyncDb(dir);
    // Worktree default so these Tasks are exempt from the Work Context House Rule
    // (issue #120): mirrored Tasks all inherit the one Workspace workingDir, and
    // in direct mode that shared context would serialize them — this test is about
    // the mirrored pick and claim path, not context occupancy.
    tasks = new TaskService(
      asyncDb,
      () => ({ ...defaultConfig(), defaults: { ...defaultConfig().defaults, isolationMode: 'worktree' } }),
      allWorkspaces(asyncDb),
    );
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('picks drive≠hitl regardless of assignment, flips ready→running before claim, and spawns through a failed claim', async () => {
    const native = await tasks.create({ prompt: 'native', state: 'ready' });
    const afk = await tasks.upsertMirrored(mirroredAfk(42));
    const hitl = await tasks.upsertMirrored(mirroredAfk(43, { drive: 'hitl' }));
    const assigned = await tasks.upsertMirrored(mirroredAfk(44));
    const failedClaim = await tasks.upsertMirrored(mirroredAfk(45));

    const throwRefs = new Set([45]); // advertiseClaim throws → must still spawn
    const claims: Array<{ ref: number | null; stateAtClaim: string }> = [];
    const mirror: MirrorClaim = {
      advertiseClaim: async (t) => {
        claims.push({ ref: t.trackerRef, stateAtClaim: t.state });
        if (t.trackerRef != null && throwRefs.has(t.trackerRef)) throw new Error('claim exploded');
      },
    };

    const started: Array<{ id: number; via: 'start' | 'launchClaimed' }> = [];
    const runner = {
      start: async (id: number) => {
        started.push({ id, via: 'start' });
        await tasks.setState(id, 'running'); // native path flips inside the runner
      },
      launchClaimed: (id: number) => {
        started.push({ id, via: 'launchClaimed' });
      },
    } as unknown as Runner;
    const runStore = {
      countRunning: () => started.length,
      countRunningByWorkspace: () => new Map<number, number>(),
    } as unknown as RunStore;
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentRuns: 10 } };

    const runner$ = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb), { mirror });
    runner$.poke();
    await vi.waitFor(() => expect(started).toHaveLength(4));

    const startedIds = started.map((s) => s.id);
    // Picked: native (start), afk + assigned + failed-claim (launchClaimed).
    expect(startedIds).toContain(native.id);
    expect(started).toContainEqual({ id: afk.id, via: 'launchClaimed' });
    expect(started).toContainEqual({ id: assigned.id, via: 'launchClaimed' });
    expect(started).toContainEqual({ id: failedClaim.id, via: 'launchClaimed' });
    // Skipped: hitl (drive). Assignment does not enter the predicate.
    expect(startedIds).not.toContain(hitl.id);

    // Every recheck saw the Task already flipped to running → flip precedes claim.
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) expect(claim.stateAtClaim).toBe('running');
    expect(claims.map((claim) => claim.ref).sort()).toEqual([42, 44, 45]);
  });
});

describe('AutoRunner — self-scheduling from DB (issue #236)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let autoRunner: AutoRunner | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-arun-scheduler-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
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
      launchClaimed: async (id: number) => started.push(id),
    };
    const runStore = {
      countRunning: async () => started.length,
      countRunningByWorkspace: async () => new Map<number, number>(),
    };
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentRuns: 1 } };
    autoRunner = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb), { intervalMs: 10 });

    autoRunner.start();
    await vi.waitFor(() => expect(started).toEqual([high.id]));

    expect(started).not.toContain(low.id);
  });

  it('allows only one independent DB handle to claim a ready task', async () => {
    const task = await tasks.create({ prompt: 'cross-handle claim', isolationMode: 'worktree' });
    const secondDb = await openAsyncDb(dir);
    const secondTasks = new TaskService(secondDb, () => defaultConfig(), allWorkspaces(secondDb));

    try {
      const claims = await Promise.all([tasks.claimReady(task.id), secondTasks.claimReady(task.id)]);
      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
      expect((await tasks.get(task.id)).state).toBe('running');
    } finally {
      await secondDb.close();
    }
  });
});

/**
 * The parallel-Epic base pick gate (issue #159): the Auto-Runner skips a ready
 * mirrored Epic member whose integration-branch base has not yet been set by the
 * poll's reconcile, leaving it `ready` on the frontier. Without this, the mirror
 * insert's `ready` poke could spawn the member before its base is resolved,
 * forking it from the working dir's branch instead of `epic/<ref>`.
 */
describe('AutoRunner — parallel-Epic base pick gate (issue #159)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-arun-epic-'));
    asyncDb = await openAsyncDb(dir);
    // Worktree default so these mirrored Tasks are exempt from the Work Context
    // House Rule (issue #120) — this test is about the Epic base gate alone.
    tasks = new TaskService(
      asyncDb,
      () => ({ ...defaultConfig(), defaults: { ...defaultConfig().defaults, isolationMode: 'worktree' } }),
      allWorkspaces(asyncDb),
    );
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const build = (awaitsEpicBase: (t: { id: number }) => boolean) => {
    const started: number[] = [];
    const runner = {
      start: async (id: number) => {
        started.push(id);
        await tasks.setState(id, 'running');
      },
      launchClaimed: (id: number) => started.push(id),
    } as unknown as Runner;
    const runStore = {
      countRunning: () => started.length,
      countRunningByWorkspace: () => new Map<number, number>(),
    } as unknown as RunStore;
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentRuns: 10 } };
    const ar = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb), {
      epicBaseNotReady: (t) => awaitsEpicBase(t),
    });
    return { ar, started };
  };

  it('skips a base-pending Epic member, admits a non-gated Task, and picks it once the gate opens', async () => {
    const gated = await tasks.upsertMirrored(mirroredAfk(11)); // Epic member, base pending
    const free = await tasks.upsertMirrored(mirroredAfk(99)); // not an Epic member
    const pending = new Set<number>([gated.id]);

    const { ar, started } = build((t) => pending.has(t.id));
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(free.id));

    expect(started).not.toContain(gated.id);
    expect((await tasks.get(gated.id)).state).toBe('ready'); // held on the frontier, not spawned unbased

    // The reconcile sets its base → the gate opens → the next pass picks it.
    pending.delete(gated.id);
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(gated.id));
  });
});

describe('AutoRunner — skip reasons and unresolvable integration bases (issue #238)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-arun-skips-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(
      asyncDb,
      () => ({ ...defaultConfig(), defaults: { ...defaultConfig().defaults, isolationMode: 'worktree' } }),
      allWorkspaces(asyncDb),
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
      launchClaimed: async (id: number) => {
        started.push(id);
        running += 1;
      },
    };
    const runStore = {
      countRunning: async () => running,
      countRunningByWorkspace: async () => new Map<number, number>(),
    };
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentRuns: 1 } };
    const autoRunner = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb), { gitBreaker: breaker });

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
    const runner = { launchClaimed: async (id: number) => started.push(id) };
    const runStore = {
      countRunning: async () => started.length,
      countRunningByWorkspace: async () => new Map<number, number>(),
    };
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentRuns: 1 } };
    let now = 0;
    const autoRunner = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb), {
      epicBaseNotReady: (candidate) => candidate.baseBranch === 'epic/208',
      missingEpicBaseGraceMs: 100,
      clock: () => now,
    });

    autoRunner.poke();
    await vi.waitFor(() => expect(autoRunner.skipReasonFor(task.id)).toBe('integration branch missing'));
    expect(started).toEqual([]);

    // The next scheduler pass still permits tracker reconciliation to re-cut
    // the branch. An absent branch alone is not proof that it cannot recover.
    autoRunner.poke();
    await vi.waitFor(async () => expect((await tasks.get(task.id)).escalated).toBe(false));

    now = 100;
    autoRunner.poke();
    // The escalate DB write lands mid-pass; the terminal 'hitl, escalated to
    // human' reason is only recorded by the fill loop's SECOND refresh pass.
    // Poll DB state and skip reason together so the assertion can't observe
    // the window between them (the transient 'integration branch missing,
    // escalated to human' reason, or a mid-rebuild empty map).
    await vi.waitFor(async () => {
      expect(await tasks.get(task.id)).toMatchObject({ state: 'ready', drive: 'hitl', escalated: true });
      expect(autoRunner.skipReasonFor(task.id)).toBe('hitl, escalated to human');
    }, { timeout: 5000 });
    expect(started).toEqual([]);
  });

  it('clears a missing integration-branch reason when the branch reappears inside the grace window', async () => {
    const task = await tasks.upsertMirrored(mirroredAfk(209));
    await tasks.setBaseBranch(task.id, 'epic/209');
    const started: number[] = [];
    let now = 0;
    let missing = true;
    const runner = { launchClaimed: async (id: number) => started.push(id) };
    const runStore = {
      countRunning: async () => started.length,
      countRunningByWorkspace: async () => new Map<number, number>(),
    };
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentRuns: 1 } };
    const autoRunner = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb), {
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
    expect((await tasks.get(task.id)).escalated).toBe(false);
  });
});

/**
 * The Work Context House Rule pick predicate (ADR-0022, issue #120): the
 * Auto-Runner skips a ready afk Task whose direct-mode Work Context is already
 * occupied by a running or awaiting-review afk Run, leaving it `ready` with a
 * legible skip-reason. The hard lease (#119) stays the authoritative gate; this
 * predicate exists to avoid pick churn and produce a diagnosable queue. It reads
 * occupancy from Task state (not the lease store) because the lease is released
 * the moment a Run settles into awaiting-review (seam for #114).
 */
describe('AutoRunner — Work Context House Rule pick predicate (issue #120, ADR-0022)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-arun-hr-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // A ceiling well above the task count, so the two-level cap never masks the
  // context predicate under test.
  const build = () => {
    const started: number[] = [];
    const runner = {
      start: async (id: number) => {
        started.push(id);
        await tasks.setState(id, 'running'); // native path flips inside the runner
      },
      launchClaimed: (id: number) => started.push(id),
    } as unknown as Runner;
    const runStore = {
      countRunning: () => started.length,
      countRunningByWorkspace: () => new Map<number, number>(),
    } as unknown as RunStore;
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentRuns: 10 } };
    const ar = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb), undefined);
    return { ar, started };
  };

  const freshDir = () => mkdtempSync(join(tmpdir(), 'harmonic-hr-ctx-'));
  const directTask = (workingDir: string, prompt: string) =>
    tasks.create({ prompt, workingDir, isolationMode: 'direct' });

  it('skips a ready afk Task whose direct Work Context holds a running afk Run; admits a distinct-context Task, with a reason naming the occupant', async () => {
    const busy = freshDir();
    const occupant = await directTask(busy, 'occupant');
    await tasks.setState(occupant.id, 'running');
    const blocked = await directTask(busy, 'same context'); // shares the occupied dir
    const free = await directTask(freshDir(), 'other context'); // distinct dir → admits

    const { ar, started } = build();
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(free.id));

    expect(started).not.toContain(blocked.id);
    expect((await tasks.get(blocked.id)).state).toBe('ready'); // stays on the frontier
    expect(ar.skipReasonFor(blocked.id)).toBe(`Work Context held by task ${occupant.id} (running)`);
    expect(ar.skipReasonFor(free.id)).toBeUndefined(); // admitted → no reason
  });

  it('still skips when the occupying Run sits in awaiting-review — the lease is gone but the work is not', async () => {
    const busy = freshDir();
    const reviewing = await directTask(busy, 'awaiting review');
    await tasks.setState(reviewing.id, 'awaiting-review'); // hard lease already released here
    const blocked = await directTask(busy, 'same context');
    const free = await directTask(freshDir(), 'other context'); // barrier: proves the fill pass ran

    const { ar, started } = build();
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(free.id));

    expect(started).not.toContain(blocked.id);
    expect((await tasks.get(blocked.id)).state).toBe('ready');
    expect(ar.skipReasonFor(blocked.id)).toBe(`Work Context held by task ${reviewing.id} (awaiting-review)`);
  });

  it('exempts worktree-mode Tasks — a unique key per Run means they parallelize even off a shared base dir', async () => {
    const shared = freshDir();
    const occupant = await tasks.create({ prompt: 'wt occupant', workingDir: shared, isolationMode: 'worktree' });
    await tasks.setState(occupant.id, 'running');
    const candidate = await tasks.create({ prompt: 'wt candidate', workingDir: shared, isolationMode: 'worktree' });

    const { ar, started } = build();
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(candidate.id));
    expect(ar.skipReasonFor(candidate.id)).toBeUndefined();
  });

  it('leaves priority-then-FIFO ordering intact among the other ready Tasks while one is context-blocked', async () => {
    const busy = freshDir();
    const occupant = await directTask(busy, 'occupant');
    await tasks.setState(occupant.id, 'running');
    // A high-priority Task sharing the occupied context: it must be skipped
    // despite its priority, and skipping it must not perturb the others' order.
    const blocked = await tasks.create({ prompt: 'blocked high', workingDir: busy, isolationMode: 'direct', priority: 'high' });
    // Distinct contexts, mixed priorities + a same-priority pair for the FIFO tiebreak.
    const low = await tasks.create({ prompt: 'low', workingDir: freshDir(), isolationMode: 'direct', priority: 'low' });
    const high = await tasks.create({ prompt: 'high', workingDir: freshDir(), isolationMode: 'direct', priority: 'high' });
    const normalFirst = await tasks.create({ prompt: 'normal 1', workingDir: freshDir(), isolationMode: 'direct', priority: 'normal' });
    const normalSecond = await tasks.create({ prompt: 'normal 2', workingDir: freshDir(), isolationMode: 'direct', priority: 'normal' });

    const { ar, started } = build();
    ar.poke();
    await vi.waitFor(() => expect(started).toHaveLength(4));

    // High, then FIFO within normal, then low — the context-blocked high-priority
    // Task is simply absent, not reordering anything.
    expect(started).toEqual([high.id, normalFirst.id, normalSecond.id, low.id]);
    expect(started).not.toContain(blocked.id);
    expect(ar.skipReasonFor(blocked.id)).toBe(`Work Context held by task ${occupant.id} (running)`);
  });

  it('waitingSince (issue #125): starts a clock on the first House-Rule-blocked pass and clears it once unblocked', async () => {
    const busy = freshDir();
    const occupant = await directTask(busy, 'occupant');
    await tasks.setState(occupant.id, 'running');
    const blocked = await directTask(busy, 'same context');
    const free = await directTask(freshDir(), 'other context'); // barrier: proves the fill pass ran

    const { ar, started } = build();
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(free.id));

    expect(ar.skipReasonFor(blocked.id)).toBeDefined();
    const startedWaiting = ar.waitingSince(blocked.id);
    expect(startedWaiting).toBeDefined();
    expect(ar.waitingSince(free.id)).toBeUndefined(); // never blocked → no clock

    // A later pass while still blocked doesn't restart the clock.
    ar.poke();
    await new Promise((r) => setTimeout(r, 20));
    expect(ar.waitingSince(blocked.id)).toBe(startedWaiting);

    // The occupant frees the context — a later pass admits `blocked`, and its
    // clock is cleared when the scheduler reason is gone.
    await tasks.setState(occupant.id, 'completed');
    ar.poke();
    await vi.waitFor(() => expect(started).toContain(blocked.id));
    expect(ar.waitingSince(blocked.id)).toBeUndefined();
  });
});
