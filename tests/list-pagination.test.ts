import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from './helpers.js';

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
