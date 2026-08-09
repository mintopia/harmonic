import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { TrackerPollerManager } from '../src/tracker/manager.js';
import type { Ticket, TrackerAdapter } from '../src/tracker/adapter.js';
import { allWorkspaces, waitFor } from './helpers.js';

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
  let db: Db;
  let tasks: TaskService;
  let workspaces: WorkspaceService;
  let manager: TrackerPollerManager;
  /** Working dirs the manager actually resolved an adapter for — a tracker-off Workspace must never appear. */
  let polled: string[];
  /** Per-repo canned scan; both repos deliberately share issue #5 to prove board isolation. */
  let ticketsByRepo: Map<string, Ticket[]>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-mgr-'));
    repoA = mkdtempSync(join(tmpdir(), 'harmonic-repoA-'));
    repoB = mkdtempSync(join(tmpdir(), 'harmonic-repoB-'));
    db = openDb(dataDir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    workspaces = new WorkspaceService(db);
    polled = [];
    ticketsByRepo = new Map();
    const resolveAdapter = async (repoRoot: string): Promise<TrackerAdapter> => {
      polled.push(repoRoot);
      return {
        name: 'stub',
        scan: async () => ticketsByRepo.get(repoRoot) ?? [],
        readTicket: async (r) => ticket(r.number),
        claim: async () => {},
        release: async () => {},
        whoami: async () => 'me',
        close: async () => {},
      };
    };
    manager = new TrackerPollerManager(tasks, () => workspaces.list(), resolveAdapter);
  });
  afterEach(() => {
    manager.stopAll();
    for (const d of [dataDir, repoA, repoB]) rmSync(d, { recursive: true, force: true });
  });

  it('starts a loop only for tracker-enabled Workspaces; a tracker-off one never polls', () => {
    // Default (boot-time) Workspace: tracker off. A second, tracker-on Workspace.
    const on = workspaces.create({ name: 'On', workingDir: repoA, trackerEnabled: true });
    manager.sync();
    expect(manager.coordinatorFor(on.id)).toBeDefined();
    // The default Workspace has tracker off — its dir was never resolved.
    const off = workspaces.list().find((w) => w.id !== on.id)!;
    expect(manager.coordinatorFor(off.id)).toBeUndefined();
    expect(polled).not.toContain(off.workingDir);
    expect(polled).toContain(repoA);
  });

  it('mirrors each repo into its own board — overlapping issue numbers stay distinct', async () => {
    ticketsByRepo.set(repoA, [ticket(5)]);
    ticketsByRepo.set(repoB, [ticket(5)]); // same number, different repo
    const a = workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    const b = workspaces.create({ name: 'B', workingDir: repoB, trackerEnabled: true });
    manager.sync();

    await waitFor(async () => tasks.list().length === 2 || undefined);
    const inA = tasks.list({ workspaceId: a.id });
    const inB = tasks.list({ workspaceId: b.id });
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
    const a = workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    const b = workspaces.create({ name: 'B', workingDir: repoB, trackerEnabled: true });
    manager.sync();
    await waitFor(async () => tasks.list().length === 2 || undefined);

    const all = manager.maps();
    expect(all).toHaveLength(2); // one per Workspace, not one collapsed row
    expect(all.map((m) => m.workspaceId).sort()).toEqual([a.id, b.id].sort());

    const scopedA = manager.maps(a.id);
    expect(scopedA).toHaveLength(1);
    expect(scopedA[0]).toMatchObject({ workspaceId: a.id, ref: 19, taskRefs: [30] });
  });

  it('toggling one Workspace starts/stops just its loop; others are unaffected', () => {
    const a = workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    const b = workspaces.create({ name: 'B', workingDir: repoB, trackerEnabled: false });
    manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeDefined();
    expect(manager.coordinatorFor(b.id)).toBeUndefined();

    workspaces.update(b.id, { trackerEnabled: true }); // enable B
    manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeDefined(); // A untouched
    expect(manager.coordinatorFor(b.id)).toBeDefined();

    workspaces.update(a.id, { trackerEnabled: false }); // disable A
    manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeUndefined(); // only A's loop stopped
    expect(manager.coordinatorFor(b.id)).toBeDefined();
  });

  it('deleting a Workspace stops its loop and cascades its board', () => {
    const a = workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    tasks.create({ prompt: 'on A', workspaceId: a.id }); // a Task on the doomed board
    manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeDefined();

    workspaces.delete(a.id);
    manager.sync();
    expect(manager.coordinatorFor(a.id)).toBeUndefined();
    expect(tasks.list({ workspaceId: a.id })).toHaveLength(0); // board went with it
  });

  it('delete refuses a running Task but allows the last Workspace (issue #61)', () => {
    const a = workspaces.create({ name: 'A', workingDir: repoA });
    const running = tasks.create({ prompt: 'busy', workspaceId: a.id });
    tasks.setState(running.id, 'running');
    expect(() => workspaces.delete(a.id)).toThrow(/running/);

    tasks.setState(running.id, 'ready');
    workspaces.delete(a.id); // now allowed
    const last = workspaces.list();
    expect(last).toHaveLength(1);
    workspaces.delete(last[0]!.id); // the last Workspace goes too — no more guard
    expect(workspaces.list()).toHaveLength(0);
  });

  it('repointing the repo or interval rebuilds the loop against the new value', () => {
    const a = workspaces.create({ name: 'A', workingDir: repoA, trackerEnabled: true });
    manager.sync();
    const before = manager.coordinatorFor(a.id);

    workspaces.update(a.id, { workingDir: repoB });
    manager.sync();
    const after = manager.coordinatorFor(a.id);
    expect(after).toBeDefined();
    expect(after).not.toBe(before); // fresh coordinator ⇒ fresh poll loop
    expect(polled).toContain(repoB);
  });
});
