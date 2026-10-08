import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig, type AppConfig, type RoutingLabel, type RoutingLabelOverlayEntry } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { resolveRoutingLabels, routingLabelOverlayIssues } from '../src/domain/setting-override.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import { trackerRef, type Ticket } from '../src/tracker/adapter.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace, startServer, stubHarness, type TestServer } from './helpers.js';

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
    expect(JSON.stringify(res.body)).toContain('already mapped');
    expect((await server.api('GET', `/api/workspaces/${wsId}`)).body.routingLabels).toBeNull();
  });

  it('refuses a local row duplicating a global that the overlay does not name', async () => {
    expect((await patch([local({ ...fast, label: 'cheap' })])).status).toBe(400);
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
  it('flags a local row whose harness is not configured', () => {
    const { codex: _codex, ...harnesses } = baselineConfig().harnesses;
    const issues = routingLabelOverlayIssues([local(fast)], { routingLabels: [], harnesses: harnesses as AppConfig['harnesses'] });
    expect(issues).toEqual([{ path: [0, 'routingLabel', 'harness'], message: 'harness codex is not configured' }]);
  });
});
