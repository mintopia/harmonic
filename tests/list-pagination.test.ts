import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServer, type TestServer } from './helpers.js';
import type { Epic } from '../src/domain/epic-view.js';
import type { DerivedMap } from '../src/tracker/mirror.js';

/**
 * The shared pagination envelope (ADR-0045, issue #352) applied to the migrated
 * list endpoints: an omitted `limit` returns the whole list plus a `total`
 * (additive rollout), and `limit`/`offset` slice a page while `total` stays the
 * full match count. `/api/tasks` has its own coverage in tasks.test.ts; this
 * exercises a representative migrated endpoint end to end.
 */
describe('list endpoint pagination envelope', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('an empty list carries the total envelope', async () => {
    const res = await server.api('GET', '/api/permission-rules');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rules: [], total: 0 });
  });

  it('is additive: no limit returns every conversation plus a total', async () => {
    for (let i = 0; i < 3; i++) await server.api('POST', '/api/conversations', {});
    const res = await server.api('GET', '/api/conversations');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.conversations).toHaveLength(3);
  });

  it('slices to a page with limit/offset while total stays the full count', async () => {
    const page1 = await server.api('GET', '/api/conversations?limit=2');
    expect(page1.body.conversations).toHaveLength(2);
    expect(page1.body.total).toBe(3);

    const page2 = await server.api('GET', '/api/conversations?limit=2&offset=2');
    expect(page2.body.conversations).toHaveLength(1);
    expect(page2.body.total).toBe(3);

    const ids = new Set([
      ...page1.body.conversations.map((c: { id: number }) => c.id),
      ...page2.body.conversations.map((c: { id: number }) => c.id),
    ]);
    expect(ids.size).toBe(3);
  });

  it('rejects a limit over the shared max', async () => {
    const res = await server.api('GET', '/api/conversations?limit=1000');
    expect(res.status).toBe(400);
  });
});

/**
 * The two derived read-model rollups this contract also covers (issue #351):
 * `/api/epics` and `/api/maps` slice on the shared envelope even though their
 * pages come from a query-time scan rather than a table. Pagination runs in the
 * route over the whole derived list, so a fixed service result proves the
 * slice/`total` behaviour without standing up a real tracker loop.
 */
describe('derived-rollup pagination (epics, maps)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const epic = (ref: number, title = `Epic ${ref}`): Epic => ({
    ref,
    title,
    kind: 'spec',
    description: '',
    createdAt: 0,
    updatedAt: null,
    baseBranch: null,
    dependsOn: [],
    members: [],
    ready: [],
    integration: { branch: `epic/${ref}`, exists: true, tip: null },
    verification: { status: null },
    integrate: { inFlight: false, held: null },
    foldedCount: 0,
    memberCount: 0,
  });

  const map = (ref: number, workspaceId: number, title = `Map ${ref}`): DerivedMap => ({
    workspaceId,
    ref,
    title,
    url: `https://example.test/${ref}`,
    taskRefs: [],
    counts: {},
  });

  it('/api/epics slices to a page while total stays the full derived count', async () => {
    const workspaceId = (await server.app.ctx.workspaces.list())[0]!.id;
    vi.spyOn(server.app.ctx.trackerManager, 'listEpics').mockResolvedValue([epic(1), epic(2), epic(3)]);

    const all = await server.api('GET', `/api/workspaces/${workspaceId}/epics`);
    expect(all.body).toEqual({ epics: [epic(1), epic(2), epic(3)], total: 3 });

    const page1 = await server.api('GET', `/api/workspaces/${workspaceId}/epics?limit=2`);
    expect(page1.body).toEqual({ epics: [epic(1), epic(2)], total: 3 });

    const page2 = await server.api('GET', `/api/workspaces/${workspaceId}/epics?limit=2&offset=2`);
    expect(page2.body).toEqual({ epics: [epic(3)], total: 3 });
  });

  it('/api/epics rejects a limit over the shared max', async () => {
    const workspaceId = (await server.app.ctx.workspaces.list())[0]!.id;
    expect((await server.api('GET', `/api/workspaces/${workspaceId}/epics?limit=1000`)).status).toBe(400);
  });

  it('/api/epics filters by a case-insensitive title substring, then reports the matched total', async () => {
    const workspaceId = (await server.app.ctx.workspaces.list())[0]!.id;
    vi.spyOn(server.app.ctx.trackerManager, 'listEpics').mockResolvedValue([
      epic(1, 'Parallel operator UI'),
      epic(2, 'Async DB migration'),
      epic(3, 'Operator force-integrate'),
    ]);

    const res = await server.api('GET', `/api/workspaces/${workspaceId}/epics?q=operator`);
    expect(res.body.total).toBe(2);
    expect(res.body.epics.map((e: Epic) => e.ref)).toEqual([1, 3]);

    // A blank query matches every Epic (whitespace-only ⇒ no filter).
    const blank = await server.api('GET', `/api/workspaces/${workspaceId}/epics?q=%20`);
    expect(blank.body.total).toBe(3);
  });

  it('/api/epics applies q before slicing so the page and total agree', async () => {
    const workspaceId = (await server.app.ctx.workspaces.list())[0]!.id;
    vi.spyOn(server.app.ctx.trackerManager, 'listEpics').mockResolvedValue([
      epic(1, 'operator a'),
      epic(2, 'operator b'),
      epic(3, 'unrelated'),
    ]);

    const page = await server.api('GET', `/api/workspaces/${workspaceId}/epics?q=operator&limit=1&offset=1`);
    expect(page.body).toEqual({ epics: [epic(2, 'operator b')], total: 2 });
  });

  it('/api/maps slices to a page while total stays the full derived count', async () => {
    const workspaceId = (await server.app.ctx.workspaces.list())[0]!.id;
    vi.spyOn(server.app.ctx.trackerManager, 'maps').mockResolvedValue([
      map(1, workspaceId),
      map(2, workspaceId),
      map(3, workspaceId),
    ]);

    const all = await server.api('GET', '/api/maps');
    expect(all.body).toEqual({ maps: [map(1, workspaceId), map(2, workspaceId), map(3, workspaceId)], total: 3 });

    const page1 = await server.api('GET', '/api/maps?limit=2');
    expect(page1.body).toEqual({ maps: [map(1, workspaceId), map(2, workspaceId)], total: 3 });

    const page2 = await server.api('GET', '/api/maps?limit=2&offset=2');
    expect(page2.body).toEqual({ maps: [map(3, workspaceId)], total: 3 });
  });

  it('/api/maps rejects a limit over the shared max', async () => {
    expect((await server.api('GET', '/api/maps?limit=1000')).status).toBe(400);
  });

  it('/api/maps filters by a case-insensitive title substring before slicing', async () => {
    const workspaceId = (await server.app.ctx.workspaces.list())[0]!.id;
    vi.spyOn(server.app.ctx.trackerManager, 'maps').mockResolvedValue([
      map(1, workspaceId, 'Wayfinder'),
      map(2, workspaceId, 'Reliability'),
      map(3, workspaceId, 'Wayfinder redesign'),
    ]);

    const res = await server.api('GET', '/api/maps?q=wayfinder');
    expect(res.body.total).toBe(2);
    expect(res.body.maps.map((m: DerivedMap) => m.ref)).toEqual([1, 3]);

    const page = await server.api('GET', '/api/maps?q=wayfinder&limit=1&offset=1');
    expect(page.body).toEqual({ maps: [map(3, workspaceId, 'Wayfinder redesign')], total: 2 });
  });
});
