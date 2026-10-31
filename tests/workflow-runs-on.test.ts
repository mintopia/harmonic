import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkflowLibrary } from '../src/domain/workflow-library-store.js';
import { parseWorkflow } from '../src/domain/workflow.js';
import { directWorkspacesUsing } from '../src/execution/workspace-execution-targets.js';
import { inBlock, startServer, type TestServer } from './helpers.js';

const flow = (name: string, top = '', step = '') =>
  `name: ${name}\ndescription: A test flow\n${top}steps:\n${inBlock(`  - id: build\n    run: npm test\n${step}`)}`;

const target = {
  name: 'k8s-prod',
  authMethod: 'kubeconfig',
  namespace: 'harmonic-agents',
  defaultImage: 'ghcr.io/mintopia/harmonic-harnesses:2.19.0',
  cpu: '2',
  memory: '4Gi',
  concurrencyLimit: 4,
  repositoryProxyUrl: 'https://repo-proxy.example.test',
};

describe('runs_on and image in the workflow schema', () => {
  it('accepts workflow-level and step-level runs_on and image', () => {
    const def = parseWorkflow(flow('x', 'runs_on: k8s-prod\nimage: img:1\n', '    runs_on: local\n    image: img:2\n'));
    expect(def.steps[0]).toMatchObject({ runs_on: 'local', image: 'img:2' });
  });
});

describe('save-time refusals', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-runs-on-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const library = (direct: string[]) =>
    new WorkflowLibrary(root, {
      targetCheck: () => ({
        known: (name) => name === 'local' || name === 'k8s-prod',
        directWorkspaces: () => direct,
      }),
    });

  it('refuses an unknown target at its line and column, with the exact message', async () => {
    await expect(library([]).save('a', flow('a', 'runs_on: nowhere\n'))).rejects.toMatchObject({
      message: "workflow refused: 3:10 runs_on: unknown Execution Target 'nowhere'",
      issues: [{ message: "runs_on: unknown Execution Target 'nowhere'", line: 3, column: 10 }],
    });
  });

  it('refuses an unknown step-level target', async () => {
    await expect(library([]).save('b', flow('b', '', '    runs_on: nowhere\n'))).rejects.toThrow("runs_on: unknown Execution Target 'nowhere'");
  });

  it('refuses a Kubernetes target when a direct-mode Workspace would use the workflow', async () => {
    await expect(library(['api']).save('c', flow('c', 'runs_on: k8s-prod\n'))).rejects.toMatchObject({
      issues: [
        {
          message:
            "runs_on: Kubernetes Execution Target 'k8s-prod' is not available to Workspace 'api' in direct mode, which would use this workflow as its default or through a Workflow Label. Switch the Workspace to worktree Isolation Mode first.",
          line: 3,
          column: 10,
        },
      ],
    });
  });

  it('saves a workflow mixing local and Kubernetes steps', async () => {
    const entry = await library([]).save('mixed', flow('mixed', 'runs_on: local\n', '    runs_on: k8s-prod\n'));
    expect(entry.version).toBe(1);
  });

  it('allows a local-only workflow while a direct-mode Workspace uses it', async () => {
    await library(['api']).save('plain', flow('plain', 'runs_on: local\n'));
  });
});

describe('directWorkspacesUsing', () => {
  const config = { defaults: { isolationMode: 'worktree', workflow: null }, workflowLabels: [{ label: 'infra', workflow: 'wf' }] } as unknown as Parameters<typeof directWorkspacesUsing>[2];
  const ws = (over: Record<string, unknown>) => ({ name: 'w', isolationMode: 'direct', workflow: null, workflowLabels: null, ...over }) as never;

  it('matches the Workspace default, the global default and Workflow Labels, only in direct mode', () => {
    expect(directWorkspacesUsing('wf', [ws({ name: 'a', workflow: 'wf' }), ws({ name: 'b' }), ws({ name: 'c', isolationMode: 'worktree', workflow: 'wf' })], config)).toEqual(['a', 'b']);
    expect(directWorkspacesUsing('wf', [ws({ name: 'a' })], { ...config, workflowLabels: [] })).toEqual([]);
    expect(directWorkspacesUsing('wf', [ws({ name: 'a' })], { workflowLabels: [], defaults: { isolationMode: 'worktree', workflow: 'wf' } } as unknown as typeof config)).toEqual(['a']);
  });
});

describe('assignment and save through the API', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'harmonic-runs-on-api-'));
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer({}, { dataDir: join(dataRoot, 'data') });
    expect((await server.api('POST', '/api/execution-targets', target)).status).toBe(201);
  });
  afterAll(async () => {
    await server?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('refuses an unknown target on PUT with the issue in the body', async () => {
    const res = await server.api('PUT', '/api/workflows/bad', { text: flow('bad', 'runs_on: nowhere\n') });
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([expect.objectContaining({ message: "runs_on: unknown Execution Target 'nowhere'", line: 3 })]);
  });

  it('refuses assigning a Kubernetes workflow to a direct Ticket, and allows worktree', async () => {
    expect((await server.api('PUT', '/api/workflows/remote', { text: flow('remote', 'runs_on: k8s-prod\n') })).status).toBe(200);
    const direct = await server.api('POST', '/api/tasks', { prompt: 'p', workflow: 'remote', isolationMode: 'direct' });
    expect(direct.status).toBe(400);
    expect(direct.body.error.message).toBe(
      "Workflow 'remote' runs on Kubernetes Execution Target 'k8s-prod', which is not available to a Ticket in direct mode. Switch the Isolation Mode to worktree first.",
    );
    const worktree = await server.api('POST', '/api/tasks', { prompt: 'p', workflow: 'remote', isolationMode: 'worktree' });
    expect(worktree.status).toBe(201);
  });
});
