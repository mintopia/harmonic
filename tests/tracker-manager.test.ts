import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { TrackerPollerManager } from '../src/tracker/manager.js';
import { deriveMaps } from '../src/tracker/mirror.js';
import type { Ticket, TrackerAdapter } from '../src/tracker/adapter.js';
import { EPIC_LABEL, TrackerResolutionError } from '../src/tracker/adapter.js';
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
  let polled: string[];
  let ticketsByRepo: Map<string, Ticket[]>;
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
    const on = await workspaces.create({ name: 'On', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    expect(manager.coordinatorFor(on.id)).toBeDefined();
    const off = (await workspaces.list()).find((w) => w.id !== on.id)!;
    expect(manager.coordinatorFor(off.id)).toBeUndefined();
    expect(polled).not.toContain(off.workingDir);
    expect(polled).toContain(repoA);
  });

  it('mirrors each repo into its own board — overlapping issue numbers stay distinct', async () => {
    ticketsByRepo.set(repoA, [ticket(5)]);
    ticketsByRepo.set(repoB, [ticket(5)]);
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
    expect(inA[0]!.id).not.toBe(inB[0]!.id);
  });

  it('maps() stamps each rollup with its Workspace and scopes by id — colliding map refs stay distinct', async () => {
    const mapTicket = { ...ticket(19), isMap: true, title: 'Wayfinder', labels: ['wayfinder:map'] };
    const member = (n: number): Ticket => ({ ...ticket(n), parent: 19 });
    ticketsByRepo.set(repoA, [mapTicket, member(30)]);
    ticketsByRepo.set(repoB, [mapTicket, member(31)]);
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    const b = await workspaces.create({ name: 'B', workingDir: repoB, trackerEnabled: true });
    await manager.sync();
    await waitFor(async () => (await tasks.list()).length === 2 || undefined);

    const all = await manager.maps();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.workspaceId).sort()).toEqual([a.id, b.id].sort());

    const scopedA = await manager.maps(a.id);
    expect(scopedA).toHaveLength(1);
    expect(scopedA[0]).toMatchObject({ workspaceId: a.id, ref: 19, taskRefs: [30] });
  });

  it('derives epics, maps, and the ready frontier from persisted facts before any post-restart poll (#234)', async () => {
    const fixture: Ticket[] = [
      { ...ticket(10), title: 'Spec epic', labels: [EPIC_LABEL] },
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
    const legacyMaps = deriveMaps(fixture, mirrored, workspace.id);
    const beforeRestart = await manager.listEpics(workspace.id);
    expect((await manager.listEpicTickets(workspace.id)).map((t) => t.number).sort((a, b) => a - b)).toEqual([10, 19]);
    expect(beforeRestart.find((epic) => epic.ref === 10)?.ready).toEqual([11]);
    expect(beforeRestart.map((epic) => ({
      ref: epic.ref,
      title: epic.title,
      members: epic.members.map((member) => member.ref),
      ready: epic.ready,
    }))).toEqual([
      { ref: 10, title: 'Spec epic', members: [11, 12, 13], ready: [11] },
      { ref: 19, title: 'Delivery map', members: [20], ready: [20] },
    ]);
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

  it('epicDetail resolves a closed Epic from persisted facts; listEpics stays open-only (#409, #443)', async () => {
    ticketsByRepo.set(repoA, [
      { ...ticket(10), title: 'Closed epic', labels: [EPIC_LABEL] },
      { ...ticket(11), title: 'Closed epic member', parent: 10 },
    ]);
    const workspace = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    await manager.pollNow(workspace.id);

    ticketsByRepo.set(repoA, [
      { ...ticket(10), title: 'Closed epic', state: 'closed', closedAt: '2026-08-10T00:00:00Z', labels: [EPIC_LABEL] },
      { ...ticket(11), title: 'Closed epic member', parent: 10 },
    ]);
    await manager.pollNow(workspace.id);

    const beforeRestart = await manager.epicDetail(workspace.id, 10);
    expect(beforeRestart?.ref).toBe(10);
    expect(beforeRestart?.members.map((member) => member.ref)).toEqual([11]);
    expect((await manager.listEpics(workspace.id)).map((epic) => epic.ref)).not.toContain(10);

    manager.stopAll();
    await asyncDb.close();
    asyncDb = await openAsyncDb(dataDir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    workspaces = new WorkspaceService(asyncDb, settingsStore);
    manager = new TrackerPollerManager(tasks, () => workspaces.list(), async () => {
      throw new Error('restart query must not resolve or poll the tracker');
    });

    expect(await manager.epicDetail(workspace.id, 10)).toEqual(beforeRestart);
    expect((await manager.listEpics(workspace.id)).map((epic) => epic.ref)).not.toContain(10);
  });

  it('resolves an integrated Epic the scan has aged out from its stored snapshot; it leaves the Board but stays a Tasks-list filter (#439)', async () => {
    ticketsByRepo.set(repoA, [
      { ...ticket(19), title: 'Delivery map', labels: ['wayfinder:map'], isMap: true },
      { ...ticket(20), title: 'Map member', parent: 19 },
    ]);
    const workspace = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    await manager.pollNow(workspace.id);

    await tasks.markEpicIntegrated(workspace.id, 19, { mergeCommit: 'abc123', memberRefs: [20] });

    ticketsByRepo.set(repoA, []);
    await manager.pollNow(workspace.id);

    const detail = await manager.epicDetail(workspace.id, 19);
    expect(detail?.ref).toBe(19);
    expect(detail?.kind).toBe('map');
    expect(detail?.members.map((m) => m.ref)).toEqual([20]);
    expect(detail?.ready).toEqual([]);
    expect(detail?.title).toBe('Epic #19');

    expect(detail?.state).toBe('integrated');
    expect((await manager.listEpics(workspace.id)).map((e) => e.ref)).not.toContain(19);
    expect((await manager.listEpicTickets(workspace.id)).map((t) => t.number)).toContain(19);

    manager.stopAll();
    await asyncDb.close();
    asyncDb = await openAsyncDb(dataDir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    workspaces = new WorkspaceService(asyncDb, settingsStore);
    manager = new TrackerPollerManager(tasks, () => workspaces.list(), async () => {
      throw new Error('restart query must not resolve or poll the tracker');
    });
    expect((await manager.epicDetail(workspace.id, 19))?.members.map((m) => m.ref)).toEqual([20]);
  });

  it('narrows a stored plain-epic kind to the read-model spec when resolving from the record (#439)', async () => {
    ticketsByRepo.set(repoA, [
      { ...ticket(10), title: 'Plain epic', labels: [EPIC_LABEL] },
      { ...ticket(11), title: 'Member', parent: 10 },
    ]);
    const workspace = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    await manager.pollNow(workspace.id);
    await tasks.markEpicIntegrated(workspace.id, 10, { mergeCommit: null, memberRefs: [11] });

    ticketsByRepo.set(repoA, []);
    await manager.pollNow(workspace.id);

    const detail = await manager.epicDetail(workspace.id, 10);
    expect(detail?.kind).toBe('spec');
    expect(detail?.members.map((m) => m.ref)).toEqual([11]);
  });

  it('never resolves an open stored Epic from the record once it ages out (#439)', async () => {
    ticketsByRepo.set(repoA, [
      { ...ticket(10), title: 'Open epic', labels: [EPIC_LABEL] },
      { ...ticket(11), parent: 10 },
    ]);
    const workspace = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    await manager.pollNow(workspace.id);

    ticketsByRepo.set(repoA, []);
    await manager.pollNow(workspace.id);

    expect((await manager.listEpics(workspace.id)).map((e) => e.ref)).toEqual([]);
    expect(await manager.epicDetail(workspace.id, 10)).toBeNull();
    expect(await manager.epicDetail(workspace.id, 999)).toBeNull();
  });

  it('resolves an integrated nested leaf-most Epic by ref; its bare spine parent never surfaces (#439, #443)', async () => {
    ticketsByRepo.set(repoA, [
      { ...ticket(100), title: 'Spine parent' },
      { ...ticket(101), title: 'Leaf-most epic B', parent: 100, labels: [EPIC_LABEL] },
      { ...ticket(102), title: 'Work C', parent: 101 },
    ]);
    const workspace = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    await manager.pollNow(workspace.id);

    await tasks.markEpicIntegrated(workspace.id, 101, { mergeCommit: 'def456', memberRefs: [102] });

    expect((await manager.listEpics(workspace.id)).map((e) => e.ref)).toEqual([]);

    const detail = await manager.epicDetail(workspace.id, 101);
    expect(detail?.ref).toBe(101);
    expect(detail?.members.map((m) => m.ref)).toEqual([102]);
  });

  it('toggling one Workspace starts/stops just its loop; others are unaffected', async () => {
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    const b = await workspaces.create({ name: 'B', workingDir: repoB, trackerEnabled: false });
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeDefined();
    expect(manager.coordinatorFor(b.id)).toBeUndefined();

    await workspaces.update(b.id, { trackerEnabled: true });
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeDefined();
    expect(manager.coordinatorFor(b.id)).toBeDefined();

    await workspaces.update(a.id, { trackerEnabled: false });
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeUndefined();
    expect(manager.coordinatorFor(b.id)).toBeDefined();
  });

  it('deleting a Workspace stops its loop and cascades its board', async () => {
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await tasks.create({ prompt: 'on A', workspaceId: a.id });
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeDefined();

    await workspaces.delete(a.id);
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeUndefined();
    expect(await tasks.list({ workspaceId: a.id })).toHaveLength(0);
  });

  it('delete refuses a running Task but allows the last Workspace (issue #61)', async () => {
    const a = await workspaces.create({ name: 'A', workingDir: repoA });
    const running = await tasks.create({ prompt: 'busy', workspaceId: a.id });
    await tasks.setState(running.id, 'working');
    await expect(workspaces.delete(a.id)).rejects.toThrow(/running/);

    await tasks.setState(running.id, 'ready');
    await workspaces.delete(a.id);
    const last = await workspaces.list();
    expect(last).toHaveLength(1);
    await workspaces.delete(last[0]!.id);
    expect(await workspaces.list()).toHaveLength(0);
  });

  it('pollNow forces an immediate re-poll for a Workspace; a tracker-off one is a no-op', async () => {
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    ticketsByRepo.set(repoA, [ticket(7)]);
    await manager.pollNow(a.id);
    expect((await tasks.list({ workspaceId: a.id })).map((t) => t.trackerRef)).toContain(7);

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
    expect(after).not.toBe(before);
    expect(polled).toContain(repoB);
  });

  it('caches the Resolved Tracker for a tracker-enabled Workspace (issue #83)', async () => {
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    expect(manager.resolvedTracker(a.id)).toEqual({ ok: true, name: 'stub', label: 'stub' });
    const off = (await workspaces.list()).find((w) => w.id !== a.id)!;
    expect(manager.resolvedTracker(off.id)).toBeNull();
  });

  it('an enabled but unresolvable tracker caches the reason and never starts a loop (issue #83)', async () => {
    unresolvable.add(repoA);
    const a = await workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    await manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeUndefined();
    expect(manager.resolvedTracker(a.id)).toMatchObject({ ok: false, code: 'no-declaration' });
    expect(ticketsByRepo.get(repoA)).toBeUndefined();
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
    expect(manager.coordinatorFor(a.id)).toBeUndefined();

    unresolvable.delete(repoA);
    ticketsByRepo.set(repoA, [ticket(9)]);
    await manager.pollNow(a.id);
    expect(manager.resolvedTracker(a.id)).toMatchObject({ ok: true });
    expect(manager.coordinatorFor(a.id)).toBeDefined();
    await waitFor(async () => (await tasks.list({ workspaceId: a.id })).some((t) => t.trackerRef === 9) || undefined);

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
