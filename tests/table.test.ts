import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';

describe('task list filtering and sorting (table view backend)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
    await server.api('POST', '/api/tasks', { prompt: 'a', priority: 'low', state: 'draft' });
    await server.api('POST', '/api/tasks', { prompt: 'b', priority: 'high', harness: 'codex' });
    await server.api('POST', '/api/tasks', { prompt: 'c', priority: 'normal' });
    const d = await server.api('POST', '/api/tasks', { prompt: 'd', priority: 'high' });
    await server.api('POST', `/api/tasks/${d.body.id}/cancel`);
    const e = await server.api('POST', '/api/tasks', { prompt: 'e' });
    await server.app.ctx.tasks.setState(e.body.id, 'done');
  });
  afterAll(async () => {
    await server.close();
  });

  const summaries = (body: any) => body.tasks.map((t: any) => t.summary);

  it('filters by state, harness, and priority', async () => {
    const drafts = await server.api('GET', '/api/tasks?state=draft');
    expect(summaries(drafts.body)).toEqual(['a']);

    const codex = await server.api('GET', '/api/tasks?harness=codex');
    expect(summaries(codex.body)).toEqual(['b']);

    const high = await server.api('GET', '/api/tasks?priority=high');
    expect(summaries(high.body).sort()).toEqual(['b', 'd']);

    const highReady = await server.api('GET', '/api/tasks?priority=high&state=ready');
    expect(summaries(highReady.body)).toEqual(['b']);
  });

  it('matches any value of a comma-separated multi-select filter', async () => {
    const states = await server.api('GET', '/api/tasks?state=draft,done');
    expect(summaries(states.body).sort()).toEqual(['a', 'e']);

    const priorities = await server.api('GET', '/api/tasks?priority=high,low');
    expect(summaries(priorities.body).sort()).toEqual(['a', 'b', 'd']);
  });

  it('filters completed and cancelled tasks through the explicit open shortcut, while an omitted filter stays complete', async () => {
    const open = await server.api('GET', '/api/tasks?state=open');
    expect(summaries(open.body).sort()).toEqual(['a', 'b', 'c']);

    const all = await server.api('GET', '/api/tasks');
    expect(summaries(all.body).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('sorts by creation time and by priority, both directions', async () => {
    const byCreatedDesc = await server.api('GET', '/api/tasks?sortBy=createdAt&order=desc');
    expect(summaries(byCreatedDesc.body)).toEqual(['e', 'd', 'c', 'b', 'a']);

    const byCreatedAsc = await server.api('GET', '/api/tasks?sortBy=createdAt&order=asc');
    expect(summaries(byCreatedAsc.body)).toEqual(['a', 'b', 'c', 'd', 'e']);

    const byPriority = await server.api('GET', '/api/tasks?sortBy=priority&order=asc');
    expect(summaries(byPriority.body)).toEqual(['b', 'd', 'c', 'e', 'a']);
  });

  it('rejects invalid filter values', async () => {
    expect((await server.api('GET', '/api/tasks?state=bogus')).status).toBe(400);
    expect((await server.api('GET', '/api/tasks?sortBy=bogus')).status).toBe(400);
  });
});
