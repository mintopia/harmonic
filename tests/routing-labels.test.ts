import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { tasks as tasksTable, type RawTaskRow } from '../src/db/schema.js';
import { appConfigSchema, baselineConfig, type AppConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import { trackerRef, type Ticket } from '../src/tracker/adapter.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

const ticket = (ref: number, labels: string[]): Ticket => ({
  ref: trackerRef(ref),
  title: `Ticket ${ref}`,
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
  url: `https://github.com/mintopia/harmonic/issues/${ref}`,
});

describe('Routing Labels (ADR-0049)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let config: AppConfig;
  let tasks: TaskService;
  let wsId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-routing-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    settingsStore = await makeSettingsStore(dir);
    config = {
      ...baselineConfig(),
      routingLabels: [
        { label: 'reasoning', harness: 'claude', model: 'claude-opus-5-5' },
        { label: 'cheap', harness: 'codex', model: '' },
      ],
    };
    tasks = new TaskService(asyncDb, () => config, allWorkspaces(asyncDb, settingsStore));
    wsId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const mirror = async (ref: number, labels: string[]) => (await mirrorScan(tasks, [ticket(ref, labels)], wsId))[0]!;
  const rawRow = async (id: number): Promise<RawTaskRow> =>
    (await asyncDb.read((db) => db.select().from(tasksTable).where(eq(tasksTable.id, id)).get()))!;
  const setOperator = (id: number, set: Partial<Pick<RawTaskRow, 'harness' | 'model'>>) =>
    asyncDb.write((db) => db.update(tasksTable).set(set).where(eq(tasksTable.id, id)).run());

  describe('precedence', () => {
    it('global default when nothing else applies', async () => {
      const task = await mirror(1, ['ready-for-agent']);
      expect(task).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5' });
    });

    it('Workspace default beats the global default', async () => {
      await new WorkspaceService(asyncDb, settingsStore).update(wsId, { harness: 'codex' });
      const task = await mirror(1, ['ready-for-agent']);
      expect(task.harness).toBe('codex');
    });

    it('Routing Label beats the Workspace default', async () => {
      await new WorkspaceService(asyncDb, settingsStore).update(wsId, { harness: 'codex' });
      const task = await mirror(1, ['ready-for-agent', 'reasoning']);
      expect(task).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });
    });

    it('an operator Harness + Model beats the Routing Label', async () => {
      const mirrored = await mirror(1, ['ready-for-agent', 'reasoning']);
      await setOperator(mirrored.id, { harness: 'codex', model: 'gpt-5.5' });
      expect(await tasks.get(mirrored.id)).toMatchObject({ harness: 'codex', model: 'gpt-5.5' });
    });

    it('an empty route model resolves to that Harness default model', async () => {
      const task = await mirror(1, ['ready-for-agent', 'cheap']);
      expect(task).toMatchObject({ harness: 'codex', model: 'gpt-5.6-sol' });
    });
  });

  it('first match in list order wins, not issue label order', async () => {
    const task = await mirror(1, ['ready-for-agent', 'cheap', 'reasoning']);
    expect(task).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });
    expect(await tasks.routing.routingFor(task.id)).toEqual({ label: 'reasoning', applied: true });
  });

  it('matches case-insensitively and reports the label as configured', async () => {
    const task = await mirror(1, ['ready-for-agent', 'REASONING']);
    expect(task.model).toBe('claude-opus-5-5');
    expect(await tasks.routing.routingFor(task.id)).toEqual({ label: 'reasoning', applied: true });
  });

  it('never routes a native Task', async () => {
    const native = await tasks.create({ prompt: 'native' });
    await asyncDb.write((db) => db.update(tasksTable).set({ trackerLabels: ['reasoning'] }).where(eq(tasksTable.id, native.id)).run());
    expect(await tasks.get(native.id)).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5' });
    expect(await tasks.routing.routingFor(native.id)).toBeNull();
  });

  it('re-resolves when the Ticket is relabelled', async () => {
    const first = await mirror(1, ['ready-for-agent', 'reasoning']);
    expect(first.model).toBe('claude-opus-5-5');
    const relabelled = await mirror(1, ['ready-for-agent', 'cheap']);
    expect(relabelled).toMatchObject({ harness: 'codex', model: 'gpt-5.6-sol' });
  });

  describe('routing DTO field', () => {
    it('null without a matching label, applied true when the route decided, false under an operator override', async () => {
      const plain = await mirror(1, ['ready-for-agent']);
      const routed = await mirror(2, ['ready-for-agent', 'reasoning']);
      const overridden = await mirror(3, ['ready-for-agent', 'reasoning']);
      await setOperator(overridden.id, { harness: 'codex' });

      const byId = new Map((await tasks.listWithDeps()).map((t) => [t.id, t.routing]));
      expect(byId.get(plain.id)).toBeNull();
      expect(byId.get(routed.id)).toEqual({ label: 'reasoning', applied: true });
      expect(byId.get(overridden.id)).toEqual({ label: 'reasoning', applied: false });
      expect((await tasks.withDeps(await tasks.get(routed.id))).routing).toEqual({ label: 'reasoning', applied: true });
      expect((await tasks.withDeps(await tasks.get(overridden.id))).routing).toEqual({ label: 'reasoning', applied: false });
    });

    it('is null for a native Task', async () => {
      const native = await tasks.create({ prompt: 'native' });
      expect((await tasks.withDeps(native)).routing).toBeNull();
    });
  });

  describe('claimReady', () => {
    it('does not pin Harness/Model of a mirrored Ticket but still pins the other defaults', async () => {
      const mirrored = await mirror(1, ['ready-for-agent', 'reasoning']);
      const claimed = await tasks.claimReady(mirrored.id);
      expect(claimed).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });
      const after = await rawRow(mirrored.id);
      expect(after.harness).toBeNull();
      expect(after.model).toBeNull();
      expect(after.isolationMode).toBe('direct');
      expect(after.priority).toBe('normal');
      expect(after.conflictResolveTurns).toBe(2);
      expect(await tasks.routing.routingFor(mirrored.id)).toEqual({ label: 'reasoning', applied: true });
    });

    it('re-resolves the route at the next Attempt start after a relabel', async () => {
      const mirrored = await mirror(1, ['ready-for-agent', 'reasoning']);
      await tasks.claimReady(mirrored.id);
      await mirror(1, ['ready-for-agent', 'cheap']);
      expect(await tasks.get(mirrored.id)).toMatchObject({ harness: 'codex', model: 'gpt-5.6-sol' });
    });
  });

  describe('in-flight Attempt', () => {
    it('keeps the route it started with when labels or config change, and re-routes at the next Attempt', async () => {
      const attempts = new AttemptStore(asyncDb);
      const mirrored = await mirror(1, ['ready-for-agent', 'reasoning']);
      const claimed = (await tasks.claimReady(mirrored.id))!;
      const attempt = await attempts.create(mirrored.id, { route: { harness: claimed.harness, model: claimed.model } });
      expect(attempt).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });

      await mirror(1, ['ready-for-agent', 'cheap']);
      expect(await tasks.get(mirrored.id)).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });
      config = { ...config, routingLabels: [{ label: 'cheap', harness: 'copilot', model: '' }] };
      expect(await tasks.get(mirrored.id)).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });

      await attempts.update(attempt.id, { state: 'failed', endedAt: Date.now() });
      await tasks.setState(mirrored.id, 'ready');
      const next = (await tasks.claimReady(mirrored.id))!;
      expect(next.harness).toBe('copilot');
      expect(await tasks.get(mirrored.id)).toMatchObject({ harness: 'copilot' });
    });
  });

  describe('in-flight pinning when no Routing Label matches any more', () => {
    const started = { harness: 'claude', model: 'claude-opus-5-5' };
    async function routedAttempt() {
      const attempts = new AttemptStore(asyncDb);
      const mirrored = await mirror(1, ['ready-for-agent', 'reasoning']);
      const claimed = (await tasks.claimReady(mirrored.id))!;
      const attempt = await attempts.create(mirrored.id, { route: { harness: claimed.harness, model: claimed.model } });
      return { mirrored, attempts, attempt };
    }

    it('keeps the route when the deciding label is removed from the Ticket', async () => {
      const { mirrored, attempts, attempt } = await routedAttempt();
      await mirror(1, ['ready-for-agent']);
      expect(await tasks.get(mirrored.id)).toMatchObject(started);
      expect((await tasks.listWithDeps()).find((t) => t.id === mirrored.id)).toMatchObject(started);
      await attempts.update(attempt.id, { state: 'failed', endedAt: Date.now() });
      expect(await tasks.get(mirrored.id)).toMatchObject({ model: 'claude-sonnet-5-5' });
    });

    it('keeps the route when the Ticket is relabelled to a non-routing label', async () => {
      const { mirrored } = await routedAttempt();
      await mirror(1, ['ready-for-agent', 'documentation']);
      expect(await tasks.get(mirrored.id)).toMatchObject(started);
    });

    it('keeps the route when the Routing Label row is deleted from the global config', async () => {
      const { mirrored } = await routedAttempt();
      config = { ...config, routingLabels: [] };
      expect(await tasks.get(mirrored.id)).toMatchObject(started);
      expect((await tasks.list()).find((t) => t.id === mirrored.id)).toMatchObject(started);
    });

    it('keeps the route when the row is disabled in the Workspace overlay', async () => {
      const { mirrored } = await routedAttempt();
      await new WorkspaceService(asyncDb, settingsStore).update(wsId, { routingLabels: [{ kind: 'global', ref: 'reasoning', enabled: false }] });
      expect(await tasks.get(mirrored.id)).toMatchObject(started);
      expect((await tasks.listWithDeps()).find((t) => t.id === mirrored.id)).toMatchObject(started);
    });

    it('keeps the route while paused with the label removed', async () => {
      const { mirrored } = await routedAttempt();
      await tasks.pause(mirrored.id);
      await mirror(1, ['ready-for-agent']);
      expect(await tasks.get(mirrored.id)).toMatchObject({ state: 'paused', ...started });
    });
  });

  describe('in-flight pinning while paused', () => {
    async function pausedRoutedTask() {
      const attempts = new AttemptStore(asyncDb);
      const mirrored = await mirror(1, ['ready-for-agent', 'reasoning']);
      const claimed = (await tasks.claimReady(mirrored.id))!;
      const attempt = await attempts.create(mirrored.id, { route: { harness: claimed.harness, model: claimed.model } });
      await tasks.pause(mirrored.id);
      await mirror(1, ['ready-for-agent', 'cheap']);
      return { mirrored, attempts, attempt };
    }

    it('get, list, listWithDeps and a state change all report the route the paused Attempt started with', async () => {
      const { mirrored } = await pausedRoutedTask();
      const started = { harness: 'claude', model: 'claude-opus-5-5' };
      expect(await tasks.get(mirrored.id)).toMatchObject({ state: 'paused', ...started });
      expect((await tasks.list()).find((t) => t.id === mirrored.id)).toMatchObject(started);
      expect((await tasks.listWithDeps()).find((t) => t.id === mirrored.id)).toMatchObject(started);
      expect(await tasks.list({ harness: ['claude'] })).toHaveLength(1);
      expect(await tasks.resume(mirrored.id)).toMatchObject({ state: 'working', ...started });
    });

    it('the next Attempt after the paused one finishes re-routes to the new label', async () => {
      const { mirrored, attempts, attempt } = await pausedRoutedTask();
      await attempts.update(attempt.id, { state: 'failed', endedAt: Date.now() });
      expect(await tasks.get(mirrored.id)).toMatchObject({ harness: 'codex' });
    });
  });

  describe('editing an escalated Task', () => {
    it('allows a route-only PATCH and refuses an empty or non-route one', async () => {
      const mirrored = await mirror(1, ['ready-for-agent', 'reasoning']);
      await tasks.claimReady(mirrored.id);
      await tasks.escalate(mirrored.id, 'escalated to human: boom');
      await expect(tasks.update(mirrored.id, {})).rejects.toMatchObject({ code: 'invalid_state' });
      await expect(tasks.update(mirrored.id, { priority: 'high' })).rejects.toMatchObject({ code: 'invalid_state' });
      await expect(tasks.update(mirrored.id, { harness: 'codex', priority: 'high' })).rejects.toMatchObject({ code: 'invalid_state' });
      expect(await tasks.update(mirrored.id, { harness: 'codex' })).toMatchObject({ state: 'escalated', harness: 'codex' });
    });
  });

  describe('config schema', () => {
    const parse = (routingLabels: AppConfig['routingLabels']) => appConfigSchema.safeParse({ ...baselineConfig(), routingLabels });

    it('accepts the baseline empty list and a valid list', () => {
      expect(parse([]).success).toBe(true);
      expect(parse([{ label: 'reasoning', harness: 'claude', model: 'anything-open-catalog' }]).success).toBe(true);
    });

    it('rejects labels duplicated case-insensitively at the duplicate row', () => {
      const result = parse([
        { label: 'Reasoning', harness: 'claude', model: '' },
        { label: 'reasoning', harness: 'codex', model: '' },
      ]);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['routingLabels', 1, 'label']);
    });

    it('rejects a Harness that is not configured (the harness record is exhaustive, so this fails before the cross-check)', () => {
      const base = baselineConfig();
      const { codex: _codex, ...rest } = base.harnesses;
      const result = appConfigSchema.safeParse({ ...base, harnesses: rest, routingLabels: [{ label: 'x', harness: 'codex', model: '' }] });
      expect(result.success).toBe(false);
    });

    it('rejects a blank label', () => {
      expect(parse([{ label: '  ', harness: 'claude', model: '' }]).success).toBe(false);
    });
  });
  describe('Epic route (ADR-0049)', () => {
    const epic = async (ref: number, labels: string[], memberLabels: string[]) => {
      const member = { ...ticket(ref + 1, memberLabels), parent: trackerRef(ref) };
      await mirrorScan(tasks, [ticket(ref, labels), member], wsId);
      return trackerRef(ref);
    };

    it('an Epic labelled reasoning routes to reasoning even when its member is labelled cheap', async () => {
      const epicRef = await epic(10, ['epic', 'reasoning'], ['cheap']);
      expect(await tasks.routing.epicRoute(wsId, epicRef)).toMatchObject({ ok: true, harness: 'claude', model: 'claude-opus-5-5', label: 'reasoning' });
    });

    it('an unlabelled Epic uses the defaults regardless of its members', async () => {
      const epicRef = await epic(12, ['epic'], ['reasoning']);
      expect(await tasks.routing.epicRoute(wsId, epicRef)).toMatchObject({ ok: true, harness: 'claude', model: 'claude-sonnet-5-5', label: null });
    });

    it('a route with an empty model uses the Harness default model', async () => {
      const epicRef = await epic(14, ['epic', 'cheap'], []);
      const route = await tasks.routing.epicRoute(wsId, epicRef);
      expect(route).toMatchObject({ harness: 'codex', label: 'cheap' });
      expect(route.ok && route.model).toBe(config.harnesses.codex!.defaultModel);
    });

    it('reads the labels of an Epic persisted as a tracker container', async () => {
      await tasks.syncTrackerContainers(wsId, [{
        trackerRef: trackerRef(20),
        facts: { state: 'open', parent: null, blockedBy: [], labels: ['Reasoning'], title: 'Epic', body: '', url: 'u', createdAt: '2026-08-07T00:00:00Z' },
      }]);
      expect(await tasks.routing.epicRoute(wsId, trackerRef(20))).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5', label: 'reasoning' });
    });

    it('the Task row label beats a diverging container row label', async () => {
      const epicRef = trackerRef(30);
      await mirror(30, ['reasoning']);
      await tasks.syncTrackerContainers(wsId, [{
        trackerRef: epicRef,
        facts: { state: 'open', parent: null, blockedBy: [], labels: ['cheap'], title: 'Epic', body: '', url: 'u', createdAt: '2026-08-07T00:00:00Z' },
      }]);
      expect(await tasks.routing.epicRoute(wsId, epicRef)).toMatchObject({ harness: 'claude', label: 'reasoning' });
    });

    it('an Epic operator Harness override applies to Epic-level turns and replaces the label', async () => {
      const epicTask = await mirror(32, ['reasoning']);
      const epicRef = trackerRef(32);
      await setOperator(epicTask.id, { harness: 'codex' });
      expect(await tasks.routing.epicRoute(wsId, epicRef)).toMatchObject({ harness: 'codex', label: null });
    });

    it('an Epic with no stored row falls back to the defaults', async () => {
      expect(await tasks.routing.epicRoute(wsId, trackerRef(99))).toMatchObject({ harness: 'claude', label: null });
    });
  });
});
