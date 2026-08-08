import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { MirrorCoordinator } from '../src/tracker/coordinator.js';
import type { Ticket, TrackerAdapter } from '../src/tracker/adapter.js';
import { allWorkspaces } from './helpers.js';

const ticket = (number: number, assignees: string[] = []): Ticket => ({
  number,
  title: `ticket ${number}`,
  state: 'open',
  body: '',
  createdAt: '2026-08-07T00:00:00Z',
  closedAt: null,
  labels: [],
  assignees,
  parent: null,
  blockedBy: [],
  blocking: [],
  comments: [],
  isMap: false,
  url: `https://x/${number}`,
});

const mirrored = (ref: number, over: Partial<MirrorInput> = {}): MirrorInput => ({
  trackerRef: ref,
  prompt: `ticket ${ref}`,
  workflow: 'implement',
  wayfinderType: null,
  drive: 'afk',
  mapRef: null,
  closed: false,
  ...over,
});

function fakeAdapter(opts: { claimThrows?: boolean } = {}) {
  const calls = { claim: [] as number[], release: [] as number[], read: [] as number[] };
  let readResult: Ticket = ticket(0);
  const adapter: TrackerAdapter = {
    name: 'fake',
    scan: async () => [],
    readTicket: async (ref) => {
      calls.read.push(ref.number);
      return readResult;
    },
    claim: async (t) => {
      calls.claim.push(t.number);
      if (opts.claimThrows) throw new Error('claim failed');
    },
    release: async (t) => {
      calls.release.push(t.number);
    },
    whoami: async () => 'me',
    close: async () => {},
  };
  return { adapter, calls, setRead: (t: Ticket) => (readResult = t) };
}

describe('MirrorCoordinator (issue #32)', () => {
  let dir: string;
  let db: Db;
  let tasks: TaskService;
  let wsId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-coord-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    wsId = allWorkspaces(db)()[0]!.id;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('foreignAssignee: true only for a mirrored Task an assignee Harmonic did not place', async () => {
    const foreign = tasks.upsertMirrored(mirrored(1));
    const ours = tasks.upsertMirrored(mirrored(2));
    const unassigned = tasks.upsertMirrored(mirrored(3));
    const native = tasks.create({ prompt: 'n', state: 'ready' });

    const { adapter } = fakeAdapter();
    const coord = new MirrorCoordinator(tasks, wsId);
    await coord.observe(adapter, [ticket(1, ['human']), ticket(2, ['me']), ticket(3, [])]);

    expect(coord.foreignAssignee(tasks.get(foreign.id))).toBe(true);
    expect(coord.foreignAssignee(tasks.get(ours.id))).toBe(false);
    expect(coord.foreignAssignee(tasks.get(unassigned.id))).toBe(false);
    expect(coord.foreignAssignee(tasks.get(native.id))).toBe(false);
  });

  it('recheckAndClaim: yields to a fresh foreign grab, otherwise claims — and proceeds through a failed claim', async () => {
    const task = tasks.upsertMirrored(mirrored(7));

    const grabbed = fakeAdapter();
    grabbed.setRead(ticket(7, ['human']));
    const coordA = new MirrorCoordinator(tasks, wsId);
    await coordA.observe(grabbed.adapter, [ticket(7, [])]);
    expect(await coordA.recheckAndClaim(tasks.get(task.id))).toBe('yield');
    expect(grabbed.calls.claim).toEqual([]);

    const open = fakeAdapter();
    open.setRead(ticket(7, []));
    const coordB = new MirrorCoordinator(tasks, wsId);
    await coordB.observe(open.adapter, [ticket(7, [])]);
    expect(await coordB.recheckAndClaim(tasks.get(task.id))).toBe('spawn');
    expect(open.calls.claim).toEqual([7]);

    const failing = fakeAdapter({ claimThrows: true });
    failing.setRead(ticket(7, []));
    const coordC = new MirrorCoordinator(tasks, wsId);
    await coordC.observe(failing.adapter, [ticket(7, [])]);
    expect(await coordC.recheckAndClaim(tasks.get(task.id))).toBe('spawn'); // best-effort: spawn anyway
  });

  it('reconcile: re-claims a running Task, releases an escalated one, leaves failed/foreign/completed alone', async () => {
    const running = tasks.upsertMirrored(mirrored(10));
    tasks.setState(running.id, 'running'); // claimed, but the scan shows it dropped
    const escalated = tasks.upsertMirrored(mirrored(11));
    tasks.escalate(escalated.id); // handed back to a human (retries exhausted / prompt), still ours
    const retrying = tasks.upsertMirrored(mirrored(14));
    tasks.setState(retrying.id, 'failed'); // mid Auto-Retry: bare failed is no longer a hand-back (issue #33)
    tasks.upsertMirrored(mirrored(12)); // a person owns it — hands off
    tasks.upsertMirrored(mirrored(13, { closed: true })); // completed → close path (D5), not us

    const { adapter, calls } = fakeAdapter();
    const coord = new MirrorCoordinator(tasks, wsId);
    await coord.observe(adapter, [
      ticket(10, []), // running but unassigned → re-claim
      ticket(11, ['me']), // escalated but still ours → release
      ticket(14, ['me']), // failed (retrying) but still ours → hold the claim
      ticket(12, ['human']), // foreign → untouched
      ticket(13, ['me']), // completed → untouched
    ]);
    await coord.reconcile();

    expect(calls.claim).toEqual([10]);
    expect(calls.release).toEqual([11]);
    expect(calls.release).not.toContain(14);
    expect(calls.claim).not.toContain(12);
    expect(calls.release).not.toContain(12);
    expect(calls.release).not.toContain(13);
  });
});
