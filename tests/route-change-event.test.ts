import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { Runner } from '../src/execution/runner.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import { trackerRef, type Ticket } from '../src/tracker/adapter.js';
import { executionPlumbing, allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

const ticket = (labels: string[]): Ticket => ({
  ref: trackerRef(1),
  title: 'Ticket 1',
  state: 'open',
  body: '',
  createdAt: '2026-08-07T00:00:00Z',
  closedAt: null,
  labels,
  assignees: [],
  parent: null,
  blockedBy: [],
  blocking: [],
  isMap: false,
  url: 'https://github.com/mintopia/harmonic/issues/1',
});

describe('route-changed Activity event (ADR-0049)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let config: AppConfig;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let runner: Runner;
  let wsId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-route-change-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    const settingsStore = await makeSettingsStore(dir);
    config = {
      ...baselineConfig(),
      routingLabels: [
        { label: 'cheap', harness: 'claude', model: 'claude-haiku-4-5-20251001' },
        { label: 'reasoning', harness: 'claude', model: 'claude-opus-5-5' },
        { label: 'other', harness: 'codex', model: '' },
      ],
    };
    tasks = new TaskService(asyncDb, () => config, allWorkspaces(asyncDb, settingsStore));
    attempts = new AttemptStore(asyncDb);
    runner = new Runner(tasks, asyncDb, () => config, executionPlumbing());
    wsId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
  });
  afterEach(async () => {
    await runner.shutdown();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const record = (task: Awaited<ReturnType<TaskService['get']>>, bound: Awaited<ReturnType<AttemptStore['create']>>) =>
    (runner as unknown as { recordRouteChange: (t: typeof task, b: typeof bound) => Promise<void> }).recordRouteChange(task, bound);

  async function retryAfterRelabel(from: string, to: string) {
    const mirrored = (await mirrorScan(tasks, [ticket(['ready-for-agent', from])], wsId))[0]!;
    const first = (await tasks.claimReady(mirrored.id))!;
    const prior = await attempts.create(mirrored.id, undefined, { harness: first.harness, model: first.model });
    await attempts.update(prior.id, { state: 'failed', endedAt: Date.now() });
    await tasks.setState(mirrored.id, 'ready');
    await mirrorScan(tasks, [ticket(['ready-for-agent', to])], wsId);
    const next = (await tasks.claimReady(mirrored.id))!;
    const bound = await attempts.create(mirrored.id, undefined, { harness: next.harness, model: next.model });
    return { next, bound };
  }

  const events = async (attemptId: number) =>
    (await attempts.listEvents(attemptId)).map((e) => JSON.parse(typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)));

  it('escalated cheap Ticket relabelled reasoning retries on the reasoning route, recorded as a Model-only change', async () => {
    const { next, bound } = await retryAfterRelabel('cheap', 'reasoning');
    expect(bound).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });
    await record(next, bound);
    expect(await events(bound.id)).toEqual([
      {
        event: 'route-changed',
        from: { harness: 'claude', model: 'claude-haiku-4-5-20251001' },
        to: { harness: 'claude', model: 'claude-opus-5-5' },
        label: 'reasoning',
        sessionKept: false,
      },
    ]);
  });

  it('records sessionKept when the new Attempt is bound to a prior Session', async () => {
    const { next, bound } = await retryAfterRelabel('cheap', 'reasoning');
    await record(next, { ...bound, sessionRowId: 7 });
    expect((await events(bound.id))[0]).toMatchObject({ event: 'route-changed', sessionKept: true });
  });

  it('records a Harness change', async () => {
    const { next, bound } = await retryAfterRelabel('cheap', 'other');
    await record(next, bound);
    expect((await events(bound.id))[0]).toMatchObject({ to: { harness: 'codex' }, label: 'other', sessionKept: false });
  });

  it('records nothing when the route is unchanged', async () => {
    const { next, bound } = await retryAfterRelabel('cheap', 'cheap');
    await record(next, bound);
    expect(await events(bound.id)).toEqual([]);
  });
});
