import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryProxy } from '../../src/repository-proxy/server.js';
import { inBlock, startServer, waitFor, type TestServer } from '../helpers.js';

const kubeconfigPath = process.env.HARMONIC_KIND_KUBECONFIG;
const NAMESPACE = 'harmonic-agents';
const IMAGE = process.env.HARMONIC_KIND_AGENT_IMAGE ?? 'node:22-bookworm';
const TOKEN = 'kind-fake-oauth-token';
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
const agentSource = readFileSync(resolve(import.meta.dirname, '../fixtures/pod-acp-agent.mjs'), 'utf8');

describe.skipIf(!kubeconfigPath)('a workflow mixing local and Kubernetes agent steps on a real kind cluster', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-kind-mixed-'));
  const upstream = process.env.HARMONIC_KIND_UPSTREAM ?? join(root, 'upstream.git');
  const repo = join(root, 'repo');
  let server: TestServer;
  let proxy: Server | undefined;

  const agent = (id: string, extra = ''): string => `  - id: ${id}\n${extra}    uses: agent\n    with:\n      harness: claude\n      model: stub-model\n      prompt: do the work\n`;
  const mixed = `name: mixed\ndescription: kind\nimage: ${IMAGE}\nsteps:\n${inBlock(agent('first') + agent('second', '    runs_on: kind\n') + agent('third') + '  - id: keep\n    uses: artifact\n')}`;

  beforeAll(async () => {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', upstream]);
    execFileSync('git', ['clone', '-q', upstream, repo]);
    writeFileSync(join(repo, 'base.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'branch', '-M', 'main');
    git(repo, 'push', '-q', 'origin', 'main');

    const harness = { command: 'node', args: ['--input-type=module', '-e', agentSource], models: [{ id: 'stub-model' }], defaultModel: 'stub-model', cacheWarmSeconds: 300 };
    server = await startServer({ harnesses: { claude: harness, codex: { ...harness } }, chat: { harness: 'claude', model: 'stub-model' } } as never, { dataDir: join(root, 'data') });
    let proxyUrl = process.env.HARMONIC_KIND_PROXY_URL;
    const create = await server.api('POST', '/api/execution-targets', {
      name: 'kind', authMethod: 'kubeconfig', namespace: NAMESPACE, defaultImage: IMAGE, cpu: '250m', memory: '256Mi', concurrencyLimit: 2,
      repositoryProxyUrl: proxyUrl ?? 'http://pending.invalid',
    });
    expect(create.status).toBe(201);
    await server.api('PUT', '/api/execution-targets/kind/kubeconfig', { kubeconfig: readFileSync(kubeconfigPath!, 'utf8') });
    await server.api('PUT', '/api/execution-targets/kind/credentials/claude', { value: TOKEN });
    const { key } = (await server.api('POST', '/api/execution-targets/kind/rotate-proxy-key')).body as { key: string };
    if (proxyUrl === undefined) {
      proxy = createRepositoryProxy({ key: process.env.HARMONIC_KIND_PROXY_KEY ?? key });
      await new Promise<void>((done) => proxy!.listen(0, '0.0.0.0', done));
      proxyUrl = `http://${process.env.HARMONIC_KIND_PROXY_HOST ?? '172.18.0.1'}:${(proxy.address() as AddressInfo).port}`;
      await server.api('PATCH', '/api/execution-targets/kind', { repositoryProxyUrl: proxyUrl });
    }
    expect((await server.api('PUT', '/api/workflows/mixed', { text: mixed })).status).toBeLessThan(300);
  }, 120_000);

  afterAll(async () => {
    proxy?.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('runs local, Kubernetes, local; each step sees the previous commits and the Ticket branch holds every checkpoint', async () => {
    const id = (await server.api('POST', '/api/tasks', { prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree', workflow: 'mixed' })).body.id as number;
    await server.api('POST', `/api/tasks/${id}/run`);
    await waitFor(async () => ['done', 'escalated'].includes((await server.api('GET', `/api/tasks/${id}`)).body.state), { timeoutMs: 300_000, intervalMs: 1000 });
    expect((await server.api('GET', `/api/tasks/${id}`)).body.state).toBe('done');
    const steps = (await server.api('GET', `/api/tasks/${id}/workflow-steps`)).body.steps as { stepId: string; outcome: string; outputs: { checkpoint?: { sha: string } } }[];
    expect(steps.map((s) => [s.stepId, s.outcome])).toEqual([['first', 'pass'], ['second', 'pass'], ['third', 'pass'], ['keep', 'pass']]);
    const branch = `refs/heads/harmonic/task-${id}`;
    expect(git(upstream, 'log', '--format=%s', branch)).toBe('agent agent-3.txt\nagent agent-2.txt\nagent agent-1.txt\nbase');
    const checkpoint = steps.find((s) => s.stepId === 'second')!.outputs.checkpoint!.sha;
    expect(git(upstream, 'rev-parse', `${branch}~1`)).toBe(checkpoint);
    expect(git(repo, 'rev-parse', branch)).toBe(git(upstream, 'rev-parse', branch));
    expect(git(repo, 'rev-parse', `${branch}~1`)).toBe(checkpoint);
  }, 360_000);
});
