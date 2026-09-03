import { afterEach, describe, expect, it } from 'vitest';
import { startServer, waitFor, type TestServer } from './helpers.js';

describe('worktree inventory API (issue #482)', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('serves a read-time snapshot and broadcasts complete inventory refreshes', async () => {
    server = await startServer();
    const snapshot = await server.api('GET', '/api/worktrees');
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({ worktrees: expect.any(Array), total: expect.any(Number) });

    const socket = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${server.sessionToken}`);
    const messages: unknown[] = [];
    socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')));
    });

    server.app.ctx.bus.emit('worktrees', [{
      workspaceId: 1,
      path: '/trees/task-1',
      branch: 'harmonic/task-1',
      subject: { kind: 'task', taskId: 1, title: 'Issue 1' },
      sizeBytes: 4,
      dirty: false,
      state: 'Active',
    }]);

    await expect(waitFor(async () => messages.find((message): message is { type: 'worktrees'; worktrees: unknown[] } =>
      typeof message === 'object' && message !== null && 'type' in message && message.type === 'worktrees',
    ))).resolves.toMatchObject({ worktrees: [{ state: 'Active', path: '/trees/task-1' }] });
    socket.close();
  });
});
