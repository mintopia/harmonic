import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { tasks as tasksTable } from '../src/db/schema.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { deriveRole, mirrorScan, deriveMaps, toMirrorInput } from '../src/tracker/mirror.js';
import { mirroredAgentEligible } from '../src/domain/agent-workable.js';
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

describe('deriveRole (labels → workflow/wayfinderType)', () => {
  it('research → wayfinder/research', () => {
    expect(deriveRole(ticket({ labels: ['wayfinder:research', 'ready-for-agent'] }))).toEqual({
      workflow: 'wayfinder',
      wayfinderType: 'research',
    });
  });
  it('no wayfinder label → implement', () => {
    expect(deriveRole(ticket({ labels: ['ready-for-agent'] }))).toEqual({ workflow: 'implement', wayfinderType: null });
  });
});

describe('mirroredAgentEligible (labels → agent-workable, ADR-0041; the label half of the derived flag)', () => {
  it('grilling/prototype/bare-task are human-only even with ready-for-agent', () => {
    expect(mirroredAgentEligible(['ready-for-agent'], 'grilling', false)).toBe(false);
    expect(mirroredAgentEligible(['ready-for-agent'], 'prototype', false)).toBe(false);
    expect(mirroredAgentEligible(['ready-for-agent'], 'task', false)).toBe(false);
  });
  it('implement: ready-for-agent is the positive gate; ready-for-human wins even when both are present (issue #230)', () => {
    expect(mirroredAgentEligible(['ready-for-agent'], null, false)).toBe(true);
    expect(mirroredAgentEligible(['ready-for-agent', 'ready-for-human'], null, false)).toBe(false);
    expect(mirroredAgentEligible(['ready-for-human'], null, false)).toBe(false);
  });
  it('no ready-for-agent ⇒ human-only regardless of any other label (opt-in, not opt-out)', () => {
    expect(mirroredAgentEligible([], null, false)).toBe(false);
    expect(mirroredAgentEligible(['needs-triage'], null, false)).toBe(false);
    expect(mirroredAgentEligible(['needs-info'], null, false)).toBe(false);
    expect(mirroredAgentEligible(['wontfix'], null, false)).toBe(false);
    // wayfinder:research is not a human-only kind, but still needs the opt-in.
    expect(mirroredAgentEligible(['wayfinder:research'], 'research', false)).toBe(false);
    expect(mirroredAgentEligible(['wayfinder:research', 'ready-for-agent'], 'research', false)).toBe(true);
  });
  it('an Epic container is never agent-workable, whatever its labels', () => {
    expect(mirroredAgentEligible(['ready-for-agent'], null, true)).toBe(false);
  });
});

describe('mirrorScan upsert', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let wsId: number;
  const mscan = (tickets: Ticket[]) => mirrorScan(tasks, tickets, wsId);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-mirror-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    wsId = (await allWorkspaces(asyncDb)())[0]!.id;
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
      state: 'ready',
      prompt: 'Add rate limiting\n\nper CONTEXT.md',
      harness: 'claude',
      priority: 'normal',
    });
  });

  it('escalate records the reason on the ticket; requeue with guidance clears it and returns the ticket to ready', async () => {
    const t = (await mscan([ticket({ number: 9, labels: ['ready-for-agent'] })]))[0]!;
    await tasks.escalate(t.id, 'escalated to human: attempt 2 of 2 failed');
    expect(await tasks.get(t.id)).toMatchObject({ state: 'escalated', escalationReason: 'escalated to human: attempt 2 of 2 failed' });

    const back = await tasks.requeue(t.id, 'try the other endpoint');
    expect(back).toMatchObject({ state: 'ready', escalationReason: null, feedback: 'try the other endpoint' });

    // Guard: only an escalated ticket takes guidance.
    await expect(tasks.requeue(t.id, 'again')).rejects.toThrow(/only escalated/);
  });

  it('is idempotent across re-polls: 1:1, updates in place, agent-workability follows the labels', async () => {
    const t = ticket({ number: 7, labels: ['ready-for-agent'] });
    const first = (await mscan([t]))[0]!;
    expect((await tasks.withDeps(first)).agentWorkable).toBe(true); // opted in by ready-for-agent
    // Operator relabels the ticket for a human: a re-poll re-derives workability.
    const second = (await mscan([{ ...t, title: 'Retitled on the tracker', labels: ['ready-for-human'] }]))[0]!;
    expect(second.id).toBe(first.id); // same row, not a duplicate
    expect(await tasks.list()).toHaveLength(1);
    expect(second.prompt).toContain('Retitled on the tracker'); // shape refreshed
    expect((await tasks.withDeps(second)).agentWorkable).toBe(false); // derived from the new label
  });

  it('derives humanOnly from the labels alone — a blocked ticket keeps its agent/human identity', async () => {
    const blockedBy = [{ number: 1, title: 'blocker', state: 'open' as const }];
    const scanned = await mscan([
      ticket({ number: 1, labels: ['ready-for-agent'] }),
      ticket({ number: 2, labels: ['ready-for-agent'], blockedBy }),
      ticket({ number: 3, labels: ['ready-for-human'], blockedBy }),
    ]);
    const byRef = (ref: number) => tasks.withDeps(scanned.find((t) => t.trackerRef === ref)!);
    expect(await byRef(1)).toMatchObject({ humanOnly: false, agentWorkable: true, openBlockerCount: 0 });
    // Blocked, but still the agent's once the blocker clears.
    expect(await byRef(2)).toMatchObject({ humanOnly: false, agentWorkable: false, openBlockerCount: 1 });
    // Blocked and human-only: agentWorkable alone could not tell these two apart.
    expect(await byRef(3)).toMatchObject({ humanOnly: true, agentWorkable: false, openBlockerCount: 1 });
    expect((await tasks.listWithDeps({ workspaceId: wsId })).map((t) => [t.trackerRef, t.humanOnly])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
  });

  it('re-poll never moves an escalated Task, even when the label still reads ready-for-agent', async () => {
    const t = ticket({ number: 8, labels: ['ready-for-agent'] });
    const first = (await mscan([t]))[0]!;
    // Harmonic escalates at runtime without touching the label.
    await tasks.escalate(first.id, 'escalated to human: attempt 2 of 2 failed');
    const second = (await mscan([t]))[0]!; // same ready-for-agent label
    expect(second.state).toBe('escalated'); // an escalation is Harmonic's own fact
    expect(second.escalationReason).toBe('escalated to human: attempt 2 of 2 failed');
  });

  it('closed ticket → done; open blocker → a real edge; Maps not mirrored', async () => {
    const results = await mscan([
      ticket({ number: 1 }), // open blocker
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'open' }] }),
      ticket({ number: 3, isMap: true, labels: ['wayfinder:map'] }),
    ]);
    expect(results.map((t) => t.state)).toEqual(['ready', 'ready']); // map skipped → only 2
    const [blocker, dependent] = results;
    expect(await tasks.dependsOn(dependent!.id)).toEqual([blocker!.id]); // blockedBy → Dependency edge
    expect((await tasks.withDeps(await tasks.get(dependent!.id))).openBlockerCount).toBe(1);
    expect((await tasks.list()).some((t) => t.trackerRef === 3)).toBe(false);
  });

  it('an Epic parent is never agent-workable — a container is never auto-run', async () => {
    // #200 carries ready-for-agent, but it has a child (#201), so it is an
    // Epic → derived not agent-workable so the Auto-Runner never runs the container.
    const results = await mscan([
      ticket({ number: 200, labels: ['ready-for-agent'] }),
      ticket({ number: 201, parent: 200, labels: ['ready-for-agent'] }),
    ]);
    const epic = results.find((t) => t.trackerRef === 200)!;
    const child = results.find((t) => t.trackerRef === 201)!;
    expect((await tasks.withDeps(epic)).agentWorkable).toBe(false); // Epic → not auto-run despite ready-for-agent
    expect((await tasks.withDeps(child)).agentWorkable).toBe(true); // leaf child still workable
    expect((await tasks.listWithDeps({ workspaceId: wsId })).map((t) => [t.trackerRef, t.agentWorkable])).toEqual(
      expect.arrayContaining([[200, false], [201, true]]),
    );
  });

  it('an unlabelled parent that is momentarily childless is still not agent-workable (issue #229/#230)', async () => {
    // The create-before-children window: an Epic is created, then its members.
    // While childless it is not yet an Epic, so the container rule does not
    // fire. The opt-in rule alone must still keep it human-only — under the old
    // opt-out polarity it defaulted to auto-run (task 226 / run 275).
    const [result] = await mscan([ticket({ number: 229, labels: [] })]);
    expect(result).toMatchObject({ trackerRef: 229 });
    expect((await tasks.withDeps(result!)).agentWorkable).toBe(false);
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

  it('close-blocker → blocker done → dependent unblocks to ready', async () => {
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
    expect(results.map((t) => t.state)).toEqual(['done', 'ready']);
  });

  it('a working Task whose own ticket closes stays working — never mirror-completed (issue #139, ADR-0041)', async () => {
    // Tracker state is an input, never a control path: nothing interrupts a
    // live Run, and the merging's own close is idempotent, so mirrorScan must
    // NOT settle it done.
    const [task] = await mscan([ticket({ number: 8, labels: ['ready-for-agent'] })]);
    await tasks.setState(task!.id, 'working');
    const [after] = await mscan([ticket({ number: 8, state: 'closed', closedAt: '2026-08-07T01:00:00Z' })]);
    expect(after!.state).toBe('working');
  });

  it('done Task on a close-incapable (inbound-only) tracker stays done — no reopen re-run loop (issue #237)', async () => {
    const [task] = await mscan([ticket({ number: 237, labels: ['ready-for-agent'] })]);
    await tasks.setState(task!.id, 'done');

    // The ticket still reads open (an inbound-only adapter never owns the close),
    // so a naive done→ready flip would re-run it, merge, no-op the close,
    // and re-ready forever. Gated on trackerCanClose=false → the flip is suppressed.
    const held = await tasks.upsertMirrored(
      toMirrorInput(ticket({ number: 237, labels: ['ready-for-agent'] }), false),
      wsId,
    );
    expect(held.state).toBe('done');

    // A writable tracker (can close) still treats a still-open ticket as a
    // genuine external reopen and flips the resting done Task back to ready.
    const reopened = await tasks.upsertMirrored(
      toMirrorInput(ticket({ number: 237, labels: ['ready-for-agent'] }), true),
      wsId,
    );
    expect(reopened.state).toBe('ready');
  });

  it('reconcile never interrupts a running Run (nothing cascades)', async () => {
    const [, dependent] = await mscan([
      ticket({ number: 1 }),
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'open' }] }),
    ]);
    await tasks.setState(dependent!.id, 'working'); // Auto-Runner picked it up
    // Blocker closes on the next poll — the working dependent must stay working.
    const results = await mscan([
      ticket({ number: 1, state: 'closed', closedAt: '2026-08-07T01:00:00Z' }),
      ticket({ number: 2, blockedBy: [{ number: 1, title: 'x', state: 'closed' }] }),
    ]);
    expect(results[1]!.state).toBe('working');
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

describe('durable tracker facts (issue #233, ADR-0030 expand)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let wsId: number;
  const rawRow = async (ref: number) => {
    const row = await asyncDb.read((db) =>
      db.select().from(tasksTable).where(eq(tasksTable.trackerRef, ref)).get(),
    );
    if (!row) throw new Error(`missing mirrored task ${ref}`);
    return row;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-facts-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    wsId = (await allWorkspaces(asyncDb)())[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rich = ticket({
    number: 233,
    title: 'Persist tracker facts',
    body: 'the expand half',
    state: 'open',
    parent: 229,
    labels: ['ready-for-agent', 'epic-member'],
    blockedBy: [{ number: 230, title: 'eligibility', state: 'closed' }],
    createdAt: '2026-08-20T09:30:00Z',
    url: 'https://github.com/mintopia/harmonic/issues/233',
  });

  it('upserts the full normalised shape and it round-trips verbatim', async () => {
    await mirrorScan(tasks, [rich], wsId);
    const row = await rawRow(233);
    expect(row.trackerState).toBe('open');
    expect(row.trackerParent).toBe(229);
    expect(row.trackerBlockedBy).toEqual([{ number: 230, title: 'eligibility', state: 'closed' }]);
    expect(row.trackerLabels).toEqual(['ready-for-agent', 'epic-member']);
    expect(row.trackerTitle).toBe('Persist tracker facts');
    expect(row.trackerBody).toBe('the expand half');
    expect(row.trackerUrl).toBe('https://github.com/mintopia/harmonic/issues/233');
    expect(row.trackerCreatedAt).toBe('2026-08-20T09:30:00Z');
  });

  it('refreshes the facts on every re-poll', async () => {
    await mirrorScan(tasks, [rich], wsId);
    await mirrorScan(tasks, [{ ...rich, title: 'Retitled', state: 'closed', labels: ['done'], closedAt: '2026-08-21T00:00:00Z' }], wsId);
    const row = await rawRow(233);
    expect(row.trackerTitle).toBe('Retitled');
    expect(row.trackerState).toBe('closed');
    expect(row.trackerLabels).toEqual(['done']);
  });

  it('last-known-good facts survive a restart with no fresh poll', async () => {
    await mirrorScan(tasks, [rich], wsId);
    await asyncDb.close();
    // Reopen the same on-disk DB — a restart, no poll has run against it.
    asyncDb = await openAsyncDb(dir);
    const row = await rawRow(233);
    expect(row.trackerState).toBe('open');
    expect(row.trackerParent).toBe(229);
    expect(row.trackerBlockedBy).toEqual([{ number: 230, title: 'eligibility', state: 'closed' }]);
    expect(row.trackerTitle).toBe('Persist tracker facts');
    expect(row.trackerCreatedAt).toBe('2026-08-20T09:30:00Z');
  });

  it('an upsert with no facts leaves the last-known-good facts untouched', async () => {
    await mirrorScan(tasks, [rich], wsId);
    const { facts, ...withoutFacts } = toMirrorInput(rich);
    void facts;
    await tasks.upsertMirrored(withoutFacts, wsId); // e.g. a legacy/native caller
    const row = await rawRow(233);
    expect(row.trackerTitle).toBe('Persist tracker facts'); // preserved, not nulled
    expect(row.trackerState).toBe('open');
  });

  it('native Tasks carry null facts (columns are nullable)', async () => {
    const native = await tasks.create({ prompt: 'native' });
    const row = await asyncDb.read((db) => db.select().from(tasksTable).where(eq(tasksTable.id, native.id)).get());
    if (!row) throw new Error(`missing native task ${native.id}`);
    expect(row.trackerState).toBeNull();
    expect(row.trackerBlockedBy).toBeNull();
    expect(row.trackerLabels).toBeNull();
  });

  it('removes a persisted Map container when the tracker no longer classifies it as a Map', async () => {
    const map = ticket({ number: 19, isMap: true, labels: ['wayfinder:map'] });
    await mirrorScan(tasks, [map], wsId);
    expect(await tasks.listTrackerContainers(wsId)).toHaveLength(1);

    await mirrorScan(tasks, [{ ...map, isMap: false, labels: ['ready-for-agent'] }], wsId);
    expect(await tasks.listTrackerContainers(wsId)).toHaveLength(0);
  });
});

describe('deriveMaps (query-time rollup)', () => {
  it('groups mirrored Tasks under their map by mapRef, with per-state counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-maps-'));
    const asyncDb = await openAsyncDb(dir);
    const tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    const wsId = (await allWorkspaces(asyncDb)())[0]!.id;
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
    expect(maps[0]!.counts).toEqual({ ready: 1, done: 1 });
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
