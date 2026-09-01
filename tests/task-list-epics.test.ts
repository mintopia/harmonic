import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';
import type { Ticket } from '../src/tracker/adapter.js';

/**
 * The Tasks list sources epic rows from the derived-epic model, not a mirrored
 * `isEpic` task row (ADR-0016, issue #418). These tests exercise the `GET
 * /api/tasks?epics=true` merge — that derived-epic rows join the task rows under
 * one pagination/sort/`total`, and that a task-attribute filter narrows them out
 * (a container has no harness/priority/state). The derivation itself is covered
 * by epic-derivation / tracker-manager tests; here `listEpicTickets` is stubbed.
 */
describe('Tasks list epic rows from the derived model (issue #418)', () => {
  let server: TestServer;
  let workspaceId: number;

  // Two epics that bracket the "now"-stamped tasks in time, so a createdAt sort
  // is deterministic: Alpha is ancient (sorts first ascending), Beta is far in
  // the future (sorts last ascending).
  const epicTicket = (over: Partial<Ticket>): Ticket => ({
    number: 101,
    title: 'Alpha epic',
    state: 'open',
    body: '',
    createdAt: '2020-01-01T00:00:00.000Z',
    closedAt: null,
    labels: ['epic'],
    assignees: [],
    parent: null,
    blockedBy: [],
    blocking: [],
    comments: [],
    isMap: false,
    url: 'https://tracker/101',
    ...over,
  });
  const alpha = epicTicket({});
  const beta = epicTicket({ number: 102, title: 'Beta epic', createdAt: '2999-01-01T00:00:00.000Z', url: 'https://tracker/102' });

  beforeEach(async () => {
    server = await startServer(stubHarness());
    const a = await server.api('POST', '/api/tasks', { prompt: 'task a', priority: 'low', state: 'draft' });
    workspaceId = a.body.workspaceId;
    await server.api('POST', '/api/tasks', { prompt: 'task b', priority: 'high', harness: 'codex' });
    await server.api('POST', '/api/tasks', { prompt: 'task c' });
    vi.spyOn(server.app.ctx.trackerManager, 'listEpicTickets').mockResolvedValue([alpha, beta]);
  });
  afterEach(async () => {
    await server.close();
  });

  const rows = (body: any) => body.tasks as any[];
  const summaries = (body: any) => rows(body).map((t) => t.summary);

  it('merges derived-epic rows into the list, counted in the total', async () => {
    const res = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true`);
    expect(res.status).toBe(200);
    expect(summaries(res.body).sort()).toEqual(['Alpha epic', 'Beta epic', 'task a', 'task b', 'task c']);
    expect(res.body.total).toBe(5);
    const epicRow = rows(res.body).find((t) => t.summary === 'Alpha epic');
    expect(epicRow).toMatchObject({ isEpic: true, trackerRef: 101, url: 'https://tracker/101' });
  });

  it('omits epic rows unless epics=true is requested', async () => {
    const res = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}`);
    expect(summaries(res.body).sort()).toEqual(['task a', 'task b', 'task c']);
    expect(res.body.total).toBe(3);
    expect(rows(res.body).some((t) => t.isEpic)).toBe(false);
  });

  it('interleaves epic rows under the shared createdAt sort, both directions', async () => {
    const asc = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&sortBy=createdAt&order=asc`);
    expect(summaries(asc.body)).toEqual(['Alpha epic', 'task a', 'task b', 'task c', 'Beta epic']);

    const desc = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&sortBy=createdAt&order=desc`);
    expect(summaries(desc.body)).toEqual(['Beta epic', 'task c', 'task b', 'task a', 'Alpha epic']);
  });

  it('keeps pagination coherent — the total counts the merged set while a page slices it', async () => {
    const page = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&sortBy=createdAt&order=asc&limit=1`);
    expect(summaries(page.body)).toEqual(['Alpha epic']);
    expect(page.body.total).toBe(5);
  });

  it('drops epic rows when a task-attribute filter is active (containers have no state/harness/priority)', async () => {
    const byState = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&state=draft`);
    expect(summaries(byState.body)).toEqual(['task a']);

    const byPriority = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&priority=high`);
    expect(summaries(byPriority.body)).toEqual(['task b']);
  });

  it('applies the title search to epic rows', async () => {
    const hit = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&q=Alpha`);
    expect(summaries(hit.body)).toEqual(['Alpha epic']);

    const miss = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&q=task%20b`);
    expect(summaries(miss.body)).toEqual(['task b']);
  });
});
