import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inBlock, startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const flow = (name: string, steps: string): string => `name: ${name}\ndescription: test\nsteps:\n${inBlock(steps)}`;

describe('a Ticket with a chosen workflow', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-workflow-run-'));
  const repo = join(root, 'repo');
  let server: TestServer;

  beforeAll(async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    server = await startServer(stubHarness(), { dataDir: join(root, 'data') });
    await server.api('PUT', '/api/workflows/greet', { text: flow('greet', '  - id: hello\n    run: echo hello\n') });
    await server.api('PUT', '/api/workflows/failing', { text: flow('failing', '  - id: nope\n    run: echo broken; exit 1\n') });
  });
  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const create = (workflow?: string) =>
    server.api('POST', '/api/tasks', { prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree', ...(workflow ? { workflow } : {}) });

  it('refuses a workflow that is not in the library', async () => {
    const res = await create('nonexistent');
    expect(res.status).toBe(400);
  });

  it('is unpinned until it starts, then runs its steps and finishes', async () => {
    const created = await create('greet');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ workflowRef: null, workflowChosen: null });
    const id = created.body.id as number;
    expect((await server.api('GET', `/api/tasks/${id}/workflow-steps`)).body.steps).toEqual([]);

    expect((await server.api('POST', `/api/tasks/${id}/run`)).status).toBe(201);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${id}`)).body.state === 'done');

    const task = (await server.api('GET', `/api/tasks/${id}`)).body;
    expect(task).toMatchObject({ workflowRef: 'greet@1', workflowChosen: 'explicit' });
    const { body } = await server.api('GET', `/api/tasks/${id}/workflow-steps`);
    expect(body.workflowRef).toBe('greet@1');
    expect(body).toMatchObject({ outline: [{ id: 'hello', children: [] }], cleanupCount: 0 });
    expect(body.steps).toEqual([
      expect.objectContaining({ stepId: 'hello', action: 'run', position: 0, outcome: 'pass', outputs: { stdout: 'hello\n', exitCode: 0 } }),
    ]);
  });

  it('escalates the Ticket with the captured output when a step fails', async () => {
    const id = (await create('failing')).body.id as number;
    await server.api('POST', `/api/tasks/${id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${id}`)).body.state === 'escalated');
    const task = (await server.api('GET', `/api/tasks/${id}`)).body;
    expect(task.escalationReason).toContain('broken');
    expect((await server.api('GET', `/api/tasks/${id}/workflow-steps`)).body.steps[0]).toMatchObject({ outcome: 'fail', outputs: { exitCode: 1 } });
  });

  it('leaves a Ticket without a workflow unpinned with no steps', async () => {
    const created = await create();
    expect(created.body).toMatchObject({ workflowRef: null, workflowChosen: null });
    expect((await server.api('GET', `/api/tasks/${created.body.id}/workflow-steps`)).body).toEqual({ workflowRef: null, workflowChosen: null, outline: [], cleanupCount: 0, steps: [] });
  });
});
