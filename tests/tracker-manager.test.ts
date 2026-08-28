import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { TrackerPollerManager } from '../src/tracker/manager.js';
import { deriveEpics } from '../src/domain/epic-derivation.js';
import { deriveMaps } from '../src/tracker/mirror.js';
import type { Ticket, TrackerAdapter } from '../src/tracker/adapter.js';
import { TrackerResolutionError } from '../src/tracker/adapter.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, waitFor } from './helpers.js';
import { yieldToEventLoop } from '../src/reliability/yield.js';

const ticket = (number: number): Ticket => ({
  number,
  title: `ticket ${number}`,
  state: 'open',
  body: '',
  createdAt: '2026-08-07T00:00:00Z',
  closedAt: null,
  labels: ['ready-for-agent'],
  assignees: [],
  parent: null,
  blockedBy: [],
  blocking: [],
  comments: [],
  isMap: false,
  url: `https://x/${number}`,
});

describe('TrackerPollerManager — per-Workspace poll loops (issue #45)', () => {
  let dataDir: string;
  let repoA: string;
  let repoB: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let workspaces: WorkspaceService;
  let manager: TrackerPollerManager;
  /** Working dirs the manager actually resolved an adapter for — a tracker-off Workspace must never appear. */
  let polled: string[];
  /** Per-repo canned scan; both repos deliberately share issue #5 to prove board isolation. */
  let ticketsByRepo: Map<string, Ticket[]>;
  /** Repos whose tracker won't resolve — the "enabled but unresolvable" gate (issue #83). */
  let unresolvable: Set<string>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-mgr-'));
    repoA = mkdtempSync(join(tmpdir(), 'harmonic-repoA-'));
    repoB = mkdtempSync(join(tmpdir(), 'harmonic-repoB-'));
    asyncDb = await openAsyncDb(dataDir);
    settingsStore = await makeSettingsStore(dataDir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    workspaces = new WorkspaceService(asyncDb, settingsStore);
    polled = [];
    ticketsByRepo = new Map();
    unresolvable = new Set();
    const resolveAdapter = async (repoRoot: string): Promise<TrackerAdapter> => {
      if (unresolvable.has(repoRoot))
        throw new TrackerResolutionError('no-declaration', `No tracker declaration at ${repoRoot}`);
      polled.push(repoRoot);
      return {
        name: 'stub',
        scan: async () => ticketsByRepo.get(repoRoot) ?? [],
        readTicket: async (r) => ticket(r.number),
        claim: async () => {},
        release: async () => {},
        close: async () => {},
        reopen: async () => {},
      };
    };
    manager = new TrackerPollerManager(tasks, () => workspaces.list(), resolveAdapter);
  });
  afterEach(async () => {
    manager.stopAll();
    await asyncDb.close();
    for (const d of [dataDir, repoA, repoB]) rmSync(d, { recursive: true, force: true });
  });

  it('starts a loop only for tracker-enabled Workspaces; a tracker-off one never polls', async () => {
    // Default (boot-time) Workspace: tracker off. A second, tracker-on Workspace.
    const on = await workspaces.create({ name: 'On', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    expect(manager.coordinatorFor(on.id)).toBeDefined();
    // The default Workspace has tracker off — its dir was never resolved.
    const off = (await workspaces.list()).find((w) => w.id !== on.id)!;
    expect(manager.coordinatorFor(off.id)).toBeUndefined();
    expect(polled).not.toContain(off.workingDir);
    expect(polled).toContain(repoA);
  });

  it('mirrors each repo into its own board — overlapping issue numbers stay distinct', async () => {
    ticketsByRepo.set(repoA, [ticket(5)]);
    ticketsByRepo.set(repoB, [ticket(5)]); // same number, different repo
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    const b = await workspaces.create({ name: 'B', workingDir: repoB, trackerEnabled: true });
    await manager.sync();

    await waitFor(async () => (await tasks.list()).length === 2 || undefined);
    const inA = await tasks.list({ workspaceId: a.id });
    const inB = await tasks.list({ workspaceId: b.id });
    expect(inA).toHaveLength(1);
    expect(inB).toHaveLength(1);
    expect(inA[0]).toMatchObject({ trackerRef: 5, workspaceId: a.id });
    expect(inB[0]).toMatchObject({ trackerRef: 5, workspaceId: b.id });
    expect(inA[0]!.id).not.toBe(inB[0]!.id); // distinct Tasks, not one shared row
  });

  it('maps() stamps each rollup with its Workspace and scopes by id — colliding map refs stay distinct', async () => {
    const mapTicket = { ...ticket(19), isMap: true, title: 'Wayfinder', labels: ['wayfinder:map'] };
    const member = (n: number): Ticket => ({ ...ticket(n), parent: 19 });
    ticketsByRepo.set(repoA, [mapTicket, member(30)]);
    ticketsByRepo.set(repoB, [mapTicket, member(31)]); // same map ref #19, different repo
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    const b = await workspaces.create({ name: 'B', workingDir: repoB, trackerEnabled: true });
    await manager.sync();
    await waitFor(async () => (await tasks.list()).length === 2 || undefined);

    const all = await manager.maps();
    expect(all).toHaveLength(2); // one per Workspace, not one collapsed row
    expect(all.map((m) => m.workspaceId).sort()).toEqual([a.id, b.id].sort());

    const scopedA = await manager.maps(a.id);
    expect(scopedA).toHaveLength(1);
    expect(scopedA[0]).toMatchObject({ workspaceId: a.id, ref: 19, taskRefs: [30] });
  });

  it('derives epics, maps, and the ready frontier from persisted facts before any post-restart poll (#234)', async () => {
    const fixture: Ticket[] = [
      { ...ticket(10), title: 'Spec epic', labels: [] },
      { ...ticket(11), title: 'Ready member', parent: 10 },
      { ...ticket(12), title: 'Human member', parent: 10, labels: [] },
      { ...ticket(13), title: 'Blocked member', parent: 10, blockedBy: [{ number: 99, title: 'Open blocker', state: 'open' }] },
      { ...ticket(19), title: 'Delivery map', labels: ['wayfinder:map'], isMap: true },
      { ...ticket(20), title: 'Map member', parent: 19 },
      { ...ticket(99), title: 'Open blocker', labels: [] },
    ];
    ticketsByRepo.set(repoA, fixture);
    const workspace = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    await manager.pollNow(workspace.id);

    const mirrored = (await tasks.list({ workspaceId: workspace.id })).filter((task) => task.origin === 'mirrored');
    const mirroredWithDeps = (await tasks.listWithDeps({ workspaceId: workspace.id })).filter((task) => task.origin === 'mirrored');
    const legacyEpics = deriveEpics(
      fixture,
      new Map(
        mirroredWithDeps
          .filter((task) => task.trackerRef !== null)
          .map((task) => [task.trackerRef!, { agentWorkable: task.agentWorkable }]),
      ),
    );
    const legacyMaps = deriveMaps(fixture, mirrored, workspace.id);
    const beforeRestart = await manager.listEpics(workspace.id);
    // #13 is excluded through the real TaskService Blocker edge and its
    // derived agentWorkable flag, not a hand-built frontier input.
    expect(beforeRestart.find((epic) => epic.ref === 10)?.ready).toEqual([11]);
    expect(beforeRestart.map((epic) => ({
      ref: epic.ref,
      title: epic.title,
      kind: epic.kind,
      members: epic.members.map((member) => member.ref),
      ready: epic.ready,
    }))).toEqual(legacyEpics);
    expect(await manager.maps(workspace.id)).toEqual(legacyMaps);

    manager.stopAll();
    await asyncDb.close();
    asyncDb = await openAsyncDb(dataDir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    workspaces = new WorkspaceService(asyncDb, settingsStore);
    manager = new TrackerPollerManager(tasks, () => workspaces.list(), async () => {
      throw new Error('restart query must not resolve or poll the tracker');
    });

    expect(await manager.listEpics(workspace.id)).toEqual(beforeRestart);
    expect(await manager.epicDetail(workspace.id, 10)).toEqual(beforeRestart.find((epic) => epic.ref === 10));
    expect(await manager.maps(workspace.id)).toEqual(legacyMaps);
  });

  it('toggling one Workspace starts/stops just its loop; others are unaffected', async () => {
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    const b = await workspaces.create({ name: 'B', workingDir: repoB, trackerEnabled: false });
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeDefined();
    expect(manager.coordinatorFor(b.id)).toBeUndefined();

    await workspaces.update(b.id, { trackerEnabled: true }); // enable B
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeDefined(); // A untouched
    expect(manager.coordinatorFor(b.id)).toBeDefined();

    await workspaces.update(a.id, { trackerEnabled: false }); // disable A
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeUndefined(); // only A's loop stopped
    expect(manager.coordinatorFor(b.id)).toBeDefined();
  });

  it('deleting a Workspace stops its loop and cascades its board', async () => {
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await tasks.create({ prompt: 'on A', workspaceId: a.id }); // a Task on the doomed board
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeDefined();

    await workspaces.delete(a.id);
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeUndefined();
    expect(await tasks.list({ workspaceId: a.id })).toHaveLength(0); // board went with it
  });

  it('delete refuses a running Task but allows the last Workspace (issue #61)', async () => {
    const a = await workspaces.create({ name: 'A', workingDir: repoA });
    const running = await tasks.create({ prompt: 'busy', workspaceId: a.id });
    await tasks.setState(running.id, 'working');
    await expect(workspaces.delete(a.id)).rejects.toThrow(/running/);

    await tasks.setState(running.id, 'ready');
    await workspaces.delete(a.id); // now allowed
    const last = await workspaces.list();
    expect(last).toHaveLength(1);
    await workspaces.delete(last[0]!.id); // the last Workspace goes too — no more guard
    expect(await workspaces.list()).toHaveLength(0);
  });

  it('pollNow forces an immediate re-poll for a Workspace; a tracker-off one is a no-op', async () => {
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    // A ticket appears after the loop started; a manual refresh mirrors it now.
    ticketsByRepo.set(repoA, [ticket(7)]);
    await manager.pollNow(a.id);
    expect((await tasks.list({ workspaceId: a.id })).map((t) => t.trackerRef)).toContain(7);

    // The default (tracker-off) Workspace has no loop — pollNow resolves without polling it.
    const off = (await workspaces.list()).find((w) => w.id !== a.id)!;
    const before = polled.length;
    await expect(manager.pollNow(off.id)).resolves.toBeUndefined();
    expect(polled).not.toContain(off.workingDir);
    expect(polled.length).toBe(before);
  });

  it('repointing the repo or interval rebuilds the loop against the new value', async () => {
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    const before = manager.coordinatorFor(a.id);

    await workspaces.update(a.id, { workingDir: repoB });
    await manager.sync();
    const after = manager.coordinatorFor(a.id);
    expect(after).toBeDefined();
    expect(after).not.toBe(before); // fresh coordinator ⇒ fresh poll loop
    expect(polled).toContain(repoB);
  });

  it('caches the Resolved Tracker for a tracker-enabled Workspace (issue #83)', async () => {
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    expect(manager.resolvedTracker(a.id)).toEqual({ ok: true, name: 'stub', label: 'stub' });
    // The tracker-off default Workspace has nothing to resolve.
    const off = (await workspaces.list()).find((w) => w.id !== a.id)!;
    expect(manager.resolvedTracker(off.id)).toBeNull();
  });

  it('an enabled but unresolvable tracker caches the reason and never starts a loop (issue #83)', async () => {
    unresolvable.add(repoA);
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeUndefined(); // no poll loop
    expect(manager.resolvedTracker(a.id)).toMatchObject({ ok: false, code: 'no-declaration' });
    expect(ticketsByRepo.get(repoA)).toBeUndefined();
    // The gate never scanned the repo — resolution failed before any poll.
    expect(polled).not.toContain(repoA);
  });

  it('disabling tracking drops the cached Resolved Tracker (issue #83)', async () => {
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    expect(manager.resolvedTracker(a.id)).toMatchObject({ ok: true });

    await workspaces.update(a.id, { trackerEnabled: false });
    await manager.sync();
    expect(manager.resolvedTracker(a.id)).toBeNull();
    expect(manager.coordinatorFor(a.id)).toBeUndefined();
  });

  it('a manual refresh re-resolves: a fixed tracker starts the loop, a broken one tears it down (issue #83)', async () => {
    unresolvable.add(repoA);
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeUndefined(); // enabled but unresolvable ⇒ no loop yet

    // The operator adds the declaration; a refresh resolves it and brings the loop up now.
    unresolvable.delete(repoA);
    ticketsByRepo.set(repoA, [ticket(9)]);
    await manager.pollNow(a.id);
    expect(manager.resolvedTracker(a.id)).toMatchObject({ ok: true });
    expect(manager.coordinatorFor(a.id)).toBeDefined();
    await waitFor(async () => (await tasks.list({ workspaceId: a.id })).some((t) => t.trackerRef === 9) || undefined);

    // It breaks again; a refresh caches the failure and stops the loop.
    unresolvable.add(repoA);
    await manager.pollNow(a.id);
    expect(manager.resolvedTracker(a.id)).toMatchObject({ ok: false });
    expect(manager.coordinatorFor(a.id)).toBeUndefined();
  });

  it('yields while syncing a large workspace backlog', async () => {
    manager.stopAll();
    let tick = 0;
    let yields = 0;
    const order: string[] = [];
    const extraRepos: string[] = [];
    manager = new TrackerPollerManager(tasks, () => workspaces.list(), async (repoRoot: string) => {
      polled.push(repoRoot);
      return {
        name: 'stub',
        scan: async () => [],
        readTicket: async (r) => ticket(r.number),
        claim: async () => {},
        release: async () => {},
        close: async () => {},
        reopen: async () => {},
      };
    }, undefined, undefined, undefined, undefined, {
      yieldOptions: {
        budgetMs: 0,
        now: () => tick++,
        yieldNow: async () => {
          yields++;
          await yieldToEventLoop();
        },
      },
    });
    for (let i = 0; i < 30; i++) {
      const workingDir = mkdtempSync(join(tmpdir(), `harmonic-sync-${i}-`));
      extraRepos.push(workingDir);
      await workspaces.create({
        name: `W${i}`,
        workingDir,
        trackerEnabled: true,
      });
    }

    const done = manager.sync().then(() => order.push('done'));
    setImmediate(() => order.push('immediate'));
    await done;
    await yieldToEventLoop();

    expect(yields).toBeGreaterThan(0);
    expect(order.indexOf('immediate')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('immediate')).toBeLessThan(order.indexOf('done'));
    expect(polled.length).toBeGreaterThan(0);
    for (const workingDir of extraRepos) rmSync(workingDir, { recursive: true, force: true });
  });
});
