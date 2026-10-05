import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';

describe('Workspace pauseMessage override over the API', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await server.close();
  });

  it('is returned by GET, persists through PATCH, and clears with null', async () => {
    const id = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id;
    expect((await server.api('GET', `/api/workspaces/${id}`)).body.pauseMessage).toBeNull();
    const patched = await server.api('PATCH', `/api/workspaces/${id}`, { pauseMessage: 'Hold on.' });
    expect(patched.body.pauseMessage).toBe('Hold on.');
    expect((await server.api('GET', `/api/workspaces/${id}`)).body.pauseMessage).toBe('Hold on.');
    const cleared = await server.api('PATCH', `/api/workspaces/${id}`, { pauseMessage: null });
    expect(cleared.body.pauseMessage).toBeNull();
  });
});
