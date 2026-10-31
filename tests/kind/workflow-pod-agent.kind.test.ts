import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const kubectl = (...args: string[]): string => execFileSync('kubectl', ['--kubeconfig', kubeconfigPath!, '-n', NAMESPACE, ...args], { encoding: 'utf8' }).trim();
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
const agentSource = readFileSync(resolve(import.meta.dirname, '../fixtures/pod-acp-agent.mjs'), 'utf8').replace('process.env.POD_AGENT_SESSION', "'1'").replace('process.env.POD_AGENT_HOLD_MS ?? 0', "'8000'");

describe.skipIf(!kubeconfigPath)('an agent step on a real kind cluster', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-kind-agent-'));
  const upstream = process.env.HARMONIC_KIND_UPSTREAM ?? join(root, 'upstream.git');
  const repo = join(root, 'repo');
  let server: TestServer;
  let proxy: Server | undefined;

  const flow = (name: string, harness: string): string =>
    `name: ${name}\ndescription: kind\nruns_on: kind\nimage: ${IMAGE}\nsteps:\n${inBlock(`  - id: build\n    uses: agent\n    with:\n      harness: ${harness}\n      model: stub-model\n      prompt: do the work\n`)}`;
  const mirrorFile = (): string => join(root, 'data', 'pod-transcripts', 'claude', 'pod-session', 'pod-session.jsonl');
  const start = async (workflow: string): Promise<number> => {
    const id = (await server.api('POST', '/api/tasks', { prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree', workflow })).body.id as number;
    await server.api('POST', `/api/tasks/${id}/run`);
    return id;
  };
  const runToDone = async (workflow: string, started?: number): Promise<number> => {
    const id = started ?? (await start(workflow));
    await waitFor(async () => ['done', 'escalated'].includes((await server.api('GET', `/api/tasks/${id}`)).body.state), { timeoutMs: 300_000, intervalMs: 1000 });
    return id;
  };

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
    await server.api('PUT', '/api/workflows/agent-claude', { text: flow('agent-claude', 'claude') });
    await server.api('PUT', '/api/workflows/agent-codex', { text: flow('agent-codex', 'codex') });
  }, 120_000);

  afterAll(async () => {
    proxy?.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('completes the ACP handshake over exec, then the agent commits in the pod and the checkpoint reaches the Ticket branch', async () => {
    const id = await runToDone('agent-claude');
    const task = (await server.api('GET', `/api/tasks/${id}`)).body;
    expect(task.state).toBe('done');
    const [step] = (await server.api('GET', `/api/tasks/${id}/workflow-steps`)).body.steps as { outcome: string; outputs: { checkpoint: { sha: string }; stdout: string } }[];
    expect(step!.outcome).toBe('pass');
    expect(git(upstream, 'rev-parse', `refs/heads/harmonic/task-${id}`)).toBe(step!.outputs.checkpoint.sha);
    expect(git(upstream, 'log', '--format=%s', `refs/heads/harmonic/task-${id}`)).toBe('agent agent-1.txt\nbase');
    expect(JSON.stringify(step)).not.toContain(TOKEN);
  }, 360_000);

  it('mirrors the in-pod session file so the transcript, Archive and Usage match a local run', async () => {
    const started = await start('agent-claude');
    await waitFor(async () => readFileSync(mirrorFile(), 'utf8').includes('h\u00e9llo'), { timeoutMs: 120_000, intervalMs: 250 }).catch(() => undefined);
    const liveText = (() => {
      try {
        return readFileSync(mirrorFile(), 'utf8');
      } catch {
        return '';
      }
    })();
    const stateWhileLive = (await server.api('GET', `/api/tasks/${started}`)).body.state;
    expect(liveText).toContain('h\u00e9llo \u2713');
    expect(liveText).not.toContain('"type":"assistant"');
    expect(stateWhileLive).not.toBe('done');
    const id = await runToDone('agent-claude', started);
    expect((await server.api('GET', `/api/tasks/${id}`)).body.state).toBe('done');
    const inPod = Buffer.from(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'h\u00e9llo \u2713 \u65e5\u672c\u8a9e' } })}\n${JSON.stringify({ type: 'assistant', message: { id: 'msg-1', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'done \u2713 \u65e5\u672c\u8a9e' }], usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } } })}\n`,
    );
    const mirror = readFileSync(mirrorFile());
    expect(mirror.equals(inPod)).toBe(true);
    const archived = readdirSync(join(root, 'data', 'archive'), { recursive: true, encoding: 'utf8' }).filter((entry) => entry.includes(`${id}-`) && entry.endsWith(join('native', 'pod-session.jsonl')));
    expect(archived).toHaveLength(1);
    expect(readFileSync(join(root, 'data', 'archive', archived[0]!)).equals(inPod)).toBe(true);
    const usage = (await server.api('GET', `/api/tasks/${id}/usage`)).body as { models: Record<string, unknown> };
    expect(usage.models['claude-sonnet-5']).toEqual({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3 });
  }, 360_000);

  it('escalates a Harness with no credential on the target and never runs it locally', async () => {
    const id = await runToDone('agent-codex');
    const task = (await server.api('GET', `/api/tasks/${id}`)).body;
    expect(task.state).toBe('escalated');
    expect(JSON.stringify(task)).toContain('has no credential for Harness Codex');
  }, 360_000);

  const podsOf = (id: number): string[] => kubectl('get', 'pods', '-l', `harmonic.mintopia.net/task=${id}`, '-o', 'name').split('\n').filter((line) => line !== '');
  const deleteWhenRunning = async (id: number): Promise<string> => {
    const [pod] = await waitFor(async () => {
      const pods = podsOf(id);
      return pods.length > 0 && kubectl('get', pods[0]!, '-o', 'jsonpath={.status.phase}') === 'Running' ? pods : false;
    }, { timeoutMs: 120_000, intervalMs: 500 }).then(() => podsOf(id));
    kubectl('delete', pod!, '--force', '--grace-period=0', '--wait=false');
    return pod!;
  };

  it('brings up a new pod from the checkpoint when the pod is deleted mid-step, re-runs the step once and keeps the Attempt number', async () => {
    const id = await start('agent-claude');
    const lost = await deleteWhenRunning(id);
    await runToDone('agent-claude', id);
    const task = (await server.api('GET', `/api/tasks/${id}`)).body;
    expect(task.state).toBe('done');
    const steps = (await server.api('GET', `/api/tasks/${id}/workflow-steps`)).body.steps as { outcome: string; attempt: number | null }[];
    expect(steps.map((step) => step.outcome)).toEqual(['pass']);
    expect(steps[0]!.attempt).toBe(1);
    expect(podsOf(id)).not.toContain(lost);
  }, 420_000);

  it('escalates with reason 3 when the replacement pod is deleted too', async () => {
    const id = await start('agent-claude');
    const first = await deleteWhenRunning(id);
    await waitFor(async () => podsOf(id).some((pod) => pod !== first), { timeoutMs: 120_000, intervalMs: 500 });
    await deleteWhenRunning(id);
    await runToDone('agent-claude', id);
    const task = (await server.api('GET', `/api/tasks/${id}`)).body;
    expect(task.state).toBe('escalated');
    expect(JSON.stringify(task)).toContain('permanent infrastructure failure');
  }, 420_000);
});
