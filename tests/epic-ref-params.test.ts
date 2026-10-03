import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from './helpers.js';

describe('Epic route ref params', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('answers an unknown Epic ref with a clean 404, not a 500', async () => {
    const [workspace] = await server.app.ctx.workspaces.list();
    const { status, body } = await server.api('GET', `/api/workspaces/${workspace!.id}/epics/PROJ-999999`);
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });
});
