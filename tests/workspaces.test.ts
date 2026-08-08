import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type TestServer } from './helpers.js';

describe('Workspace CRUD (ADR-0008, issue #41)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('GET /api/workspaces returns the boot-time default Workspace (issue #39)', async () => {
    const { status, body } = await server.api('GET', '/api/workspaces');
    expect(status).toBe(200);
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0].name).toBe('Default');
    expect(typeof body.workspaces[0].workingDir).toBe('string');
    expect(body.workspaces[0].workingDir.length).toBeGreaterThan(0);
    expect(typeof body.workspaces[0].id).toBe('number');
  });

  it('creates a Workspace at a real directory and rejects a non-existent path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-workspace-'));
    const created = await server.api('POST', '/api/workspaces', { name: 'Side project', workingDir: dir });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Side project', workingDir: dir });

    const missing = await server.api('POST', '/api/workspaces', {
      name: 'Nowhere',
      workingDir: join(dir, 'does-not-exist'),
    });
    expect(missing.status).toBe(400);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a duplicate absolute path on create and on update', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'harmonic-workspace-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'harmonic-workspace-b-'));
    const a = await server.api('POST', '/api/workspaces', { name: 'A', workingDir: dirA });
    expect(a.status).toBe(201);

    const dupCreate = await server.api('POST', '/api/workspaces', { name: 'A again', workingDir: dirA });
    expect(dupCreate.status).toBe(409);

    const b = await server.api('POST', '/api/workspaces', { name: 'B', workingDir: dirB });
    expect(b.status).toBe(201);
    const dupUpdate = await server.api('PATCH', `/api/workspaces/${b.body.id}`, { workingDir: dirA });
    expect(dupUpdate.status).toBe(409);

    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('renames a Workspace and repoints its Working Directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-workspace-rename-'));
    const created = await server.api('POST', '/api/workspaces', { name: 'Old name', workingDir: dir });
    expect(created.status).toBe(201);

    const renamed = await server.api('PATCH', `/api/workspaces/${created.body.id}`, { name: 'New name' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'New name', workingDir: dir });

    const dir2 = mkdtempSync(join(tmpdir(), 'harmonic-workspace-rename2-'));
    const repointed = await server.api('PATCH', `/api/workspaces/${created.body.id}`, { workingDir: dir2 });
    expect(repointed.status).toBe(200);
    expect(repointed.body.workingDir).toBe(dir2);

    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });

  it('404s a PATCH/GET on an unknown Workspace id', async () => {
    expect((await server.api('GET', '/api/workspaces/999999')).status).toBe(404);
    expect((await server.api('PATCH', '/api/workspaces/999999', { name: 'x' })).status).toBe(404);
  });
});

describe('Task/Conversation binding + scoping (issue #41)', () => {
  let server: TestServer;
  let workspaceA: number;
  let workspaceB: number;
  let dirB: string;

  beforeAll(async () => {
    server = await startServer();
    dirB = mkdtempSync(join(tmpdir(), 'harmonic-workspace-b-'));
    const defaultWs = await server.api('GET', '/api/workspaces');
    workspaceA = defaultWs.body.workspaces[0].id;
    const created = await server.api('POST', '/api/workspaces', { name: 'B', workingDir: dirB });
    workspaceB = created.body.id;
  });
  afterAll(async () => {
    await server.close();
    rmSync(dirB, { recursive: true, force: true });
  });

  it('a Task created with no workspaceId lands in the default (earliest) Workspace, carrying it on the payload', async () => {
    const { status, body } = await server.api('POST', '/api/tasks', { prompt: 'Unscoped task' });
    expect(status).toBe(201);
    expect(body.workspaceId).toBe(workspaceA);
  });

  it('a Task created with an explicit workspaceId binds to it and defaults workingDir from it', async () => {
    const { status, body } = await server.api('POST', '/api/tasks', {
      prompt: 'Scoped to B',
      workspaceId: workspaceB,
    });
    expect(status).toBe(201);
    expect(body.workspaceId).toBe(workspaceB);
    expect(body.workingDir).toBe(dirB);
  });

  it('rejects an unknown workspaceId on task creation', async () => {
    const { status } = await server.api('POST', '/api/tasks', { prompt: 'Nope', workspaceId: 999999 });
    expect(status).toBe(400);
  });

  it('GET /api/tasks?workspaceId= scopes the list to that Workspace only', async () => {
    const scoped = await server.api('GET', `/api/tasks?workspaceId=${workspaceB}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.tasks.length).toBeGreaterThan(0);
    expect(scoped.body.tasks.every((t: any) => t.workspaceId === workspaceB)).toBe(true);
  });

  it('a Conversation created with an explicit workspaceId binds to it and defaults workingDir from it', async () => {
    const { status, body } = await server.api('POST', '/api/conversations', {
      harness: 'claude',
      workspaceId: workspaceB,
    });
    expect(status).toBe(201);
    expect(body.workspaceId).toBe(workspaceB);
    expect(body.workingDir).toBe(dirB);
  });

  it('/api/stats?workspaceId= scopes run/cost totals to that Workspace', async () => {
    const scoped = await server.api('GET', `/api/stats?workspaceId=${workspaceA}`);
    expect(scoped.status).toBe(200);
    // Nothing has run yet in either Workspace — the point is the endpoint
    // accepts and echoes the filter without erroring, not the count.
    expect(scoped.body.runCount).toBe(0);
  });
});
