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
    expect((await server.api('GET', `/api/tasks/${created.body.id}/workflow-steps`)).body).toEqual({ workflowRef: null, workflowChosen: null, outline: [], cleanupCount: 0, latestVersion: null, steps: [] });
  });
  it('keeps an in-flight Ticket on its pinned version after an edit and re-pins only on Retry', async () => {
    await server.api('PUT', '/api/workflows/evolving', { text: flow('evolving', '  - id: nope\n    run: echo v1; exit 1\n') });
    const id = (await create('evolving')).body.id as number;
    await server.api('POST', `/api/tasks/${id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${id}`)).body.state === 'escalated');
    expect((await server.api('GET', `/api/tasks/${id}`)).body.workflowRef).toBe('evolving@1');

    await server.api('PUT', '/api/workflows/evolving', { text: flow('evolving', '  - id: ok\n    run: echo v2\n') });
    const stale = (await server.api('GET', `/api/tasks/${id}/workflow-steps`)).body;
    expect(stale).toMatchObject({ workflowRef: 'evolving@1', latestVersion: 2 });
    expect(stale.steps).toEqual([expect.objectContaining({ stepId: 'nope', outcome: 'fail' })]);

    expect((await server.api('POST', `/api/tasks/${id}/retry`, { guidance: 'again', startNow: true })).status).toBeLessThan(300);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${id}`)).body.state === 'done');
    const task = (await server.api('GET', `/api/tasks/${id}`)).body;
    expect(task).toMatchObject({ workflowRef: 'evolving@2', workflowChosen: 'explicit' });
    expect((await server.api('GET', `/api/tasks/${id}/workflow-steps`)).body.steps).toEqual([expect.objectContaining({ stepId: 'ok', outcome: 'pass' })]);
  });

  it('assigns the global default workflow to a Ticket with no explicit choice', async () => {
    expect((await server.api('PATCH', '/api/config', { defaults: { workflow: 'nonexistent' } })).status).toBe(400);
    expect((await server.api('PATCH', '/api/config', { defaults: { workflow: 'greet' } })).status).toBe(200);
    try {
      const id = (await create()).body.id as number;
      await server.api('POST', `/api/tasks/${id}/run`);
      await waitFor(async () => (await server.api('GET', `/api/tasks/${id}`)).body.state === 'done');
      expect((await server.api('GET', `/api/tasks/${id}`)).body).toMatchObject({ workflowRef: 'greet@1', workflowChosen: 'global' });
    } finally {
      await server.api('PATCH', '/api/config', { defaults: { workflow: null } });
    }
  });
  it('unpins a Ticket on Retry when nothing resolves a workflow any more', async () => {
    await server.api('PATCH', '/api/config', { defaults: { workflow: 'failing' } });
    const id = (await create()).body.id as number;
    await server.api('POST', `/api/tasks/${id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${id}`)).body.state === 'escalated');
    expect((await server.api('GET', `/api/tasks/${id}`)).body).toMatchObject({ workflowRef: 'failing@1', workflowChosen: 'global' });
    await server.api('PATCH', '/api/config', { defaults: { workflow: null } });
    expect((await server.api('POST', `/api/tasks/${id}/retry`, { guidance: 'again', startNow: false })).status).toBeLessThan(300);
    expect((await server.api('GET', `/api/tasks/${id}`)).body).toMatchObject({ workflowRef: null, workflowChosen: null, workflowLabel: null });
  });
  it('validates Workflow Labels and Workspace workflow overrides against the library', async () => {
    const bad = (body: object) => server.api('PATCH', '/api/config', body);
    expect((await bad({ workflowLabels: [{ label: 'bug', workflow: 'nonexistent' }] })).status).toBe(400);
    expect((await bad({ workflowLabels: [{ label: 'bug', workflow: 'greet' }, { label: 'BUG', workflow: 'greet' }] })).status).toBe(400);
    expect((await bad({ workflowLabels: [{ label: 'bug', workflow: 'greet' }] })).body.workflowLabels).toEqual([{ label: 'bug', workflow: 'greet' }]);
    const wsId = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id as number;
    const patch = (body: object) => server.api('PATCH', `/api/workspaces/${wsId}`, body);
    expect((await patch({ workflow: 'nonexistent' })).status).toBe(400);
    expect((await patch({ workflowLabels: [{ kind: 'local', enabled: true, workflowLabel: { label: 'Bug', workflow: 'greet' } }] })).status).toBe(400);
    const ok = await patch({ workflow: 'greet', workflowLabels: [{ kind: 'global', ref: 'bug', enabled: false }, { kind: 'local', enabled: true, workflowLabel: { label: 'docs', workflow: 'failing' } }] });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ workflow: 'greet', workflowLabels: [{ kind: 'global', ref: 'bug', enabled: false }, expect.objectContaining({ kind: 'local' })] });
    await patch({ workflow: null, workflowLabels: null });
    await bad({ workflowLabels: [] });
  });
});
