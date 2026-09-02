import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { MirrorCoordinator } from '../src/tracker/coordinator.js';
import type { Ticket, TrackerAdapter } from '../src/tracker/adapter.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

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
    close: async () => {},
    reopen: async () => {},
  };
  return { adapter, calls, setRead: (t: Ticket) => (readResult = t) };
}

describe('MirrorCoordinator (issue #32)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let wsId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-coord-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    wsId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('advertiseClaim: writes the claim without reading ticket assignment or identity', async () => {
    const task = await tasks.upsertMirrored(mirrored(7));

    const grabbed = fakeAdapter();
    grabbed.setRead(ticket(7, ['human']));
    const coordA = new MirrorCoordinator(tasks, wsId);
    await coordA.observe(grabbed.adapter);
    await expect(coordA.advertiseClaim(await tasks.get(task.id))).resolves.toBeUndefined();
    expect(grabbed.calls.claim).toEqual([7]);
    expect(grabbed.calls.read).toEqual([]);

    const open = fakeAdapter();
    open.setRead(ticket(7, []));
    const coordB = new MirrorCoordinator(tasks, wsId);
    await coordB.observe(open.adapter);
    await expect(coordB.advertiseClaim(await tasks.get(task.id))).resolves.toBeUndefined();
    expect(open.calls.claim).toEqual([7]);

    const failing = fakeAdapter({ claimThrows: true });
    failing.setRead(ticket(7, []));
    const coordC = new MirrorCoordinator(tasks, wsId);
    await coordC.observe(failing.adapter);
    await expect(coordC.advertiseClaim(await tasks.get(task.id))).resolves.toBeUndefined();
  });

  it('reconcile: derives advisory writes from local Task state only', async () => {
    const running = await tasks.upsertMirrored(mirrored(10));
    await tasks.setState(running.id, 'working');
    const escalated = await tasks.upsertMirrored(mirrored(11));
    await tasks.escalate(escalated.id, 'escalated to human: attempt 2 of 2 failed');
    const retrying = await tasks.upsertMirrored(mirrored(14));
    await tasks.setState(retrying.id, 'working');
    await tasks.upsertMirrored(mirrored(12));
    await tasks.upsertMirrored(mirrored(13, { closed: true }));

    const { adapter, calls } = fakeAdapter();
    const coord = new MirrorCoordinator(tasks, wsId);
    await coord.observe(adapter);
    await coord.reconcile();

    expect(calls.claim).toEqual([10, 14]);
    expect(calls.release).toEqual([11]);
    expect(calls.read).toEqual([]);
    expect(calls.release).not.toContain(14);
    expect(calls.claim).not.toContain(12);
    expect(calls.release).not.toContain(12);
    expect(calls.release).not.toContain(13);
  });

  it('reconcile: idempotency guard skips redundant claim/release when state is unchanged, re-writes on change (issue #232)', async () => {
    const running = await tasks.upsertMirrored(mirrored(20));
    await tasks.setState(running.id, 'working');
    const escalated = await tasks.upsertMirrored(mirrored(21));
    await tasks.escalate(escalated.id, 'escalated to human: attempt 2 of 2 failed');

    const { adapter, calls } = fakeAdapter();
    const coord = new MirrorCoordinator(tasks, wsId);
    await coord.observe(adapter);

    await coord.reconcile();
    expect(calls.claim).toEqual([20]);
    expect(calls.release).toEqual([21]);

    await coord.reconcile();
    expect(calls.claim).toEqual([20]);
    expect(calls.release).toEqual([21]);

    await tasks.escalate(running.id, 'escalated to human: attempt 2 of 2 failed');
    await coord.reconcile();
    expect(calls.claim).toEqual([20]);
    expect(calls.release).toEqual([21, 20]);

    await coord.reconcile();
    expect(calls.release).toEqual([21, 20]);
  });
});
