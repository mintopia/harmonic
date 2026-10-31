import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const tries = `name: tries\ndescription: test\nvars:\n  maxAttempts: 1\n  tag: plain\nsteps:\n  - attempts:\n      max: \${{ vars.maxAttempts }}\n      steps:\n        - id: nope\n          run: exit 1\n`;

describe('workflow var overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-workflow-vars-'));
  const repo = join(root, 'repo');
  let server: TestServer;
  let workspaceId: number;

  beforeAll(async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    server = await startServer(stubHarness(), { dataDir: join(root, 'data') });
    await server.api('PUT', '/api/workflows/tries', { text: tries });
    workspaceId = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id as number;
  });
  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const create = async () => (await server.api('POST', '/api/tasks', { prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree', workflow: 'tries' })).body.id as number;
  const vars = async (id: number) => (await server.api('GET', `/api/tasks/${id}/workflow-vars`)).body;
  const attemptRuns = async (id: number) => (await server.api('GET', `/api/tasks/${id}/workflow-steps`)).body.steps.length as number;

  it('refuses Workspace overrides with a wrong type or an undeclared name', async () => {
    expect((await server.api('PATCH', `/api/workspaces/${workspaceId}`, { workflowVars: { tries: { maxAttempts: '3' } } })).status).toBe(400);
    expect((await server.api('PATCH', `/api/workspaces/${workspaceId}`, { workflowVars: { tries: { nope: 1 } } })).status).toBe(400);
    expect((await server.api('PATCH', `/api/workspaces/${workspaceId}`, { workflowVars: { missing: { a: 1 } } })).status).toBe(400);
  });

  it('applies Ticket over Workspace over default, at the pin', async () => {
    const saved = await server.api('PATCH', `/api/workspaces/${workspaceId}`, { workflowVars: { tries: { maxAttempts: 2 } } });
    expect(saved.status).toBe(200);
    expect(saved.body.workflowVars).toEqual({ tries: { maxAttempts: 2 } });

    const workspaceOnly = await create();
    expect((await vars(workspaceOnly)).vars).toEqual([
      { name: 'maxAttempts', default: 1, workspace: 2, ticket: null, value: 2, source: 'workspace' },
      { name: 'tag', default: 'plain', workspace: null, ticket: null, value: 'plain', source: 'default' },
    ]);
    await server.api('POST', `/api/tasks/${workspaceOnly}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${workspaceOnly}`)).body.state === 'escalated');
    expect(await attemptRuns(workspaceOnly)).toBe(2);
    expect((await server.api('GET', `/api/tasks/${workspaceOnly}`)).body.workflowVars).toEqual({ maxAttempts: 2, tag: 'plain' });

    const ticket = await create();
    const put = await server.api('PUT', `/api/tasks/${ticket}/workflow-vars`, { vars: { maxAttempts: 3 } });
    expect(put.status).toBe(200);
    expect(put.body.vars[0]).toMatchObject({ ticket: 3, value: 3, source: 'ticket' });
    await server.api('POST', `/api/tasks/${ticket}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${ticket}`)).body.state === 'escalated');
    expect(await attemptRuns(ticket)).toBe(3);
  });

  it('refuses Ticket overrides with a wrong type or an undeclared name', async () => {
    const id = await create();
    expect((await server.api('PUT', `/api/tasks/${id}/workflow-vars`, { vars: { maxAttempts: '5' } })).status).toBe(400);
    expect((await server.api('PUT', `/api/tasks/${id}/workflow-vars`, { vars: { nope: 5 } })).status).toBe(400);
    expect((await vars(id)).vars[0].ticket).toBeNull();
  });

  it('clears Ticket overrides with an empty object', async () => {
    const id = await create();
    await server.api('PUT', `/api/tasks/${id}/workflow-vars`, { vars: { maxAttempts: 9 } });
    const cleared = await server.api('PUT', `/api/tasks/${id}/workflow-vars`, { vars: {} });
    expect(cleared.body.vars[0]).toMatchObject({ ticket: null, source: 'workspace' });
  });

  it('refuses an override the Ticket\'s resolved workflow does not declare', async () => {
    const id = (await server.api('POST', '/api/tasks', { prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' })).body.id as number;
    expect((await server.api('PUT', `/api/tasks/${id}/workflow-vars`, { vars: { a: 1 } })).status).toBe(400);
  });
});
