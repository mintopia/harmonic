import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb, type Db } from '../src/db/index.js';
import { tasks as tasksTable } from '../src/db/schema.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { deriveRole, mirrorScan, deriveMaps } from '../src/tracker/mirror.js';
import type { Ticket } from '../src/tracker/adapter.js';
import { allWorkspaces } from './helpers.js';

const ticket = (over: Partial<Ticket>): Ticket => ({
  number: 100,
  title: 'A ticket',
  state: 'open',
  body: '',
  createdAt: '2026-08-07T00:00:00Z',
  closedAt: null,
  labels: [],
  assignees: [],
  parent: null,
  blockedBy: [],
  blocking: [],
  comments: [],
  isMap: false,
  url: 'https://github.com/mintopia/harmonic/issues/100',
  ...over,
});

describe('deriveRole (labels → workflow/wayfinderType/drive)', () => {
  it('research → wayfinder/research/afk', () => {
    expect(deriveRole(ticket({ labels: ['wayfinder:research', 'ready-for-agent'] }))).toEqual({
      workflow: 'wayfinder',
      wayfinderType: 'research',
      drive: 'afk',
    });
  });
  it('grilling/prototype/bare-task → hitl', () => {
    expect(deriveRole(ticket({ labels: ['wayfinder:grilling'] })).drive).toBe('hitl');
    expect(deriveRole(ticket({ labels: ['wayfinder:prototype'] })).drive).toBe('hitl');
    expect(deriveRole(ticket({ labels: ['wayfinder:task'] })).drive).toBe('hitl');
  });
  it('implement: ready-for-agent → afk, ready-for-human → hitl, bare → afk (unclear)', () => {
    expect(deriveRole(ticket({ labels: ['ready-for-agent'] }))).toEqual({
      workflow: 'implement',
      wayfinderType: null,
      drive: 'afk',
    });
    expect(deriveRole(ticket({ labels: ['ready-for-human'] })).drive).toBe('hitl');
    expect(deriveRole(ticket({ labels: [] })).drive).toBe('afk');
  });
});

describe('mirrorScan upsert', () => {
  let dir: string;
  let db: Db;
  let tasks: TaskService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-mirror-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('mirrors a fixture ticket into a ready mirrored Task, filling execution defaults', () => {
    const [task] = mirrorScan(tasks, [
      ticket({ number: 42, title: 'Add rate limiting', body: 'per CONTEXT.md', labels: ['ready-for-agent'] }),
    ]);
    expect(task).toMatchObject({
      origin: 'mirrored',
      trackerRef: 42,
      workflow: 'implement',
      wayfinderType: null,
      drive: 'afk',
      state: 'ready',
      escalated: false,
      prompt: 'Add rate limiting\n\nper CONTEXT.md',
      harness: 'claude',
      priority: 'normal',
    });
  });

  it('unescalate flips an escalated Task back to afk and clears the flag', () => {
    const t = mirrorScan(tasks, [ticket({ number: 9, labels: ['ready-for-agent'] })])[0]!;
    tasks.escalate(t.id); // afk Run handed to a human
    expect(tasks.get(t.id)).toMatchObject({ drive: 'hitl', escalated: true });

    const back = tasks.unescalate(t.id);
    expect(back).toMatchObject({ drive: 'afk', escalated: false, state: 'ready' });

    // Guards: not escalated, and native.
    expect(() => tasks.unescalate(t.id)).toThrow(/not escalated/);
    const native = tasks.create({ prompt: 'native' });
    expect(() => tasks.unescalate(native.id)).toThrow(/native/);
  });

  it('is idempotent across re-polls: 1:1, updates in place, preserves drive', () => {
    const t = ticket({ number: 7, labels: ['wayfinder:research'] });
    const first = mirrorScan(tasks, [t])[0]!;
    // Human/runtime flips drive to hitl (escalation); a re-poll must not re-seed it.
    tasks.setState(first.id, 'ready');
    db.update(tasksTable).set({ drive: 'hitl' }).where(eq(tasksTable.id, first.id)).run();
    const second = mirrorScan(tasks, [{ ...t, title: 'Retitled on the tracker' }])[0]!;
    expect(second.id).toBe(first.id); // same row, not a duplicate
    expect(tasks.list()).toHaveLength(1);
    expect(second.prompt).toContain('Retitled on the tracker'); // shape refreshed
    expect(second.drive).toBe('hitl'); // Harmonic-owned drive preserved
  });

  it('closed ticket → completed; open blocker → blocked via a real edge; Maps not mirrored', () => {
    const results = mirrorScan(tasks, [
      ticket({ number: 1 }), // open blocker
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'open' }] }),
      ticket({ number: 3, isMap: true, labels: ['wayfinder:map'] }),
    ]);
    expect(results.map((t) => t.state)).toEqual(['ready', 'blocked']); // map skipped → only 2
    const [blocker, dependent] = results;
    expect(tasks.dependsOn(dependent!.id)).toEqual([blocker!.id]); // blockedBy → Dependency edge
    expect(tasks.list().some((t) => t.trackerRef === 3)).toBe(false);
  });

  it('close-blocker → blocker completed → dependent unblocks to ready', () => {
    // First poll: blocker open → dependent blocked.
    mirrorScan(tasks, [
      ticket({ number: 1 }),
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'open' }] }),
    ]);
    // Second poll: blocker's issue closed → blocker completed → dependent ready.
    const results = mirrorScan(tasks, [
      ticket({ number: 1, state: 'closed', closedAt: '2026-08-07T01:00:00Z' }),
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'closed' }] }),
    ]);
    expect(results.map((t) => t.state)).toEqual(['completed', 'ready']);
  });

  it('reconcile never interrupts a running Run (nothing cascades)', () => {
    const [, dependent] = mirrorScan(tasks, [
      ticket({ number: 1 }),
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'open' }] }),
    ]);
    tasks.setState(dependent!.id, 'running'); // Auto-Runner picked it up
    // Blocker closes on the next poll — the running dependent must stay running.
    const results = mirrorScan(tasks, [
      ticket({ number: 1, state: 'closed', closedAt: '2026-08-07T01:00:00Z' }),
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'closed' }] }),
    ]);
    expect(results[1]!.state).toBe('running');
  });

  it('operator cannot add/remove an edge whose dependent is a mirrored Task', () => {
    const [mirrored] = mirrorScan(tasks, [ticket({ number: 5, labels: ['ready-for-agent'] })]);
    const native = tasks.create({ prompt: 'native' });
    expect(() => tasks.addDependency(mirrored!.id, native.id)).toThrow(/mirrored/);
    expect(() => tasks.removeDependency(mirrored!.id, native.id)).toThrow(/mirrored/);
    // A native Task MAY still depend on a mirrored one (the dependent is native).
    const dependent = tasks.addDependency(native.id, mirrored!.id);
    expect(dependent.dependsOn).toEqual([mirrored!.id]);
  });
});

describe('deriveMaps (query-time rollup)', () => {
  it('groups mirrored Tasks under their map by mapRef, with per-state counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-maps-'));
    const db = openDb(dir);
    const tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    const scan = [
      ticket({ number: 19, isMap: true, title: 'Wayfinder', labels: ['wayfinder:map'] }),
      ticket({ number: 30, parent: 19, labels: ['ready-for-agent'] }),
      ticket({ number: 31, parent: 19, state: 'closed' }),
      ticket({ number: 99, parent: null }), // belongs to no map
    ];
    const mirrored = mirrorScan(tasks, scan);
    const maps = deriveMaps(scan, mirrored);
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({ ref: 19, title: 'Wayfinder' });
    expect(maps[0]!.taskRefs.sort()).toEqual([30, 31]);
    expect(maps[0]!.counts).toEqual({ ready: 1, completed: 1 });
    rmSync(dir, { recursive: true, force: true });
  });
});
