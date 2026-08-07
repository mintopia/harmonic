import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig, type AppConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { TrackerPoller } from '../src/tracker/poller.js';
import type { Ticket, TrackerAdapter } from '../src/tracker/adapter.js';

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
    close: async () => {},
  };
  return { adapter, scans: () => scans };
}

describe('TrackerPoller.poll', () => {
  let dir: string;
  let db: Db;
  let tasks: TaskService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-poller-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const configWith = (over: Partial<AppConfig['tracker']>): AppConfig => ({
    ...defaultConfig(),
    tracker: { ...defaultConfig().tracker, ...over },
  });

  it('scans, mirrors 1:1, and pokes downstream when enabled', async () => {
    const { adapter, scans } = stubAdapter([
      ticket({ number: 42, title: 'Add rate limiting', labels: ['ready-for-agent'] }),
      ticket({ number: 43, isMap: true, labels: ['wayfinder:map'] }), // not mirrored
    ]);
    let pokes = 0;
    const poller = new TrackerPoller(tasks, () => configWith({ enabled: true }), async () => adapter, () => pokes++);

    await poller.poll();

    expect(scans()).toBe(1);
    expect(tasks.list()).toHaveLength(1); // map skipped
    expect(tasks.list()[0]).toMatchObject({ origin: 'mirrored', trackerRef: 42, state: 'ready' });
    expect(pokes).toBe(1);
  });

  it('is idempotent across polls: re-poll upserts, never duplicates', async () => {
    const { adapter } = stubAdapter([ticket({ number: 7, labels: ['ready-for-agent'] })]);
    const poller = new TrackerPoller(tasks, () => configWith({ enabled: true }), async () => adapter);
    await poller.poll();
    await poller.poll();
    expect(tasks.list()).toHaveLength(1);
  });

  it('no-ops when disabled — never resolves the adapter (safe by default)', async () => {
    let resolved = false;
    const poller = new TrackerPoller(
      tasks,
      () => configWith({ enabled: false }),
      async () => {
        resolved = true;
        throw new Error('should not resolve when disabled');
      },
    );
    await poller.poll();
    expect(resolved).toBe(false);
    expect(tasks.list()).toHaveLength(0);
  });
});
