import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trackerRef } from '../src/tracker/adapter.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { TrackerPoller } from '../src/tracker/poller.js';
import type { Ticket, TrackerAdapter } from '../src/tracker/adapter.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';
import { yieldToEventLoop } from '../src/reliability/yield.js';

const providers: NodeTracerProvider[] = [];

function installOperations() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  providers.push(provider);
  return exporter;
}

const ticket = (over: Partial<Ticket>): Ticket => ({
  ref: trackerRef(100),
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
  isMap: false,
  url: 'https://github.com/mintopia/harmonic/issues/100',
  ...over,
});

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
    close: async () => {},
    reopen: async () => {},
  };
  return { adapter, scans: () => scans };
}

function openOnlyAdapter(open: Ticket[], byRef: Record<string, Ticket>) {
  const reads: string[] = [];
  const adapter: TrackerAdapter = {
    name: 'stub',
    scansOpenOnly: true,
    scan: async () => open,
    readTicket: async (r) => {
      reads.push(r.ref);
      return byRef[r.ref]!;
    },
    claim: async () => {},
    release: async () => {},
    close: async () => {},
    reopen: async () => {},
  };
  return { adapter, reads };
}

describe('TrackerPoller.poll', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let wsId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-poller-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    wsId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
  });
  afterEach(async () => {
    trace.disable();
    await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('scans and mirrors 1:1 into its Workspace without scheduling work', async () => {
    const { adapter, scans } = stubAdapter([
      ticket({ ref: trackerRef(42), title: 'Add rate limiting', labels: ['ready-for-agent'] }),
      ticket({ ref: trackerRef(43), isMap: true, labels: ['wayfinder:map'] }),
    ]);
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => adapter);

    await poller.poll();

    expect(scans()).toBe(1);
    expect(await tasks.list()).toHaveLength(1);
    expect((await tasks.list())[0]).toMatchObject({ origin: 'mirrored', trackerRef: '42', state: 'ready', workspaceId: wsId });
  });

  it('settles a mirrored Task whose ticket left the open scan because it was closed', async () => {
    const t42 = ticket({ ref: trackerRef(42), labels: ['ready-for-agent'] });
    const open = [t42];
    const { adapter, reads } = openOnlyAdapter(open, { '42': { ...t42, state: 'closed' } });
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => adapter);
    await poller.poll();
    expect((await tasks.list())[0]).toMatchObject({ trackerRef: '42', state: 'ready' });

    open.length = 0;
    await poller.poll();
    expect((await tasks.list())[0]).toMatchObject({ trackerRef: '42', state: 'done' });
    expect(reads).toEqual(['42']);

    await poller.poll();
    expect(reads).toEqual(['42']);
  });

  it('resolves a closed parent absent from the open scan once, keeping the Epic container', async () => {
    const epic = ticket({ ref: trackerRef(10), title: 'Closed epic', state: 'closed', labels: ['epic'] });
    const child = ticket({ ref: trackerRef(11), parent: trackerRef(10), labels: ['ready-for-agent'] });
    const { adapter, reads } = openOnlyAdapter([child], { '10': epic });
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => adapter);

    await poller.poll();
    await poller.poll();

    expect(reads).toEqual(['10']);
    expect((await tasks.listTrackerContainers(wsId)).map((c) => c.trackerRef)).toEqual(['10']);
    expect((await tasks.list())[0]).toMatchObject({ trackerRef: '11', mapRef: '10' });
    expect(poller.urlFor(trackerRef(10))).toBe(epic.url);
  });

  it('records each poll and its mirror work as linked Operations (issue #288)', async () => {
    const exporter = installOperations();
    const { adapter } = stubAdapter([
      ticket({ ref: trackerRef(42), labels: ['ready-for-agent'] }),
      ticket({ ref: trackerRef(43), labels: ['ready-for-agent'] }),
    ]);
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => adapter);

    await poller.poll();

    const spans = exporter.getFinishedSpans();
    const poll = spans.find((span) => span.name === 'harmonic.poll');
    if (!poll) throw new Error('Expected a tracker poll Operation');
    expect(poll.attributes).toMatchObject({
      'workspace.id': wsId,
      'tracker.name': 'stub',
      'tracker.ticket.count': 2,
      'tracker.mirrored.count': 2,
    });
    const mirrors = spans.filter((span) => span.name === 'harmonic.tracker.mirror.issue');
    expect(mirrors).toHaveLength(2);
    expect(mirrors.map((span) => span.attributes['tracker.ref']).sort()).toEqual(['42', '43']);
    expect(mirrors.every((span) => span.parentSpanContext?.spanId === poll.spanContext().spanId)).toBe(true);
  });

  it('marks a failed poll Operation as ERROR (issue #288)', async () => {
    const exporter = installOperations();
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => {
      throw new Error('tracker declaration is invalid');
    });

    await expect(poller.poll()).rejects.toThrow('tracker declaration is invalid');

    const poll = exporter.getFinishedSpans().find((span) => span.name === 'harmonic.poll');
    expect(poll?.status).toMatchObject({ code: 2, message: 'tracker declaration is invalid' });
  });

  it('single-flights overlapping polls so the timer and a manual pollNow never scan concurrently (issue #219)', async () => {
    let scans = 0;
    let inScan = 0;
    let maxConcurrent = 0;
    let release: (() => void) | undefined;
    const gateFirst = new Promise<void>((r) => (release = r));
    const adapter: TrackerAdapter = {
      name: 'stub',
      scan: async () => {
        scans++;
        inScan++;
        maxConcurrent = Math.max(maxConcurrent, inScan);
        if (scans === 1) await gateFirst;
        inScan--;
        return [ticket({ ref: trackerRef(9), labels: ['ready-for-agent'] })];
      },
      readTicket: async () => ticket({ ref: trackerRef(9) }),
      claim: async () => {},
      release: async () => {},
      close: async () => {},
      reopen: async () => {},
    };
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => adapter);

    const first = poller.poll();
    const second = poller.poll();
    release?.();
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
    expect(scans).toBe(2);
  });

  it('reports its Resolved Tracker each poll — success, then the failure when resolution breaks (issue #83)', async () => {
    const { adapter } = stubAdapter([ticket({ ref: trackerRef(7), labels: ['ready-for-agent'] })]);
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
      (r) => reported.push(r),
    );

    await poller.poll();
    expect(reported.at(-1)).toEqual({ ok: true, name: 'stub', label: 'stub', source: 'detected' });

    broken = true;
    await expect(poller.poll()).rejects.toThrow(/declaration vanished/);
    expect(reported.at(-1)).toMatchObject({ ok: false, code: 'misconfigured' });
  });

  it('is idempotent across polls: re-poll upserts, never duplicates', async () => {
    const { adapter } = stubAdapter([ticket({ ref: trackerRef(7), labels: ['ready-for-agent'] })]);
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => adapter);
    await poller.poll();
    await poller.poll();
    expect(await tasks.list()).toHaveLength(1);
  });

  it('caches presentation lookups for tracker urls and map titles (issue #35)', async () => {
    const { adapter } = stubAdapter([
      ticket({ ref: trackerRef(19), isMap: true, title: 'Wayfinder', labels: ['wayfinder:map'] }),
      ticket({ ref: trackerRef(30), parent: trackerRef(19), labels: ['ready-for-agent'], url: 'https://x/30' }),
      ticket({ ref: trackerRef(31), parent: trackerRef(19), state: 'closed', closedAt: '2026-08-07T01:00:00Z' }),
    ]);
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => adapter);

    await poller.poll();

    expect(poller.urlFor(trackerRef(30))).toBe('https://x/30');
    expect(poller.urlFor(trackerRef(999))).toBeNull();
    expect(poller.urlFor(null)).toBeNull();
    expect(poller.titleForMap(trackerRef(19))).toBe('Wayfinder');
    expect(poller.titleForMap(trackerRef(999))).toBeNull();
    expect(poller.titleForMap(null)).toBeNull();
  });

  async function pollThenReWorking(finalState: 'open' | 'closed') {
    const first = ticket({ ref: trackerRef(42), labels: ['ready-for-agent'] });
    let current = first;
    const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => ({ ...stubAdapter([]).adapter, scan: async () => [current] }));
    await poller.poll();
    const task = (await tasks.list())[0]!;
    await tasks.setState(task.id, 'working');
    current = ticket({ ref: trackerRef(42), labels: ['ready-for-agent'], state: finalState });
    await poller.poll();
    return { taskId: task.id };
  }

  it('a working Task whose ticket closed is left alone — tracker state is never a control path', async () => {
    const { taskId } = await pollThenReWorking('closed');
    expect((await tasks.get(taskId)).state).toBe('working');
  });

  it('a working Task whose ticket is still open is left alone too', async () => {
    const { taskId } = await pollThenReWorking('open');
    expect((await tasks.get(taskId)).state).toBe('working');
  });

  it('a resting Task that closed is settled done by the upsert', async () => {
    const { adapter } = stubAdapter([ticket({ ref: trackerRef(42), labels: ['ready-for-agent'] })]);
    let state: 'open' | 'closed' = 'open';
    const poller = new TrackerPoller(
      tasks,
      wsId,
      dir,
      60_000,
      async () => ({ ...adapter, scan: async () => [ticket({ ref: trackerRef(42), labels: ['ready-for-agent'], state })] }),
    );
    await poller.poll();
    state = 'closed';
    await poller.poll();
    expect((await tasks.list())[0]!.state).toBe('done');
  });

  it('accepts an inbound reopen of a completed Task as tracker truth', async () => {
    let state: 'open' | 'closed' = 'closed';
    const poller = new TrackerPoller(
      tasks,
      wsId,
      dir,
      60_000,
      async () => ({ ...stubAdapter([]).adapter, scan: async () => [ticket({ ref: trackerRef(42), labels: ['ready-for-agent'], state })] }),
    );

    await poller.poll();
    expect((await tasks.list())[0]!.state).toBe('done');

    state = 'open';
    await poller.poll();
    expect((await tasks.list())[0]!.state).toBe('ready');
  });

  it('keeps an inbound-reopened Task ineligible when ready-for-agent was removed', async () => {
    let state: 'open' | 'closed' = 'closed';
    let labels = ['ready-for-agent'];
    const poller = new TrackerPoller(
      tasks,
      wsId,
      dir,
      60_000,
      async () => ({ ...stubAdapter([]).adapter, scan: async () => [ticket({ ref: trackerRef(42), labels, state })] }),
    );

    await poller.poll();
    state = 'open';
    labels = [];
    await poller.poll();

    expect((await tasks.list())[0]).toMatchObject({ state: 'ready' });
  });

  it('runs epic integration after mirroring without scheduling work (issue #159)', async () => {
    const exporter = installOperations();
    const { adapter } = stubAdapter([ticket({ ref: trackerRef(42), labels: ['ready-for-agent'], assignees: ['someone'] })]);
    const calls: Array<{ tickets: string[]; mirrored: Array<string | null> }> = [];
    let persistedAssignees: string[] | undefined;
    const epics = {
      reconcile: async (tickets: Ticket[], mirrored: { trackerRef: string | null }[]) => {
        persistedAssignees = tickets[0]?.assignees;
        calls.push({
          tickets: tickets.map((t) => t.ref),
          mirrored: mirrored.map((m) => m.trackerRef),
        });
      },
    };
    const poller = new TrackerPoller(
      tasks,
      wsId,
      dir,
      60_000,
      async () => adapter,
      undefined,
      undefined,
      undefined,
      epics,
    );

    await poller.poll();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tickets).toContain('42');
    expect(calls[0]!.mirrored).toContain('42');
    expect(persistedAssignees).toEqual([]);
    const spans = exporter.getFinishedSpans();
    const poll = spans.find((span) => span.name === 'harmonic.poll');
    const reconcile = spans.find((span) => span.name === 'harmonic.epic.reconcile');
    expect(reconcile?.parentSpanContext?.spanId).toBe(poll?.spanContext().spanId);
  });

  it('swallows an epic integration failure, logs it, and never wedges the poll (issue #159)', async () => {
    const exporter = installOperations();
    const { adapter } = stubAdapter([ticket({ ref: trackerRef(42), labels: ['ready-for-agent'] })]);
    const errors: string[] = [];
    const epics = {
      reconcile: async () => {
        throw new Error('git boom');
      },
    };
    const poller = new TrackerPoller(
      tasks,
      wsId,
      dir,
      60_000,
      async () => adapter,
      (m) => errors.push(m),
      undefined,
      undefined,
      epics,
    );

    await expect(poller.poll()).resolves.toBeUndefined();

    expect(await tasks.list()).toHaveLength(1);
    expect(errors.some((e) => e.includes('epic integration'))).toBe(true);
    const spans = exporter.getFinishedSpans();
    const poll = spans.find((span) => span.name === 'harmonic.poll');
    const reconcile = spans.find((span) => span.name === 'harmonic.epic.reconcile');
    expect(poll?.status).toMatchObject({ code: 0 });
    expect(reconcile?.status).toMatchObject({ code: 2, message: 'git boom' });
  });

  it('yields while re-mirroring a large backlog of working tickets that closed', async () => {
    let current = Array.from({ length: 30 }, (_, index) => ticket({ ref: trackerRef(index + 1), labels: ['ready-for-agent'] }));
    let tick = 0;
    let yields = 0;
    const order: string[] = [];
    const poller = new TrackerPoller(
      tasks,
      wsId,
      dir,
      60_000,
      async () => ({ ...stubAdapter([]).adapter, scan: async () => current }),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        yieldOptions: {
          budgetMs: 0,
          now: () => tick++,
          yieldNow: async () => {
            yields++;
            await yieldToEventLoop();
          },
        },
      },
    );

    await poller.poll();
    for (const task of await tasks.list()) await tasks.setState(task.id, 'working');
    current = current.map((row) => ({ ...row, state: 'closed' }));
    const done = poller.poll().then(() => order.push('done'));
    setImmediate(() => order.push('immediate'));
    await done;
    await yieldToEventLoop();

    expect(yields).toBeGreaterThan(0);
    expect(order.indexOf('immediate')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('immediate')).toBeLessThan(order.indexOf('done'));
    expect((await tasks.list()).every((task) => task.state === 'working')).toBe(true);
  });
});
