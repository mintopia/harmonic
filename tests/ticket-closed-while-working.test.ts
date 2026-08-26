import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import { TrackerPoller } from '../src/tracker/poller.js';
import type { Ticket, TrackerAdapter } from '../src/tracker/adapter.js';
import { allWorkspaces } from './helpers.js';

// Tracker state is an input, never a control path (ADR-0041): a mirrored
// ticket closed in the tracker while its Task is `working` changes nothing
// locally — no reopen, no escalation, no premature "done". Harmonic's own
// landing closes the ticket idempotently when the Run gets there; a human
// closing it early is simply mirrored once the Task rests.

const mirrored = (ref: number, over: Partial<MirrorInput> = {}): MirrorInput => ({
  trackerRef: ref,
  prompt: `ticket ${ref}\n\nbody`,
  workflow: 'implement',
  wayfinderType: null,
  mapRef: null,
  closed: false,
  ...over,
});

const ticket = (over: Partial<Ticket>): Ticket => ({
  number: 7,
  title: 'A ticket',
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
  url: 'https://x/7',
  ...over,
});

/** A tracker adapter that records every write; `reopen` is never called by Harmonic any more. */
function writeSpy(tickets: () => Ticket[]) {
  const calls = { reopen: [] as number[], close: [] as number[], claim: [] as number[], release: [] as number[] };
  const adapter: TrackerAdapter = {
    name: 'fake',
    scan: async () => tickets(),
    readTicket: async (ref) => tickets().find((t) => t.number === ref.number) ?? ticket({ number: ref.number }),
    claim: async (t) => {
      calls.claim.push(t.number);
    },
    release: async (t) => {
      calls.release.push(t.number);
    },
    close: async (t) => {
      calls.close.push(t.number);
    },
    reopen: async (t) => {
      calls.reopen.push(t.number);
    },
  };
  return { adapter, calls };
}

describe('a mirrored ticket closed while its Task is working', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runs: RunStore;
  let wsId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-closed-working-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    runs = new RunStore(asyncDb);
    wsId = (await allWorkspaces(asyncDb)())[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the poll leaves the working Task alone and writes nothing back to the tracker', async () => {
    let current = [ticket({ number: 7 })];
    const { adapter, calls } = writeSpy(() => current);
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => adapter);
    await poller.poll();
    const task = (await tasks.list())[0]!;
    await tasks.setState(task.id, 'working');
    await runs.create(task.id);

    current = [ticket({ number: 7, state: 'closed', closedAt: '2026-08-07T01:00:00Z' })];
    await poller.poll();

    expect((await tasks.get(task.id)).state).toBe('working');
    expect(calls.reopen).toEqual([]);
    expect(calls.close).toEqual([]);
    expect(calls.release).toEqual([]);
  });

  it('does not complete, so a premature close leaves dependents not agent-workable', async () => {
    const blocker = await tasks.upsertMirrored(mirrored(1));
    const dependent = await tasks.create({ prompt: 'dependent', state: 'ready' });
    await tasks.addDependency(dependent.id, blocker.id);
    expect((await tasks.withDeps(await tasks.get(dependent.id))).openBlockerCount).toBe(1);
    expect((await tasks.withDeps(await tasks.get(dependent.id))).agentWorkable).toBe(false);
    await tasks.setState(blocker.id, 'working');

    await mirrorScan(tasks, [ticket({ number: 1, state: 'closed', closedAt: '2026-08-07T01:00:00Z' })], wsId);

    // Still working, still blocking: only the Run's verdict and landing finish it.
    expect((await tasks.get(blocker.id)).state).toBe('working');
    expect((await tasks.withDeps(await tasks.get(dependent.id))).openBlockerCount).toBe(1);
    expect((await tasks.withDeps(await tasks.get(dependent.id))).agentWorkable).toBe(false);
  });

  it('a resting Task whose ticket closed is mirrored done, and its dependents unblock', async () => {
    const blocker = await tasks.upsertMirrored(mirrored(1));
    const dependent = await tasks.create({ prompt: 'dependent', state: 'ready' });
    await tasks.addDependency(dependent.id, blocker.id);

    await mirrorScan(tasks, [ticket({ number: 1, state: 'closed', closedAt: '2026-08-07T01:00:00Z' })], wsId);

    expect((await tasks.get(blocker.id)).state).toBe('done');
    expect((await tasks.withDeps(await tasks.get(dependent.id))).openBlockerCount).toBe(0);
    expect((await tasks.withDeps(await tasks.get(dependent.id))).agentWorkable).toBe(true);
  });

  it('an escalated Task whose ticket closed stays escalated — the human decision is Harmonic\'s own fact', async () => {
    const task = await tasks.upsertMirrored(mirrored(9));
    await tasks.escalate(task.id, 'escalated to human: attempt 2 of 2 failed');

    await mirrorScan(tasks, [ticket({ number: 9, state: 'closed', closedAt: '2026-08-07T01:00:00Z' })], wsId);

    expect(await tasks.get(task.id)).toMatchObject({ state: 'escalated', escalationReason: 'escalated to human: attempt 2 of 2 failed' });
  });
});
