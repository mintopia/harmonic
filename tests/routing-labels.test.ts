import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { tasks as tasksTable, type RawTaskRow } from '../src/db/schema.js';
import { appConfigSchema, baselineConfig, type AppConfig, type RoutingLabel, type RoutingLabelOverlayEntry } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import { trackerRef, type Ticket } from '../src/tracker/adapter.js';
import { type SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace, startServer, stubHarness, type TestServer } from './helpers.js';
import { routingLabelIssues, routingLabelOverlayIssues } from '../src/domain/setting-override.js';
import { resolveRoutingLabels } from '../src/domain/routing-labels.js';

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

    const containerOnly = (ref: number, labels: string[]) =>
      tasks.syncTrackerContainers(wsId, [{
        trackerRef: trackerRef(ref),
        facts: { state: 'open', parent: null, blockedBy: [], labels, title: 'Epic', body: '', url: 'u', createdAt: '2026-08-07T00:00:00Z' },
      }]);

    it('falls through to the container row when the Task row labels match nothing', async () => {
      await mirror(40, []);
      await containerOnly(40, ['reasoning']);
      expect(await tasks.routing.epicRoute(wsId, trackerRef(40))).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5', label: 'reasoning' });
    });

    it('falls through to the defaults when neither the Task row nor the container row matches', async () => {
      await mirror(42, ['bug']);
      await containerOnly(42, ['epic']);
      expect(await tasks.routing.epicRoute(wsId, trackerRef(42))).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5', label: null });
    });

    it('a Model-only override keeps the default Harness and ignores the label', async () => {
      const epicTask = await mirror(44, ['reasoning']);
      await setOperator(epicTask.id, { model: 'claude-haiku-5-5' });
      expect(await tasks.routing.epicRoute(wsId, trackerRef(44))).toMatchObject({ harness: 'claude', model: 'claude-haiku-5-5', label: null });
    });

    describe('a Harness-only override never inherits the Workspace Model of another Harness', () => {
      beforeEach(async () => {
        await settingsStore.setOverrides(wsId, { harness: 'claude', model: 'claude-opus-5-5' });
      });

      it('on an Epic', async () => {
        const epicTask = await mirror(46, []);
        await setOperator(epicTask.id, { harness: 'codex' });
        const route = await tasks.routing.epicRoute(wsId, trackerRef(46));
        expect(route).toMatchObject({ harness: 'codex' });
        expect(route.ok && route.model).toBe(config.harnesses.codex!.defaultModel);
      });

      it('on a Ticket', async () => {
        const ticketTask = await mirror(48, []);
        await setOperator(ticketTask.id, { harness: 'codex' });
        expect(await tasks.get(ticketTask.id)).toMatchObject({ harness: 'codex', model: config.harnesses.codex!.defaultModel });
      });

      it('keeps the Workspace Model when the Harness is unchanged', async () => {
        expect((await tasks.get((await mirror(50, [])).id))).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });
      });
    });

    it('an Epic with no stored row falls back to the defaults', async () => {
      expect(await tasks.routing.epicRoute(wsId, trackerRef(99))).toMatchObject({ harness: 'claude', label: null });
    });
  });
});

describe('Routing Label overlay', () => {
  const reasoning: RoutingLabel = { label: 'reasoning', harness: 'claude', model: 'claude-opus-5-5' };
  const cheap: RoutingLabel = { label: 'cheap', harness: 'codex', model: '' };
  const fast: RoutingLabel = { label: 'Fast', harness: 'codex', model: 'gpt-5.5' };

  const store = (overlay: RoutingLabelOverlayEntry[] | null) => ({ routingLabels: overlay === null ? null : JSON.stringify(overlay) });
  const resolved = (overlay: RoutingLabelOverlayEntry[] | null, globals: RoutingLabel[]) =>
    resolveRoutingLabels(store(overlay), { routingLabels: globals }).map((r) => r.label);
  const global = (ref: string, enabled = true): RoutingLabelOverlayEntry => ({ kind: 'global', ref, enabled });
  const local = (routingLabel: RoutingLabel, enabled = true): RoutingLabelOverlayEntry => ({ kind: 'local', enabled, routingLabel });

  describe('resolveRoutingLabels (ADR-0037 overlay)', () => {
    it('unset inherits every global in global order', () => {
      expect(resolved(null, [reasoning, cheap])).toEqual(['reasoning', 'cheap']);
      expect(resolveRoutingLabels(null, { routingLabels: [reasoning, cheap] })).toEqual([reasoning, cheap]);
    });

    it('reorders globals', () => {
      expect(resolved([global('cheap'), global('reasoning')], [reasoning, cheap])).toEqual(['cheap', 'reasoning']);
    });

    it('skips a disabled global and does not re-append it', () => {
      expect(resolved([global('reasoning', false), global('cheap')], [reasoning, cheap])).toEqual(['cheap']);
    });

    it('inlines an enabled local row at its position and skips a disabled one', () => {
      expect(resolved([global('reasoning'), local(fast), global('cheap')], [reasoning, cheap])).toEqual(['reasoning', 'Fast', 'cheap']);
      expect(resolved([global('reasoning'), local(fast, false)], [reasoning])).toEqual(['reasoning']);
    });

    it('appends a newly added global, enabled, at the end', () => {
      expect(resolved([global('cheap'), global('reasoning')], [reasoning, cheap, fast])).toEqual(['cheap', 'reasoning', 'Fast']);
    });

    it('drops an overlay entry whose global was deleted', () => {
      expect(resolved([global('gone'), global('cheap')], [cheap])).toEqual(['cheap']);
    });

    it('drops an enabled local shadowed by an enabled global added later, so the global wins', () => {
      const shadow = { ...fast, label: 'FAST', model: 'local-model' };
      const result = resolveRoutingLabels(store([local(shadow), global('cheap')]), { routingLabels: [cheap, fast] });
      expect(result).toEqual([cheap, fast]);
      expect(resolved([local(shadow), global('fast', false), global('cheap')], [cheap, fast])).toEqual(['FAST', 'cheap']);
    });

    it('refs the global by lowercased label', () => {
      expect(resolved([global('fast')], [fast])).toEqual(['Fast']);
    });
  });

  describe('Workspace Routing Label overlay resolves at Task resolution (ADR-0049)', () => {
    let dir: string;
    let asyncDb: AsyncDbHandle;
    let settingsStore: SettingsStore;
    let config: AppConfig;
    let tasks: TaskService;
    let workspaces: WorkspaceService;
    let wsId: number;

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
    const mirror = async (ref: number, labels: string[]) => (await mirrorScan(tasks, [ticket(ref, labels)], wsId))[0]!;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'harmonic-routing-overlay-'));
      asyncDb = await openAsyncDb(dir);
      await seedWorkspace(asyncDb);
      settingsStore = await makeSettingsStore(dir);
      config = { ...baselineConfig(), routingLabels: [reasoning, cheap] };
      tasks = new TaskService(asyncDb, () => config, allWorkspaces(asyncDb, settingsStore));
      workspaces = new WorkspaceService(asyncDb, settingsStore);
      wsId = (await workspaces.list())[0]!.id;
    });
    afterEach(async () => {
      await asyncDb.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('an unset overlay routes by the globals', async () => {
      const task = await mirror(1, ['reasoning']);
      expect(task).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });
    });

    it('a disabled global no longer routes; the Workspace falls back to its default', async () => {
      await workspaces.update(wsId, { routingLabels: [global('reasoning', false), global('cheap')] });
      const task = await mirror(1, ['reasoning']);
      expect(task).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5' });
      expect(await tasks.routing.routingFor(task.id)).toBeNull();
    });

    it('reordering changes which label wins when a Ticket carries both', async () => {
      await workspaces.update(wsId, { routingLabels: [global('cheap'), global('reasoning')] });
      const task = await mirror(1, ['reasoning', 'cheap']);
      expect(task).toMatchObject({ harness: 'codex', model: 'gpt-5.6-sol' });
      expect(await tasks.routing.routingFor(task.id)).toEqual({ label: 'cheap', applied: true });
    });

    it('a local row routes only that Workspace', async () => {
      await workspaces.update(wsId, { routingLabels: [global('reasoning'), local({ label: 'local-only', harness: 'codex', model: 'gpt-5.5' })] });
      const task = await mirror(1, ['LOCAL-ONLY']);
      expect(task).toMatchObject({ harness: 'codex', model: 'gpt-5.5' });
      expect((await tasks.withDeps(task)).routing).toEqual({ label: 'local-only', applied: true });
      expect((await tasks.listWithDeps()).find((t) => t.id === task.id)!.routing).toEqual({ label: 'local-only', applied: true });
    });

    it('a global added after the overlay was saved still routes, appended last', async () => {
      await workspaces.update(wsId, { routingLabels: [global('reasoning')] });
      expect(await mirror(1, ['cheap'])).toMatchObject({ harness: 'codex', model: 'gpt-5.6-sol' });
    });

    it('clearing the overlay with null goes back to the globals', async () => {
      await workspaces.update(wsId, { routingLabels: [global('reasoning', false)] });
      await workspaces.update(wsId, { routingLabels: null });
      expect(await mirror(1, ['reasoning'])).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });
    });
  });

  describe('Workspace Routing Label overlay save validation', () => {
    let server: TestServer;
    let wsId: number;

    const patch = (routingLabels: RoutingLabelOverlayEntry[] | null) => server.api('PATCH', `/api/workspaces/${wsId}`, { routingLabels });

    beforeEach(async () => {
      server = await startServer(stubHarness());
      wsId = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id as number;
      const current = (await server.api('GET', '/api/config')).body;
      const put = await server.api('PUT', '/api/config', { ...current, routingLabels: [reasoning, cheap] });
      expect(put.status).toBe(200);
    });
    afterEach(async () => {
      await server.close();
    });

    it('round-trips a saved overlay and null', async () => {
      const overlay = [global('cheap'), local(fast), global('reasoning', false)];
      const saved = await patch(overlay);
      expect(saved.status).toBe(200);
      expect(saved.body.routingLabels).toEqual(overlay);
      expect((await server.api('GET', `/api/workspaces/${wsId}`)).body.routingLabels).toEqual(overlay);
      expect((await patch(null)).body.routingLabels).toBeNull();
    });

    it('refuses a local row duplicating an enabled global label, case-insensitively', async () => {
      const res = await patch([global('reasoning'), local({ ...fast, label: 'REASONING' })]);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('duplicates the enabled Global label reasoning');
      expect((await server.api('GET', `/api/workspaces/${wsId}`)).body.routingLabels).toBeNull();
    });

    it('refuses a local row duplicating a global that the overlay does not name', async () => {
      expect((await patch([local({ ...fast, label: 'cheap' })])).status).toBe(400);
    });

    it('refuses a local row whose Harness is not configured', async () => {
      delete (server.app.ctx.settingsStore.getGlobal().harnesses as Record<string, unknown>).codex;
      const res = await patch([local(fast)]);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("harness 'codex' is not configured");
      expect((await server.api('GET', `/api/workspaces/${wsId}`)).body.routingLabels).toBeNull();
    });

    it('allows the label once the global is disabled', async () => {
      const res = await patch([global('reasoning', false), local({ ...fast, label: 'Reasoning' })]);
      expect(res.status).toBe(200);
    });

    it('refuses two enabled local rows with the same label', async () => {
      expect((await patch([local(fast), local({ ...fast, label: 'fast' })])).status).toBe(400);
      expect((await patch([local(fast), local({ ...fast, label: 'fast' }, false)])).status).toBe(200);
    });
  });

  describe('routingLabelOverlayIssues', () => {
    const globals = [reasoning, cheap];

    it('flags a local label duplicating an enabled global, case-insensitively, and names the global', () => {
      expect(routingLabelOverlayIssues([local({ ...fast, label: 'REASONING' })], globals)).toEqual([
        { index: 0, kind: 'duplicate-global', globalRef: 'reasoning' },
      ]);
    });

    it('frees a label when its global is disabled, and skips disabled locals', () => {
      expect(routingLabelOverlayIssues([global('reasoning', false), local({ ...fast, label: 'reasoning' })], globals)).toEqual([]);
      expect(routingLabelOverlayIssues([local({ ...fast, label: 'cheap' }, false)], globals)).toEqual([]);
    });

    it('flags a blank and a repeated local label', () => {
      expect(routingLabelOverlayIssues([local(fast), local({ ...fast, label: ' FAST ' }), local({ ...fast, label: ' ' })], globals)).toEqual([
        { index: 1, kind: 'duplicate' },
        { index: 2, kind: 'blank' },
      ]);
    });
  });

  describe('routingLabelIssues', () => {
    it('flags blank and case-insensitive duplicates in a flat list', () => {
      expect(routingLabelIssues([{ label: 'a' }, { label: ' A ' }, { label: '' }])).toEqual([
        { index: 1, kind: 'duplicate' },
        { index: 2, kind: 'blank' },
      ]);
    });
  });
});
