import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';

describe('task list filtering and sorting (table view backend)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
    // A varied population. Stub config only defines the claude harness's
    // command; harness names are still claude/codex/copilot.
    await server.api('POST', '/api/tasks', { prompt: 'a', priority: 'low', state: 'draft' });
    await server.api('POST', '/api/tasks', { prompt: 'b', priority: 'high', harness: 'codex' });
    await server.api('POST', '/api/tasks', { prompt: 'c', priority: 'normal' });
    const d = await server.api('POST', '/api/tasks', { prompt: 'd', priority: 'high' });
    await server.api('POST', `/api/tasks/${d.body.id}/cancel`);
    const e = await server.api('POST', '/api/tasks', { prompt: 'e' });
    await server.app.ctx.tasks.setState(e.body.id, 'completed');
  });
  afterAll(async () => {
    await server.close();
  });

  const prompts = (body: any) => body.tasks.map((t: any) => t.prompt);

  it('filters by state, harness, and priority', async () => {
    const drafts = await server.api('GET', '/api/tasks?state=draft');
    expect(prompts(drafts.body)).toEqual(['a']);

    const codex = await server.api('GET', '/api/tasks?harness=codex');
    expect(prompts(codex.body)).toEqual(['b']);

    const high = await server.api('GET', '/api/tasks?priority=high');
    expect(prompts(high.body).sort()).toEqual(['b', 'd']);

    const highReady = await server.api('GET', '/api/tasks?priority=high&state=ready');
    expect(prompts(highReady.body)).toEqual(['b']);
  });

  it('filters completed and cancelled tasks through the explicit open shortcut, while an omitted filter stays complete', async () => {
    const open = await server.api('GET', '/api/tasks?state=open');
    expect(prompts(open.body).sort()).toEqual(['a', 'b', 'c']);

    const all = await server.api('GET', '/api/tasks');
    expect(prompts(all.body).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('sorts by creation time and by priority, both directions', async () => {
    const byCreatedDesc = await server.api('GET', '/api/tasks?sortBy=createdAt&order=desc');
    expect(prompts(byCreatedDesc.body)).toEqual(['e', 'd', 'c', 'b', 'a']);

    const byCreatedAsc = await server.api('GET', '/api/tasks?sortBy=createdAt&order=asc');
    expect(prompts(byCreatedAsc.body)).toEqual(['a', 'b', 'c', 'd', 'e']);

    const byPriority = await server.api('GET', '/api/tasks?sortBy=priority&order=asc');
    // high before normal before low; FIFO within a rank.
    expect(prompts(byPriority.body)).toEqual(['b', 'd', 'c', 'e', 'a']);
  });

  it('rejects invalid filter values', async () => {
    expect((await server.api('GET', '/api/tasks?state=bogus')).status).toBe(400);
    expect((await server.api('GET', '/api/tasks?sortBy=bogus')).status).toBe(400);
  });
});
