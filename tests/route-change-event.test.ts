import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { Runner } from '../src/execution/runner.js';
import { SessionStore } from '../src/domain/sessions.js';
import { adapterVersion } from '../src/execution/harness/registry.js';
import type { TaskRow } from '../src/db/schema.js';
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
    (runner as unknown as { turnDriver: { drive: () => Promise<void> } }).turnDriver.drive = async () => {};
    wsId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
  });
  afterEach(async () => {
    await runner.shutdown();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const internals = () =>
    runner as unknown as { workspaceProvisioner: { dispatchCwd: (task: TaskRow) => string } };

  async function seedSession(attemptId: number, task: TaskRow) {
    const session = await new SessionStore(asyncDb).recordDispatch({
      harness: task.harness,
      harnessSessionId: `session-${attemptId}`,
      model: task.model,
      cwd: internals().workspaceProvisioner.dispatchCwd(task),
      workspaceId: task.workspaceId,
      mcpTemplates: [],
      capabilities: { agentCapabilities: { loadSession: true } } as never,
      adapterVersion: adapterVersion(task.harness),
      now: Date.now(),
    });
    await attempts.update(attemptId, { sessionRowId: session.id, sessionId: session.harnessSessionId });
  }

  async function retryAfterRelabel(from: string, to: string, withSession = false) {
    const mirrored = (await mirrorScan(tasks, [ticket(['ready-for-agent', from])], wsId))[0]!;
    const first = (await tasks.claimReady(mirrored.id))!;
    const prior = await attempts.create(mirrored.id, { route: { harness: first.harness, model: first.model } });
    if (withSession) await seedSession(prior.id, first);
    await attempts.update(prior.id, { state: 'failed', endedAt: Date.now() });
    const placeholder = await attempts.create(mirrored.id);
    await attempts.update(placeholder.id, { state: 'failed', endedAt: Date.now() });
    await tasks.setState(mirrored.id, 'ready');
    await mirrorScan(tasks, [ticket(['ready-for-agent', to])], wsId);
    const next = (await tasks.claimReady(mirrored.id))!;
    return (runner as unknown as { beginRun: (t: typeof next) => Promise<Awaited<ReturnType<AttemptStore['create']>>> }).beginRun(next);
  }

  const events = async (attemptId: number) =>
    (await attempts.listEvents(attemptId)).map((e) => JSON.parse(typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)));

  it('escalated cheap Ticket relabelled reasoning retries on the reasoning route, recorded as a fresh Session', async () => {
    const bound = await retryAfterRelabel('cheap', 'reasoning');
    expect(bound).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });
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

  it('records a Harness change', async () => {
    const bound = await retryAfterRelabel('cheap', 'other');
    expect((await events(bound.id))[0]).toMatchObject({ to: { harness: 'codex' }, label: 'other', sessionKept: false });
  });

  it('records nothing when the route is unchanged', async () => {
    const bound = await retryAfterRelabel('cheap', 'cheap');
    expect(await events(bound.id)).toEqual([]);
  });

  it('starts a fresh Session across a Model-only change and reports sessionKept false', async () => {
    const bound = await retryAfterRelabel('cheap', 'reasoning', true);
    expect(bound.sessionRowId).toBeNull();
    expect(await events(bound.id)).toEqual([expect.objectContaining({ event: 'route-changed', sessionKept: false })]);
  });

  it('starts a fresh Session across a Harness change and reports sessionKept false', async () => {
    const bound = await retryAfterRelabel('cheap', 'other', true);
    expect(bound.sessionRowId).toBeNull();
    expect(await events(bound.id)).toEqual([expect.objectContaining({ event: 'route-changed', sessionKept: false })]);
  });

  it('a resumed paused Attempt spawns on the route it started with after a relabel', async () => {
    const mirrored = (await mirrorScan(tasks, [ticket(['ready-for-agent', 'cheap'])], wsId))[0]!;
    const first = (await tasks.claimReady(mirrored.id))!;
    const attempt = await attempts.create(mirrored.id, { route: { harness: first.harness, model: first.model } });
    await tasks.pause(mirrored.id);
    await mirrorScan(tasks, [ticket(['ready-for-agent', 'other'])], wsId);
    const driven: { harness: string; model: string }[] = [];
    (runner as unknown as { turnDriver: { drive: (t: TaskRow) => Promise<void> } }).turnDriver.drive = async (t) => {
      driven.push({ harness: t.harness, model: t.model });
    };
    const resumed = await tasks.resume(mirrored.id);
    const begin = (runner as unknown as { beginRun: (t: TaskRow, p: undefined, a: typeof attempt) => Promise<typeof attempt> }).beginRun;
    const bound = await begin.call(runner, { ...resumed, harness: 'codex', model: '' }, undefined, attempt);
    await runner.shutdown();
    expect(bound).toMatchObject({ harness: first.harness, model: first.model });
    expect(driven).toEqual([{ harness: first.harness, model: first.model }]);
  });
});
