import { describe, it, expect, afterEach } from 'vitest';
import { startServer, type TestServer } from './helpers.js';
import { assertWorkspaceExecutionTargets } from '../src/execution/workspace-execution-targets.js';
import type { WorkspaceRow } from '../src/db/schema.js';

const target = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  authMethod: 'in-cluster',
  namespace: 'harmonic-agents',
  defaultImage: 'ghcr.io/mintopia/harmonic-harnesses:2.19.0',
  cpu: '2',
  memory: '4Gi',
  concurrencyLimit: 4,
  repositoryProxyUrl: 'https://repo-proxy.example.test',
  ...over,
});

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const start = async () => {
  server = await startServer();
  await server.api('POST', '/api/execution-targets', target('k8s-prod'));
  await server.api('POST', '/api/execution-targets', target('k8s-staging', { enabled: false }));
  const id = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id as number;
  return { s: server, id };
};

describe('assertWorkspaceExecutionTargets', () => {
  const workspace = { id: 1, workingDir: '/tmp/none', codeRepository: null, isolationMode: null, executionTargets: null } as unknown as WorkspaceRow;
  const targets = { find: async (name: string) => (name === 'k8s-prod' ? ({ name } as never) : null) };
  const deps = (repo: 'github' | null) => ({ targets, globalIsolationMode: 'worktree' as const, resolveRepository: async () => repo });

  it('a Workspace without a Code Repository cannot enable a Kubernetes target', async () => {
    await expect(assertWorkspaceExecutionTargets(workspace, { executionTargets: ['k8s-prod'] }, deps(null))).rejects.toThrow(/k8s-prod.*Code Repository/);
  });

  it('refuses a Workspace whose resolved Isolation Mode is direct, naming direct and worktree', async () => {
    await expect(assertWorkspaceExecutionTargets(workspace, { executionTargets: ['k8s-prod'], isolationMode: 'direct' }, deps('github'))).rejects.toThrow(/direct.*worktree/);
    await expect(
      assertWorkspaceExecutionTargets(workspace, { executionTargets: ['k8s-prod'] }, { ...deps('github'), globalIsolationMode: 'direct' }),
    ).rejects.toThrow(/direct.*worktree/);
  });

  it('accepts a usable Workspace, normalizes the list, and never refuses local or an inherited list', async () => {
    const patch = { executionTargets: ['local', 'k8s-prod', 'k8s-prod'] };
    await assertWorkspaceExecutionTargets(workspace, patch, deps('github'));
    expect(patch.executionTargets).toEqual(['k8s-prod']);
    await assertWorkspaceExecutionTargets(workspace, { executionTargets: ['local'] }, deps(null));
    await assertWorkspaceExecutionTargets(workspace, { executionTargets: null }, deps(null));
    await assertWorkspaceExecutionTargets(workspace, { isolationMode: 'direct' }, deps(null));
  });

  it('refuses removing the Code Repository or switching to direct while a Kubernetes target is allowed', async () => {
    const allowing = { ...workspace, codeRepository: 'github', executionTargets: ['k8s-prod'] } as unknown as WorkspaceRow;
    await expect(assertWorkspaceExecutionTargets(allowing, { codeRepository: null }, deps(null))).rejects.toThrow(/Code Repository/);
    await expect(assertWorkspaceExecutionTargets(allowing, { isolationMode: 'direct' }, deps('github'))).rejects.toThrow(/direct/);
    await assertWorkspaceExecutionTargets(allowing, { isolationMode: 'worktree' }, deps('github'));
  });

  it('refuses an unknown name but tolerates one already stored', async () => {
    await expect(assertWorkspaceExecutionTargets(workspace, { executionTargets: ['ghost'] }, deps('github'))).rejects.toThrow(/unknown Execution Target 'ghost'/);
    const stale = { ...workspace, executionTargets: ['ghost'] } as unknown as WorkspaceRow;
    await assertWorkspaceExecutionTargets(stale, { executionTargets: ['ghost'] }, deps('github'));
  });
});

describe('PATCH /workspaces/:id executionTargets', () => {
  it('refuses a Workspace without a Code Repository with a clear message', async () => {
    const { s, id } = await start();
    const res = await s.api('PATCH', `/api/workspaces/${id}`, { executionTargets: ['k8s-prod'] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/k8s-prod/);
    expect(res.body.error.message).toMatch(/Code Repository/);
    expect((await s.api('GET', `/api/workspaces/${id}`)).body.executionTargets).toBeNull();
  });

  it('refuses direct mode, naming direct and worktree', async () => {
    const { s, id } = await start();
    const res = await s.api('PATCH', `/api/workspaces/${id}`, { codeRepository: 'github', isolationMode: 'direct', executionTargets: ['k8s-prod'] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/direct/);
    expect(res.body.error.message).toMatch(/worktree/);
  });

  it('accepts a usable Workspace, drops local, and then refuses direct mode or losing the Code Repository', async () => {
    const { s, id } = await start();
    const ok = await s.api('PATCH', `/api/workspaces/${id}`, { codeRepository: 'github', isolationMode: 'worktree', executionTargets: ['local', 'k8s-prod'] });
    expect(ok.status).toBe(200);
    expect(ok.body.executionTargets).toEqual(['k8s-prod']);
    expect((await s.api('PATCH', `/api/workspaces/${id}`, { isolationMode: 'direct' })).status).toBe(400);
    expect((await s.api('PATCH', `/api/workspaces/${id}`, { codeRepository: null })).status).toBe(400);
    expect((await s.api('PATCH', `/api/workspaces/${id}`, { executionTargets: null })).body.executionTargets).toBeNull();
    expect((await s.api('PATCH', `/api/workspaces/${id}`, { isolationMode: 'direct' })).status).toBe(200);
  });

  it('refuses unknown names and accepts a globally disabled one, flagging it ineffective', async () => {
    const { s, id } = await start();
    expect((await s.api('PATCH', `/api/workspaces/${id}`, { codeRepository: 'github', executionTargets: ['ghost'] })).status).toBe(400);
    const ok = await s.api('PATCH', `/api/workspaces/${id}`, { codeRepository: 'github', isolationMode: 'worktree', executionTargets: ['k8s-staging'] });
    expect(ok.status).toBe(200);
    const view = (await s.api('GET', `/api/workspaces/${id}/execution-targets`)).body;
    expect(view).toMatchObject({ restricted: true, codeRepository: 'github', isolationMode: 'worktree' });
    const byName = Object.fromEntries(view.targets.map((t: { name: string }) => [t.name, t]));
    expect(byName.local).toMatchObject({ allowed: true, effective: true });
    expect(byName['k8s-staging']).toMatchObject({ allowed: true, globallyEnabled: false, effective: false });
    expect(byName['k8s-staging'].ineffectiveReason).toMatch(/Disabled globally/);
    expect(byName['k8s-prod']).toMatchObject({ allowed: false, effective: false, refusal: null });
  });

  it('reports the refusal per target for a Workspace that cannot use Kubernetes', async () => {
    const { s, id } = await start();
    const view = (await s.api('GET', `/api/workspaces/${id}/execution-targets`)).body;
    expect(view).toMatchObject({ restricted: false, codeRepository: null });
    const prod = view.targets.find((t: { name: string }) => t.name === 'k8s-prod');
    expect(prod.refusal).toMatch(/Code Repository/);
    expect((await s.api('GET', '/api/workspaces/99999/execution-targets')).status).toBe(404);
  });

  it('keeps allow-lists live when a target is renamed or deleted', async () => {
    const { s, id } = await start();
    await s.api('PATCH', `/api/workspaces/${id}`, { codeRepository: 'github', isolationMode: 'worktree', executionTargets: ['k8s-prod', 'k8s-staging'] });
    await s.api('PATCH', '/api/execution-targets/k8s-prod', { name: 'k8s-main' });
    expect((await s.api('GET', `/api/workspaces/${id}`)).body.executionTargets).toEqual(['k8s-main', 'k8s-staging']);
    await s.api('DELETE', '/api/execution-targets/k8s-staging');
    expect((await s.api('GET', `/api/workspaces/${id}`)).body.executionTargets).toEqual(['k8s-main']);
  });
});
