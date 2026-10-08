import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpServer } from '../src/mcp/server.js';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

function archiveDirFor(dataDir: string, taskId: number): string {
  const root = join(dataDir, 'archive');
  for (const slug of readdirSync(root)) {
    const match = readdirSync(join(root, slug)).find((name) => name.startsWith(`${taskId}-`));
    if (match) return join(root, slug, match);
  }
  throw new Error(`no archive dir for task ${taskId}`);
}

const inputs = (dataDir: string, taskId: number) =>
  readFileSync(join(archiveDirFor(dataDir, taskId), 'operator-inputs.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { ts: string; actor: string; action: string; text: string | null });

describe('operator inputs are recorded (#732)', () => {
  let server: TestServer;
  const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-operator-inputs-'));

  beforeAll(async () => {
    server = await startServer({ ...stubHarness(), maxAttempts: 1, autoRunner: { enabled: false, maxConcurrentAttempts: 1 } }, { dataDir });
  });
  afterAll(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const facts = async (taskId: number) =>
    ((await server.api('GET', `/api/tasks/${taskId}/timeline`)).body.events as Array<{ data?: { payload?: Record<string, unknown> } }>)
      .map((event) => ({ data: event.data?.payload ?? {} }))
      .filter((event) => String(event.data.event).startsWith('operator-'));

  async function escalatedTask(): Promise<number> {
    const created = await server.api('POST', '/api/tasks', { prompt: 'needs a human' });
    await server.app.ctx.tasks.escalate(created.body.id, 'escalated to human: test');
    return created.body.id;
  }

  async function strandedWorking(): Promise<number> {
    const created = await server.api('POST', '/api/tasks', { prompt: 'x' });
    const taskId = created.body.id as number;
    await server.app.ctx.tasks.setState(taskId, 'ready');
    await server.app.ctx.tasks.setState(taskId, 'working');
    await server.app.ctx.attempts.create(taskId);
    return taskId;
  }

  it('records Steer with its text', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ waitForSteer: true }) });
    const taskId = created.body.id as number;
    await server.api('POST', `/api/tasks/${taskId}/run`);
    await waitFor(async () => ((await server.app.ctx.attempts.listForTask(taskId)).length > 0 ? true : undefined));
    await waitFor(async () =>
      (await server.api('POST', `/api/tasks/${taskId}/steer`, { text: 'check the tests first' })).status === 200 ? true : undefined,
    );
    expect(inputs(dataDir, taskId)).toEqual([{ ts: expect.any(String), actor: 'operator', action: 'steer', text: 'check the tests first' }]);
  });

  it('records Pause and Resume', async () => {
    const taskId = await strandedWorking();
    expect((await server.api('POST', `/api/tasks/${taskId}/pause`)).status).toBe(200);
    expect((await server.api('POST', `/api/tasks/${taskId}/resume`)).status).toBe(200);
    expect(inputs(dataDir, taskId).map(({ actor, action, text }) => ({ actor, action, text }))).toEqual([
      { actor: 'operator', action: 'pause', text: null },
      { actor: 'operator', action: 'resume', text: null },
    ]);
  });

  it('does not record a refused input', async () => {
    const taskId = await escalatedTask();
    expect((await server.api('POST', `/api/tasks/${taskId}/pause`)).status).toBe(409);
    expect(() => archiveDirFor(dataDir, taskId)).toThrow();
  });

  it('records Reject with its guidance', async () => {
    const taskId = await escalatedTask();
    const rejected = await server.api('POST', `/api/tasks/${taskId}/retry`, { guidance: 'share the limiter across workers' });
    expect(rejected.status).toBe(200);
    expect(inputs(dataDir, taskId)).toMatchObject([{ actor: 'operator', action: 'retry', text: 'share the limiter across workers' }]);
  });

  it('records Close with its reason and adds a timeline Fact', async () => {
    const taskId = await escalatedTask();
    const closed = await server.api('POST', `/api/tasks/${taskId}/close`, { reason: '  not worth doing  ' });
    expect(closed.status).toBe(200);
    expect(inputs(dataDir, taskId)).toMatchObject([{ actor: 'operator', action: 'close', text: 'not worth doing' }]);
    expect(await facts(taskId)).toMatchObject([{ data: { event: 'operator-closed', actor: 'operator', reason: 'not worth doing' } }]);
  });

  it('still closes with no body and records a null reason', async () => {
    const taskId = await escalatedTask();
    expect((await server.api('POST', `/api/tasks/${taskId}/close`)).status).toBe(200);
    expect(await facts(taskId)).toMatchObject([{ data: { event: 'operator-closed', reason: null } }]);
  });

  it('records Cancel with its reason on the timeline and in the Archive', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'obsolete' });
    const taskId = created.body.id as number;
    const cancelled = await server.api('POST', `/api/tasks/${taskId}/cancel`, { reason: 'superseded' });
    expect(cancelled.status).toBe(200);
    expect(inputs(dataDir, taskId)).toMatchObject([{ actor: 'operator', action: 'cancel', text: 'superseded' }]);
    expect(await facts(taskId)).toMatchObject([{ data: { event: 'operator-cancelled', actor: 'operator', reason: 'superseded' } }]);
  });

  it('records Cancel on every dependent Task when cascading', async () => {
    const parent = (await server.api('POST', '/api/tasks', { prompt: 'parent' })).body.id as number;
    const child = (await server.api('POST', '/api/tasks', { prompt: 'child', dependsOn: [parent] })).body.id as number;
    expect((await server.api('POST', `/api/tasks/${parent}/cancel`, { withDependents: true, reason: 'cascade' })).status).toBe(200);
    expect(inputs(dataDir, parent)).toMatchObject([{ action: 'cancel', text: 'cascade' }]);
    expect(inputs(dataDir, child)).toMatchObject([{ actor: 'operator', action: 'cancel', text: 'cascade' }]);
    expect(await facts(child)).toMatchObject([{ data: { event: 'operator-cancelled', actor: 'operator', reason: 'cascade' } }]);
  });

  it('records an MCP cancel_task reason as the agent', async () => {
    const taskId = (await server.api('POST', '/api/tasks', { prompt: 'mcp cancel' })).body.id as number;
    const mcp = buildMcpServer(server.app.ctx, { scope: null, attempt: null, task: null, workspace: null }) as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    };
    await mcp._registeredTools.cancel_task!.handler({ taskId, reason: 'duplicate' }, {});
    expect(inputs(dataDir, taskId)).toMatchObject([{ actor: 'agent', action: 'cancel', text: 'duplicate' }]);
    expect(await facts(taskId)).toMatchObject([{ data: { event: 'operator-cancelled', actor: 'agent', reason: 'duplicate' } }]);
  });

  it('keeps the Archive on disk and marks the deletion when a Task is deleted', async () => {
    const taskId = (await server.api('POST', '/api/tasks', { prompt: 'doomed' })).body.id as number;
    await server.api('POST', `/api/tasks/${taskId}/cancel`, { reason: 'going away' });
    const archiveDir = archiveDirFor(dataDir, taskId);
    expect((await server.api('DELETE', `/api/tasks/${taskId}`)).status).toBe(200);
    expect((await server.api('GET', `/api/tasks/${taskId}`)).status).toBe(404);
    expect(existsSync(join(archiveDir, 'operator-inputs.jsonl'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(archiveDir, 'archive.json'), 'utf8'));
    expect(manifest.deleted).toEqual({ at: expect.any(String), actor: 'operator' });
  });

  it('marks every Task Archive deleted when its Workspace is deleted', async () => {
    const ws = await server.app.ctx.workspaces.create({ name: 'Doomed Board', workingDir: dataDir });
    const task = (await server.api('POST', '/api/tasks', { prompt: 'on the doomed board', workspaceId: ws.id })).body;
    await server.app.ctx.archive.recordOperatorInput(await server.app.ctx.tasks.get(task.id), { actor: 'operator', action: 'pause', text: null });
    const archiveDir = archiveDirFor(dataDir, task.id);
    expect((await server.api('DELETE', `/api/workspaces/${ws.id}`)).status).toBe(204);
    expect(existsSync(join(archiveDir, 'operator-inputs.jsonl'))).toBe(true);
    expect(JSON.parse(readFileSync(join(archiveDir, 'archive.json'), 'utf8')).deleted).toEqual({ at: expect.any(String), actor: 'operator' });
  });

  it('does not create an Archive when deleting a Task that never had one', async () => {
    const taskId = (await server.api('POST', '/api/tasks', { prompt: 'never archived' })).body.id as number;
    expect((await server.api('DELETE', `/api/tasks/${taskId}`)).status).toBe(200);
    expect(() => archiveDirFor(dataDir, taskId)).toThrow();
  });
});

describe('Accept is recorded (#732)', () => {
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  let server: TestServer;
  let repoDir: string;
  const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-operator-accept-'));

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'harmonic-operator-accept-repo-'));
    execFileSync('git', ['init', '-b', 'main', repoDir], { encoding: 'utf8' });
    git(repoDir, 'config', 'user.name', 'Test');
    git(repoDir, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repoDir, 'README.md'), '# repo\n');
    git(repoDir, 'add', '-A');
    git(repoDir, 'commit', '-m', 'init');
    server = await startServer(stubHarness(), { dataDir });
    const ws = (await server.app.ctx.workspaces.list())[0]!;
    await server.app.ctx.workspaces.update(ws.id, {
      workingDir: repoDir,
      isolationMode: 'worktree',
      taskPreMergeCommands: [],
      taskPreMergeCritics: null,
    });
    await server.app.ctx.settingsStore.updateGlobal({ maxAttempts: 1 });
  });
  afterAll(async () => {
    await server.close();
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('shows an Accept Fact on the timeline and appends to operator-inputs.jsonl', async () => {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'accepted.txt': 'work\n' }, exit: 'crash-before-response' }),
      workingDir: repoDir,
      isolationMode: 'worktree',
    });
    const taskId = created.body.id as number;
    await server.api('POST', `/api/tasks/${taskId}/run`);
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'escalated' ? true : undefined));

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(200);
    expect(inputs(dataDir, taskId)).toMatchObject([{ actor: 'operator', action: 'accept', text: null }]);
    const events = (await server.api('GET', `/api/tasks/${taskId}/timeline`)).body.events as Array<{ data?: { payload?: Record<string, unknown> } }>;
    expect(events.map((e) => e.data?.payload).filter((p) => p?.event === 'operator-accepted')).toEqual([
      { event: 'operator-accepted', actor: 'operator', reason: null },
    ]);
  });
});
