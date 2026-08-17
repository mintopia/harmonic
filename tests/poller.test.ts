import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { TrackerPoller } from '../src/tracker/poller.js';
import type { Ticket, TrackerAdapter } from '../src/tracker/adapter.js';
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

/** A stub adapter that records scan() calls and returns canned tickets. */
function stubAdapter(tickets: Ticket[]) {
  let scans = 0;
  const adapter: TrackerAdapter = {
    name: 'stub',
    scan: async () => {
      scans++;
      return tickets;
    },
    readTicket: async () => tickets[0]!,
    claim: async () => {},
    release: async () => {},
    whoami: async () => 'harmonic-bot',
    close: async () => {},
    reopen: async () => {},
  };
  return { adapter, scans: () => scans };
}

describe('TrackerPoller.poll', () => {
  let dir: string;
  let db: Db;
  let tasks: TaskService;
  let wsId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-poller-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    wsId = allWorkspaces(db)()[0]!.id;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('scans, mirrors 1:1 into its Workspace, and pokes downstream', async () => {
    const { adapter, scans } = stubAdapter([
      ticket({ number: 42, title: 'Add rate limiting', labels: ['ready-for-agent'] }),
      ticket({ number: 43, isMap: true, labels: ['wayfinder:map'] }), // not mirrored
    ]);
    let pokes = 0;
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => adapter, () => pokes++);

    await poller.poll();

    expect(scans()).toBe(1);
    expect(tasks.list()).toHaveLength(1); // map skipped
    expect(tasks.list()[0]).toMatchObject({ origin: 'mirrored', trackerRef: 42, state: 'ready', workspaceId: wsId });
    expect(pokes).toBe(1);
  });

  it('reports its Resolved Tracker each poll — success, then the failure when resolution breaks (issue #83)', async () => {
    const { adapter } = stubAdapter([ticket({ number: 7, labels: ['ready-for-agent'] })]);
    let broken = false;
    const reported: Array<{ ok: boolean }> = [];
    const poller = new TrackerPoller(
      tasks,
      wsId,
      dir,
      60_000,
      async () => {
        if (broken) throw new Error('declaration vanished');
        return adapter;
      },
      undefined,
      undefined,
      undefined,
      (r) => reported.push(r),
    );

    await poller.poll();
    expect(reported.at(-1)).toEqual({ ok: true, name: 'stub', label: 'stub' });

    broken = true;
    await expect(poller.poll()).rejects.toThrow(/declaration vanished/); // scan never reached
    expect(reported.at(-1)).toMatchObject({ ok: false, code: 'misconfigured' });
  });

  it('is idempotent across polls: re-poll upserts, never duplicates', async () => {
    const { adapter } = stubAdapter([ticket({ number: 7, labels: ['ready-for-agent'] })]);
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => adapter);
    await poller.poll();
    await poller.poll();
    expect(tasks.list()).toHaveLength(1);
  });

  it('caches the scan: maps() rolls up by mapRef and urlFor() resolves a ref (issue #35)', async () => {
    const { adapter } = stubAdapter([
      ticket({ number: 19, isMap: true, title: 'Wayfinder', labels: ['wayfinder:map'] }),
      ticket({ number: 30, parent: 19, labels: ['ready-for-agent'], url: 'https://x/30' }),
      ticket({ number: 31, parent: 19, state: 'closed', closedAt: '2026-08-07T01:00:00Z' }),
    ]);
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => adapter);

    expect(poller.maps()).toEqual([]); // empty before the first poll
    await poller.poll();

    const maps = poller.maps();
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({ ref: 19, title: 'Wayfinder' });
    expect(maps[0]!.taskRefs.sort()).toEqual([30, 31]);
    expect(maps[0]!.counts).toEqual({ ready: 1, completed: 1 });
    expect(poller.urlFor(30)).toBe('https://x/30');
    expect(poller.urlFor(999)).toBeNull(); // unknown ref
    expect(poller.urlFor(null)).toBeNull(); // native Task
    expect(poller.titleForMap(19)).toBe('Wayfinder'); // mapRef → Map title (issue #34)
    expect(poller.titleForMap(999)).toBeNull(); // unknown ref
    expect(poller.titleForMap(null)).toBeNull(); // unmapped Task
  });

  /** Poll #42, flip it running, then re-poll it with a new state — the board-refresh path. */
  async function pollThenReRunning(finalState: 'open' | 'closed') {
    const first = ticket({ number: 42, labels: ['ready-for-agent'] });
    let current = first;
    const closed: number[] = [];
    const poller = new TrackerPoller(
      tasks,
      wsId,
      dir,
      60_000,
      async () => ({ ...stubAdapter([]).adapter, scan: async () => [current] }),
      undefined,
      undefined,
      undefined,
      undefined,
      (id) => closed.push(id),
    );
    await poller.poll();
    const task = tasks.list()[0]!;
    tasks.setState(task.id, 'running'); // a live Run flipped it (Runner.start / launchClaimed)
    current = ticket({ number: 42, labels: ['ready-for-agent'], state: finalState });
    await poller.poll();
    return { closed, taskId: task.id };
  }

  it('reports a running Task whose ticket closed, so the Runner stops the parked agent', async () => {
    const { closed, taskId } = await pollThenReRunning('closed');
    expect(closed).toEqual([taskId]);
    // The poll itself never moves a Task off running — the Runner callback does.
    expect(tasks.get(taskId).state).toBe('running');
  });

  it('does not report a running Task whose ticket is still open', async () => {
    const { closed } = await pollThenReRunning('open');
    expect(closed).toEqual([]);
  });

  it('does not report a resting Task that closed — upsert completes it directly', async () => {
    const { adapter } = stubAdapter([ticket({ number: 42, labels: ['ready-for-agent'] })]);
    let state: 'open' | 'closed' = 'open';
    const closed: number[] = [];
    const poller = new TrackerPoller(
      tasks,
      wsId,
      dir,
      60_000,
      async () => ({ ...adapter, scan: async () => [ticket({ number: 42, labels: ['ready-for-agent'], state })] }),
      undefined,
      undefined,
      undefined,
      undefined,
      (id) => closed.push(id),
    );
    await poller.poll(); // ready
    state = 'closed';
    await poller.poll(); // resting → completed via upsert, not the backstop
    expect(closed).toEqual([]);
    expect(tasks.list()[0]!.state).toBe('completed');
  });
});
