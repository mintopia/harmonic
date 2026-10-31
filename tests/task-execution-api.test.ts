import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakePodApi, ok } from './fake-pod-api.js';
import { inBlock, startServer, waitFor, type TestServer } from './helpers.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('a Ticket\'s execution on an Execution Target', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-task-execution-'));
  const repo = join(root, 'repo');
  let server: TestServer;
  const pods = new FakePodApi(async (argv) => (argv.at(-1)!.includes('ls-remote') ? ok('\n') : argv.at(-1)!.includes('--force origin') ? ok('abc123 0\n') : ok('hello\n')));

  beforeAll(async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', join(root, 'origin.git'));
    server = await startServer(undefined, { dataDir: join(root, 'data'), podApiFactory: () => pods });
  });
  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('is null for a Ticket that ran locally', async () => {
    const { body } = await server.api('POST', '/api/tasks', { prompt: 'p', workingDir: repo });
    expect((await server.api('GET', `/api/tasks/${body.id}`)).body.execution).toBeNull();
  });

  it('shows the target, pod and state once recorded, and keeps them after the pod is deleted', async () => {
    const { body } = await server.api('POST', '/api/tasks', { prompt: 'p', workingDir: repo });
    const execution = { target: 'k8s-prod', podName: 'harmonic-task-1-a1b2', podState: 'running', namespace: 'harmonic-agents', image: 'img:1', source: 'workflow' } as const;
    await server.app.ctx.tasks.setExecution(body.id, execution);
    expect((await server.api('GET', `/api/tasks/${body.id}`)).body.execution).toEqual(execution);
    await server.app.ctx.tasks.setExecution(body.id, { ...execution, podState: 'deleted' });
    expect((await server.api('GET', `/api/tasks/${body.id}`)).body.execution).toMatchObject({ target: 'k8s-prod', podName: 'harmonic-task-1-a1b2', podState: 'deleted' });
  });

  it('runs a Kubernetes workflow end to end: pod created for the Ticket, steps run in it, pod and Secret deleted, record kept', async () => {
    const target = { name: 'k8s-prod', authMethod: 'in-cluster', namespace: 'harmonic-agents', defaultImage: 'harnesses:1', cpu: '2', memory: '4Gi', concurrencyLimit: 2, repositoryProxyUrl: 'http://repo-proxy.test' };
    expect((await server.api('POST', '/api/execution-targets', target)).status).toBe(201);
    expect((await server.api('POST', '/api/execution-targets/k8s-prod/rotate-proxy-key')).status).toBe(200);
    const text = `name: pods\ndescription: test\nruns_on: k8s-prod\nsteps:\n${inBlock('  - id: hello\n    run: echo hello\n')}`;
    expect((await server.api('PUT', '/api/workflows/pods', { text })).status).toBe(200);
    const created = await server.api('POST', '/api/tasks', { prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree', workflow: 'pods' });
    const id = created.body.id as number;
    await server.api('POST', `/api/tasks/${id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${id}`)).body.state === 'done');

    const { execution } = (await server.api('GET', `/api/tasks/${id}`)).body;
    expect(execution).toMatchObject({ target: 'k8s-prod', podState: 'deleted', namespace: 'harmonic-agents', image: 'harnesses:1', source: 'workflow' });
    expect(execution.podName).toMatch(new RegExp(`^harmonic-task-${id}-[0-9a-f]{4}$`));
    expect(pods.calls).toEqual(expect.arrayContaining([`deletePod harmonic-agents/${execution.podName}`, `deleteSecret harmonic-agents/${execution.podName}`]));
    expect(pods.pods.size + pods.secrets.size).toBe(0);
    const steps = (await server.api('GET', `/api/tasks/${id}/workflow-steps`)).body.steps;
    expect(steps[0]).toMatchObject({ outcome: 'pass', outputs: { stdout: 'hello\n', checkpoint: { branch: `harmonic/task-${id}`, sha: 'abc123', forced: false } } });
  }, 30_000);
});
