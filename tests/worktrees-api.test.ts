import { afterEach, describe, expect, it, vi } from 'vitest';
import { Git } from '../src/execution/git.js';
import { worktreeId } from '../src/domain/worktree-inventory.js';
import { startServer, waitFor, type TestServer } from './helpers.js';

describe('worktree inventory API (issue #482)', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
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
      changeCount: 0,
      state: 'Active',
    }]);

    await expect(waitFor(async () => messages.find((message): message is { type: 'worktrees'; worktrees: unknown[] } =>
      typeof message === 'object' && message !== null && 'type' in message && message.type === 'worktrees',
    ))).resolves.toMatchObject({ worktrees: [{ state: 'Active', path: '/trees/task-1' }] });
    socket.close();
  });

  it('lets an operator force-clean a managed worktree and its branch', async () => {
    server = await startServer();
    vi.spyOn(server.app.ctx.worktreeInventory, 'snapshot').mockResolvedValue([
      {
        workspaceId: 1,
        path: `${server.dataDir}/worktrees/task-42`,
        branch: 'harmonic/task-42',
        subject: { kind: 'task', taskId: 42, title: 'Issue 42' },
        sizeBytes: null,
        dirty: true,
        changeCount: 2,
        state: 'Dirty',
      },
    ]);
    const remove = vi.spyOn(Git, 'removeWorktreeAndDeleteBranch').mockResolvedValue(true);

    const response = await server.api('POST', `/api/worktrees/${worktreeId({ workspaceId: 1, path: `${server.dataDir}/worktrees/task-42` })}/cleanup`);

    expect(response).toMatchObject({ status: 200, body: { removed: true } });
    expect(remove).toHaveBeenCalledWith(
      expect.any(String),
      `${server.dataDir}/worktrees/task-42`,
      'harmonic/task-42',
      expect.any(Function),
    );
  });

  it('lists only the dirty files that a managed worktree cleanup would discard', async () => {
    server = await startServer();
    const path = `${server.dataDir}/worktrees/task-42`;
    vi.spyOn(server.app.ctx.worktreeInventory, 'snapshot').mockResolvedValue([
      {
        workspaceId: 1,
        path,
        branch: 'harmonic/task-42',
        subject: { kind: 'task', taskId: 42, title: 'Issue 42' },
        sizeBytes: null,
        dirty: true,
        changeCount: 2,
        state: 'Dirty',
      },
    ]);
    vi.spyOn(Git, 'dirtyFiles').mockResolvedValue(['src/changed.ts', 'untracked.txt']);

    const response = await server.api('GET', `/api/worktrees/${worktreeId({ workspaceId: 1, path })}/dirty-files`);

    expect(response).toMatchObject({ status: 200, body: { files: ['src/changed.ts', 'untracked.txt'] } });
    expect(Git.dirtyFiles).toHaveBeenCalledWith(path);
  });

  it('refuses force-cleanup outside the managed worktree root', async () => {
    server = await startServer();
    vi.spyOn(server.app.ctx.worktreeInventory, 'snapshot').mockResolvedValue([
      {
        workspaceId: 1,
        path: '/outside/task-42',
        branch: 'harmonic/task-42',
        subject: { kind: 'task', taskId: 42, title: 'Issue 42' },
        sizeBytes: null,
        dirty: null,
        changeCount: null,
        state: 'Unreadable',
      },
    ]);
    const remove = vi.spyOn(Git, 'removeWorktreeAndDeleteBranch').mockResolvedValue(true);

    const response = await server.api('POST', `/api/worktrees/${worktreeId({ workspaceId: 1, path: '/outside/task-42' })}/cleanup`);

    expect(response).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    expect(remove).not.toHaveBeenCalled();
  });

  it('returns a concurrent cleanup outcome without treating it as an unknown worktree', async () => {
    server = await startServer();
    const path = `${server.dataDir}/worktrees/task-42`;
    vi.spyOn(server.app.ctx.worktreeInventory, 'snapshot').mockResolvedValue([
      {
        workspaceId: 1,
        path,
        branch: 'harmonic/task-42',
        subject: { kind: 'task', taskId: 42, title: 'Issue 42' },
        sizeBytes: null,
        dirty: null,
        changeCount: null,
        state: 'Stale',
      },
    ]);
    vi.spyOn(Git, 'removeWorktreeAndDeleteBranch').mockResolvedValue(false);

    const response = await server.api('POST', `/api/worktrees/${worktreeId({ workspaceId: 1, path })}/cleanup`);

    expect(response).toMatchObject({ status: 200, body: { removed: false } });
  });

  it('force-cleans an orphan inventory row by its opaque id', async () => {
    server = await startServer();
    const path = `${server.dataDir}/worktrees/orphan`;
    vi.spyOn(server.app.ctx.worktreeInventory, 'snapshot').mockResolvedValue([
      {
        workspaceId: 1,
        path,
        branch: 'harmonic/orphan',
        subject: null,
        sizeBytes: null,
        dirty: null,
        changeCount: null,
        state: 'Orphan',
      },
    ]);
    const remove = vi.spyOn(Git, 'removeWorktreeAndDeleteBranch').mockResolvedValue(true);

    const response = await server.api('POST', `/api/worktrees/${worktreeId({ workspaceId: 1, path })}/cleanup`);

    expect(response).toMatchObject({ status: 200, body: { removed: true } });
    expect(remove).toHaveBeenCalledOnce();
  });
});
