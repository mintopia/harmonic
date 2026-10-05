import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trackerRef } from '../src/tracker/adapter.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { MirrorCoordinator } from '../src/tracker/coordinator.js';
import type { Ticket, TrackerAdapter } from '../src/tracker/adapter.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

const ticket = (number: number, assignees: string[] = []): Ticket => ({
  ref: trackerRef(number),
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
  trackerRef: trackerRef(ref),
  prompt: `ticket ${ref}`,
  workflow: 'implement',
  wayfinderType: null,
  mapRef: null,
  closed: false,
  ...over,
});

function fakeAdapter(opts: { claimThrows?: boolean } = {}) {
  const calls = { claim: [] as string[], release: [] as string[], read: [] as string[] };
  let readResult: Ticket = ticket(0);
  const adapter: TrackerAdapter = {
    name: 'fake',
    scan: async () => [],
    readTicket: async (ref) => {
      calls.read.push(ref.ref);
      return readResult;
    },
    claim: async (t) => {
      calls.claim.push(t.ref);
      if (opts.claimThrows) throw new Error('claim failed');
    },
    release: async (t) => {
      calls.release.push(t.ref);
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
    await seedWorkspace(asyncDb);
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
    expect(grabbed.calls.claim).toEqual(['7']);
    expect(grabbed.calls.read).toEqual([]);

    const open = fakeAdapter();
    open.setRead(ticket(7, []));
    const coordB = new MirrorCoordinator(tasks, wsId);
    await coordB.observe(open.adapter);
    await expect(coordB.advertiseClaim(await tasks.get(task.id))).resolves.toBeUndefined();
    expect(open.calls.claim).toEqual(['7']);

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

    expect(calls.claim).toEqual(['10', '14']);
    expect(calls.release).toEqual(['11']);
    expect(calls.read).toEqual([]);
    expect(calls.release).not.toContain('14');
    expect(calls.claim).not.toContain('12');
    expect(calls.release).not.toContain('12');
    expect(calls.release).not.toContain('13');
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
    expect(calls.claim).toEqual(['20']);
    expect(calls.release).toEqual(['21']);

    await coord.reconcile();
    expect(calls.claim).toEqual(['20']);
    expect(calls.release).toEqual(['21']);

    await tasks.escalate(running.id, 'escalated to human: attempt 2 of 2 failed');
    await coord.reconcile();
    expect(calls.claim).toEqual(['20']);
    expect(calls.release).toEqual(['21', '20']);

    await coord.reconcile();
    expect(calls.release).toEqual(['21', '20']);
  });

  it('reconcile: retries a pending ticket close each poll, clearing the flag on success or ticket-gone', async () => {
    const ok = await tasks.upsertMirrored(mirrored(11));
    const gone = await tasks.upsertMirrored(mirrored(12));
    const flaky = await tasks.upsertMirrored(mirrored(13));
    const notPending = await tasks.upsertMirrored(mirrored(14));
    for (const t of [ok, gone, flaky, notPending]) {
      await tasks.setState(t.id, 'working');
      await tasks.setState(t.id, 'done');
    }
    for (const t of [ok, gone, flaky]) await tasks.setTicketClosePending(t.id, true);

    const attempts: string[] = [];
    const closer = async (task: { trackerRef: string | null }) => {
      attempts.push(String(task.trackerRef));
      if (task.trackerRef === trackerRef(12)) return { ok: false as const, error: new Error('gh: 404 Not Found') };
      if (task.trackerRef === trackerRef(13)) return { ok: false as const, error: new Error('API rate limit exceeded') };
      return { ok: true as const };
    };
    const coord = new MirrorCoordinator(tasks, wsId, closer);
    await coord.observe(fakeAdapter().adapter);
    await coord.reconcile();

    expect(attempts.sort()).toEqual([trackerRef(11), trackerRef(12), trackerRef(13)].map(String).sort());
    expect((await tasks.get(ok.id)).ticketClosePending).toBe(false);
    expect((await tasks.get(gone.id)).ticketClosePending).toBe(false);
    expect((await tasks.get(flaky.id)).ticketClosePending).toBe(true);

    attempts.length = 0;
    await coord.reconcile();
    expect(attempts).toEqual([trackerRef(13)]);
  });
});
