import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb, type Db } from '../src/db/index.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
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
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let wsId: number;
  const mscan = (tickets: Ticket[]) => mirrorScan(tasks, tickets, wsId);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-mirror-'));
    db = openDb(dir);
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(db));
    wsId = allWorkspaces(db)()[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mirrors a fixture ticket into a ready mirrored Task, filling execution defaults', async () => {
    const [task] = await mscan([
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

  it('unescalate flips an escalated Task back to afk and clears the flag', async () => {
    const t = (await mscan([ticket({ number: 9, labels: ['ready-for-agent'] })]))[0]!;
    await tasks.escalate(t.id); // afk Run handed to a human
    expect(await tasks.get(t.id)).toMatchObject({ drive: 'hitl', escalated: true });

    const back = await tasks.unescalate(t.id);
    expect(back).toMatchObject({ drive: 'afk', escalated: false, state: 'ready' });

    // Guards: not escalated, and native.
    await expect(tasks.unescalate(t.id)).rejects.toThrow(/not escalated/);
    const native = await tasks.create({ prompt: 'native' });
    await expect(tasks.unescalate(native.id)).rejects.toThrow(/native/);
  });

  it('is idempotent across re-polls: 1:1, updates in place, re-seeds drive from labels', async () => {
    const t = ticket({ number: 7, labels: ['ready-for-agent'] });
    const first = (await mscan([t]))[0]!;
    expect(first.drive).toBe('afk'); // seeded from ready-for-agent
    // Operator relabels the ticket for a human: a re-poll re-seeds drive.
    const second = (await mscan([{ ...t, title: 'Retitled on the tracker', labels: ['ready-for-human'] }]))[0]!;
    expect(second.id).toBe(first.id); // same row, not a duplicate
    expect(await tasks.list()).toHaveLength(1);
    expect(second.prompt).toContain('Retitled on the tracker'); // shape refreshed
    expect(second.drive).toBe('hitl'); // re-seeded from the new label
  });

  it('re-poll preserves an escalated Task’s drive even when the label still reads ready-for-agent', async () => {
    const t = ticket({ number: 8, labels: ['ready-for-agent'] });
    const first = (await mscan([t]))[0]!;
    // Harmonic escalates at runtime (afk→hitl, escalated flag) without touching the label.
    db.update(tasksTable).set({ drive: 'hitl', escalated: true }).where(eq(tasksTable.id, first.id)).run();
    const second = (await mscan([t]))[0]!; // same ready-for-agent label
    expect(second.drive).toBe('hitl'); // escalation preserved, not re-seeded to afk
    expect(second.escalated).toBe(true);
  });

  it('closed ticket → completed; open blocker → blocked via a real edge; Maps not mirrored', async () => {
    const results = await mscan([
      ticket({ number: 1 }), // open blocker
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'open' }] }),
      ticket({ number: 3, isMap: true, labels: ['wayfinder:map'] }),
    ]);
    expect(results.map((t) => t.state)).toEqual(['ready', 'blocked']); // map skipped → only 2
    const [blocker, dependent] = results;
    expect(await tasks.dependsOn(dependent!.id)).toEqual([blocker!.id]); // blockedBy → Dependency edge
    expect((await tasks.list()).some((t) => t.trackerRef === 3)).toBe(false);
  });

  it('an Epic parent mirrors as hitl — a container is never auto-run', async () => {
    // #200 carries ready-for-agent (would seed afk), but it has a child (#201),
    // so it is an Epic → forced hitl so the Auto-Runner never runs the container.
    const results = await mscan([
      ticket({ number: 200, labels: ['ready-for-agent'] }),
      ticket({ number: 201, parent: 200, labels: ['ready-for-agent'] }),
    ]);
    const epic = results.find((t) => t.trackerRef === 200)!;
    const child = results.find((t) => t.trackerRef === 201)!;
    expect(epic.drive).toBe('hitl'); // Epic → not auto-run despite ready-for-agent
    expect(child.drive).toBe('afk'); // leaf child still afk
  });

  it('an Epic parent is never a blocker: a child "Blocked by" its parent gets no edge', async () => {
    // #106 is an Epic (it has children #107/#108). #108 declares "Blocked by #106",
    // but Epics contain their children, they do not block them → no edge, so #108
    // stays ready rather than blocked behind its own parent.
    const results = await mscan([
      ticket({ number: 106, labels: ['epic'] }),
      ticket({ number: 107, parent: 106, labels: ['ready-for-agent'] }),
      ticket({
        number: 108,
        parent: 106,
        labels: ['ready-for-agent'],
        blockedBy: [{ number: 106, title: 'spine', state: 'open' }],
      }),
    ]);
    const child = results.find((t) => t.trackerRef === 108)!;
    expect(await tasks.dependsOn(child.id)).toEqual([]); // Epic blocker skipped
    expect(child.state).toBe('ready'); // not blocked by its parent
  });

  it('a stale Epic→child blocking edge is removed on the next poll', async () => {
    // Simulate an edge that pre-dates the rule: mirror 108 with #106 as a *non-parent*
    // blocker first (edge created), then re-poll once #106 has a child (now an Epic).
    await mscan([
      ticket({ number: 106 }),
      ticket({ number: 108, blockedBy: [{ number: 106, title: 'spine', state: 'open' }] }),
    ]);
    const before = (await tasks.list()).find((t) => t.trackerRef === 108)!;
    expect(await tasks.dependsOn(before.id)).toHaveLength(1); // edge exists (106 not yet an Epic)

    const results = await mscan([
      ticket({ number: 106 }),
      ticket({ number: 107, parent: 106 }), // #106 is now an Epic (has a child)
      ticket({ number: 108, blockedBy: [{ number: 106, title: 'spine', state: 'open' }] }),
    ]);
    const child = results.find((t) => t.trackerRef === 108)!;
    expect(await tasks.dependsOn(child.id)).toEqual([]); // reconcile removed the stale edge
    expect(child.state).toBe('ready');
  });

  it('close-blocker → blocker completed → dependent unblocks to ready', async () => {
    // First poll: blocker open → dependent blocked.
    await mscan([
      ticket({ number: 1 }),
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'open' }] }),
    ]);
    // Second poll: blocker's issue closed → blocker completed → dependent ready.
    const results = await mscan([
      ticket({ number: 1, state: 'closed', closedAt: '2026-08-07T01:00:00Z' }),
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'closed' }] }),
    ]);
    expect(results.map((t) => t.state)).toEqual(['completed', 'ready']);
  });

  it('a running Task whose own ticket closes stays running — never mirror-completed (issue #139)', async () => {
    // Under the close-after-verify model a mid-run close is premature (only
    // Harmonic closes a ticket, after verify + land). mirrorScan must NOT settle
    // it completed — it leaves the Task running for the premature-closure backstop
    // (Runner.reopenClosedMirrored) to reopen + Escalate.
    const [task] = await mscan([ticket({ number: 8, labels: ['ready-for-agent'] })]);
    await tasks.setState(task!.id, 'running');
    const [after] = await mscan([ticket({ number: 8, state: 'closed', closedAt: '2026-08-07T01:00:00Z' })]);
    expect(after!.state).toBe('running');
  });

  it('reconcile never interrupts a running Run (nothing cascades)', async () => {
    const [, dependent] = await mscan([
      ticket({ number: 1 }),
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'open' }] }),
    ]);
    await tasks.setState(dependent!.id, 'running'); // Auto-Runner picked it up
    // Blocker closes on the next poll — the running dependent must stay running.
    const results = await mscan([
      ticket({ number: 1, state: 'closed', closedAt: '2026-08-07T01:00:00Z' }),
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'closed' }] }),
    ]);
    expect(results[1]!.state).toBe('running');
  });

  it('a Dismissed ref is skipped on re-poll — deleting a mirrored Task does not resurrect it (issue #162)', async () => {
    const [mirrored] = await mscan([ticket({ number: 55, labels: ['ready-for-agent'] })]);
    expect(await tasks.list()).toHaveLength(1);

    await tasks.delete(mirrored!.id); // writes the tracker_dismissals tombstone
    expect(await tasks.isDismissed(wsId, 55)).toBe(true);

    const after = await mscan([ticket({ number: 55, labels: ['ready-for-agent'] })]);
    expect(after).toHaveLength(0); // skipped, not re-created
    expect(await tasks.list()).toHaveLength(0);
  });

  it('operator cannot add/remove an edge whose dependent is a mirrored Task', async () => {
    const [mirrored] = await mscan([ticket({ number: 5, labels: ['ready-for-agent'] })]);
    const native = await tasks.create({ prompt: 'native' });
    await expect(tasks.addDependency(mirrored!.id, native.id)).rejects.toThrow(/mirrored/);
    await expect(tasks.removeDependency(mirrored!.id, native.id)).rejects.toThrow(/mirrored/);
    // A native Task MAY still depend on a mirrored one (the dependent is native).
    const dependent = await tasks.addDependency(native.id, mirrored!.id);
    expect(dependent.dependsOn).toEqual([mirrored!.id]);
  });
});

describe('deriveMaps (query-time rollup)', () => {
  it('groups mirrored Tasks under their map by mapRef, with per-state counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-maps-'));
    const db = openDb(dir);
    const asyncDb = await openAsyncDb(dir);
    const tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(db));
    const wsId = allWorkspaces(db)()[0]!.id;
    const scan = [
      ticket({ number: 19, isMap: true, title: 'Wayfinder', labels: ['wayfinder:map'] }),
      ticket({ number: 30, parent: 19, labels: ['ready-for-agent'] }),
      ticket({ number: 31, parent: 19, state: 'closed' }),
      ticket({ number: 99, parent: null }), // belongs to no map
    ];
    const mirrored = await mirrorScan(tasks, scan, wsId);
    const maps = deriveMaps(scan, mirrored, wsId);
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({ ref: 19, title: 'Wayfinder' });
    expect(maps[0]!.taskRefs.sort()).toEqual([30, 31]);
    expect(maps[0]!.counts).toEqual({ ready: 1, completed: 1 });
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
