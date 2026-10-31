/**
 * A workflow whose `runs_on` names a Kubernetes Execution Target runs its shell
 * steps in one pod and pushes the Ticket branch after every step (ADR-0056,
 * issue #936). Skipped unless HARMONIC_KIND_KUBECONFIG names a kubeconfig for a
 * cluster with a `harmonic-agents` namespace (CI creates both with kind).
 *
 * The Repository Proxy runs inside this test process, in front of a bare
 * repository in a temp directory, and listens on every interface. The pods dial
 * it at HARMONIC_KIND_PROXY_HOST, the address the cluster reaches this machine
 * on; with kind on Linux that is the gateway of the `kind` docker network:
 *
 *   HARMONIC_KIND_PROXY_HOST=$(docker network inspect kind -f '{{(index .IPAM.Config 0).Gateway}}')
 *
 * To test against the in-cluster proxy from deploy/kubernetes/repository-proxy.yaml
 * instead, set HARMONIC_KIND_PROXY_URL (its Service URL) and HARMONIC_KIND_PROXY_KEY
 * (its HARMONIC_PROXY_KEY), and mount the bare repository named by
 * HARMONIC_KIND_UPSTREAM into the proxy pod at the same path; the proxy then reads
 * the upstream from that path.
 *
 * HARMONIC_KIND_IMAGE is the pod image: anything with `sh`, `git` and `sleep`
 * (default alpine/git).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryProxy } from '../../src/repository-proxy/server.js';
import { inBlock, startServer, waitFor, type TestServer } from '../helpers.js';

const kubeconfigPath = process.env.HARMONIC_KIND_KUBECONFIG;
const NAMESPACE = 'harmonic-agents';
const IMAGE = process.env.HARMONIC_KIND_IMAGE ?? 'alpine/git:latest';
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
const isAncestor = (cwd: string, older: string, newer: string): boolean => {
  try {
    git(cwd, 'merge-base', '--is-ancestor', older, newer);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!kubeconfigPath)('a workflow pod on a real kind cluster', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-kind-pod-'));
  const upstream = process.env.HARMONIC_KIND_UPSTREAM ?? join(root, 'upstream.git');
  const repo = join(root, 'repo');
  let server: TestServer;
  let proxy: Server | undefined;
  let core: CoreV1Api;

  const commitStep = (id: string, file: string): string => `  - id: ${id}\n    run: echo ${id} > ${file} && git add ${file} && git commit -qm ${id}\n`;
  const flow = (name: string, steps: string): string => `name: ${name}\ndescription: kind\nruns_on: kind\nsteps:\n${inBlock(steps)}`;
  const newTask = async (workflow: string): Promise<number> => (await server.api('POST', '/api/tasks', { prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree', workflow })).body.id;
  const runToDone = async (id: number): Promise<void> => {
    await server.api('POST', `/api/tasks/${id}/run`);
    await waitFor(async () => ['done', 'escalated'].includes((await server.api('GET', `/api/tasks/${id}`)).body.state), { timeoutMs: 240_000, intervalMs: 1000 });
  };
  const steps = async (id: number) => (await server.api('GET', `/api/tasks/${id}/workflow-steps`)).body.steps as { stepId: string; outcome: string; outputs: { checkpoint?: { sha: string; forced: boolean } } }[];
  const leftovers = async (id: number) => {
    const labelSelector = `harmonic.mintopia.net/task=${id}`;
    return {
      pods: (await core.listNamespacedPod({ namespace: NAMESPACE, labelSelector })).items.map((p) => p.metadata?.name),
      secrets: (await core.listNamespacedSecret({ namespace: NAMESPACE, labelSelector })).items.map((s) => s.metadata?.name),
    };
  };

  beforeAll(async () => {
    const kc = new KubeConfig();
    kc.loadFromFile(kubeconfigPath!);
    core = kc.makeApiClient(CoreV1Api);

    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', upstream]);
    execFileSync('git', ['clone', '-q', upstream, repo]);
    writeFileSync(join(repo, 'base.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'branch', '-M', 'main');
    git(repo, 'push', '-q', 'origin', 'main');

    server = await startServer(undefined, { dataDir: join(root, 'data') });
    let proxyUrl = process.env.HARMONIC_KIND_PROXY_URL;
    const create = await server.api('POST', '/api/execution-targets', {
      name: 'kind', authMethod: 'kubeconfig', namespace: NAMESPACE, defaultImage: IMAGE, cpu: '250m', memory: '256Mi', concurrencyLimit: 2,
      repositoryProxyUrl: proxyUrl ?? 'http://pending.invalid',
    });
    expect(create.status).toBe(201);
    await server.api('PUT', '/api/execution-targets/kind/kubeconfig', { kubeconfig: readFileSync(kubeconfigPath!, 'utf8') });
    const { key } = (await server.api('POST', '/api/execution-targets/kind/rotate-proxy-key')).body as { key: string };
    if (proxyUrl === undefined) {
      proxy = createRepositoryProxy({ key: process.env.HARMONIC_KIND_PROXY_KEY ?? key });
      await new Promise<void>((resolve) => proxy!.listen(0, '0.0.0.0', resolve));
      proxyUrl = `http://${process.env.HARMONIC_KIND_PROXY_HOST ?? '172.18.0.1'}:${(proxy.address() as AddressInfo).port}`;
      await server.api('PATCH', '/api/execution-targets/kind', { repositoryProxyUrl: proxyUrl });
    }
    await server.api('PUT', '/api/workflows/two-steps', { text: flow('two-steps', commitStep('one', 'one.txt') + commitStep('two', 'two.txt')) });
    await server.api('PUT', '/api/workflows/rebasing', { text: flow('rebasing', '  - id: rb\n    uses: rebase\n' + commitStep('after', 'after.txt')) });
  }, 120_000);

  afterAll(async () => {
    proxy?.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('pushes a checkpoint after each step, then deletes the pod and its Secret and never creates a Service', async () => {
    const servicesBefore = (await core.listNamespacedService({ namespace: NAMESPACE })).items.map((s) => s.metadata?.name).sort();
    const id = await newTask('two-steps');
    await runToDone(id);

    const task = (await server.api('GET', `/api/tasks/${id}`)).body;
    expect(task.state).toBe('done');
    const [one, two] = await steps(id);
    expect([one!.outcome, two!.outcome]).toEqual(['pass', 'pass']);
    const branch = `refs/heads/harmonic/task-${id}`;
    expect(one!.outputs.checkpoint!.sha).not.toBe(two!.outputs.checkpoint!.sha);
    expect(git(upstream, 'rev-parse', branch)).toBe(two!.outputs.checkpoint!.sha);
    expect(isAncestor(upstream, one!.outputs.checkpoint!.sha, two!.outputs.checkpoint!.sha)).toBe(true);
    expect(git(upstream, 'log', '--format=%s', branch)).toBe('two\none\nbase');

    expect(task.execution).toMatchObject({ target: 'kind', podState: 'deleted', namespace: NAMESPACE, image: IMAGE, source: 'workflow' });
    expect(await leftovers(id)).toEqual({ pods: [], secrets: [] });
    expect((await core.listNamespacedService({ namespace: NAMESPACE })).items.map((s) => s.metadata?.name).sort()).toEqual(servicesBefore);
  }, 300_000);

  it('force-pushes the Ticket branch after a rebase onto a base that moved', async () => {
    const id = await newTask('rebasing');
    const branch = `harmonic/task-${id}`;
    git(repo, 'checkout', '-q', '-b', branch);
    writeFileSync(join(repo, 'early.txt'), 'early');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'early');
    git(repo, 'push', '-q', 'origin', branch);
    const early = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'moved.txt'), 'moved');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base moved');
    git(repo, 'push', '-q', 'origin', 'main');
    await runToDone(id);

    const [rebase, after] = await steps(id);
    expect([rebase!.outcome, after!.outcome]).toEqual(['pass', 'pass']);
    expect(rebase!.outputs.checkpoint!.forced).toBe(true);
    const tip = git(upstream, 'rev-parse', `refs/heads/${branch}`);
    expect(tip).toBe(after!.outputs.checkpoint!.sha);
    expect(isAncestor(upstream, early, tip)).toBe(false);
    expect(isAncestor(upstream, git(upstream, 'rev-parse', 'refs/heads/main'), tip)).toBe(true);
    expect(git(upstream, 'log', '--format=%s', `refs/heads/${branch}`)).toBe('after\nearly\nbase moved\nbase');
    expect(await leftovers(id)).toEqual({ pods: [], secrets: [] });
  }, 300_000);
});
