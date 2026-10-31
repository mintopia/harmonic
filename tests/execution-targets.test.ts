import { describe, it, expect, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { join } from 'node:path';
import { startServer, type TestServer } from './helpers.js';
import { InvalidKubeconfigError, type KubernetesAccess, type KubernetesClient, type KubernetesClientFactory } from '../src/execution/kubernetes-client.js';

const KUBECONFIG = 'apiVersion: v1\nkind: Config\nclusters: []\n# super-secret-marker\n';

interface Fake {
  factory: KubernetesClientFactory;
  accesses: KubernetesAccess[];
  client: KubernetesClient;
}

function fakeFactory(client: Partial<KubernetesClient> = {}, build?: (access: KubernetesAccess) => void): Fake {
  const accesses: KubernetesAccess[] = [];
  const full: KubernetesClient = { countPods: async () => 6, namespaceExists: async () => true, ...client };
  return {
    accesses,
    client: full,
    factory: (access) => {
      accesses.push(access);
      build?.(access);
      return full;
    },
  };
}

const body = (over: Record<string, unknown> = {}) => ({
  name: 'k8s-prod',
  authMethod: 'kubeconfig',
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

describe('Execution Target CRUD', () => {
  it('lists the built-in local target first and creates, reads, edits and disables a Kubernetes target', async () => {
    server = await startServer();
    const initial = await server.api('GET', '/api/execution-targets');
    expect(initial.body.targets).toHaveLength(1);
    expect(initial.body.targets[0]).toMatchObject({ name: 'local', builtIn: true, enabled: true, kubeconfig: null, running: 0 });

    const created = await server.api('POST', '/api/execution-targets', body());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'k8s-prod', builtIn: false, enabled: true, concurrencyLimit: 4, kubeconfig: { set: false, secretName: null }, running: 0 });

    const list = await server.api('GET', '/api/execution-targets');
    expect(list.body.targets.map((t: { name: string }) => t.name)).toEqual(['local', 'k8s-prod']);
    expect(list.body.total).toBe(2);

    const edited = await server.api('PATCH', '/api/execution-targets/k8s-prod', { cpu: '4', enabled: false });
    expect(edited.body).toMatchObject({ cpu: '4', enabled: false, memory: '4Gi' });
    expect((await server.api('GET', '/api/execution-targets/k8s-prod')).body.enabled).toBe(false);
  });

  it('refuses a duplicate name, the name local, bad numbers and a non-http proxy URL', async () => {
    server = await startServer();
    expect((await server.api('POST', '/api/execution-targets', body())).status).toBe(201);
    expect((await server.api('POST', '/api/execution-targets', body())).status).toBe(409);
    expect((await server.api('POST', '/api/execution-targets', body({ name: 'Local' }))).status).toBe(400);
    expect((await server.api('POST', '/api/execution-targets', body({ name: 'bad name' }))).status).toBe(400);
    expect((await server.api('POST', '/api/execution-targets', body({ name: 'a', concurrencyLimit: 0 }))).status).toBe(400);
    expect((await server.api('POST', '/api/execution-targets', body({ name: 'b', concurrencyLimit: 1.5 }))).status).toBe(400);
    expect((await server.api('POST', '/api/execution-targets', body({ name: 'c', namespace: '  ' }))).status).toBe(400);
    expect((await server.api('POST', '/api/execution-targets', body({ name: 'd', cpu: '' }))).status).toBe(400);
    expect((await server.api('POST', '/api/execution-targets', body({ name: 'e', repositoryProxyUrl: 'ftp://x' }))).status).toBe(400);
    expect((await server.api('POST', '/api/execution-targets', body({ name: 'f', repositoryProxyUrl: 'not a url' }))).status).toBe(400);
    await server.api('POST', '/api/execution-targets', body({ name: 'other' }));
    expect((await server.api('PATCH', '/api/execution-targets/other', { name: 'k8s-prod' })).status).toBe(409);
  });

  it('treats local as built in: readable, never editable or deletable', async () => {
    server = await startServer();
    expect((await server.api('GET', '/api/execution-targets/local')).body).toMatchObject({ builtIn: true });
    expect((await server.api('PATCH', '/api/execution-targets/local', { enabled: false })).status).toBe(409);
    expect((await server.api('DELETE', '/api/execution-targets/local')).status).toBe(409);
    expect((await server.api('GET', '/api/execution-targets/missing')).status).toBe(404);
    expect((await server.anonApi('GET', '/api/execution-targets')).status).toBe(401);
  });
});

describe('kubeconfig Secret', () => {
  it('is write-only: set, replaced and cleared through its own endpoint and never returned', async () => {
    server = await startServer();
    await server.api('POST', '/api/execution-targets', body());
    const put = await server.api('PUT', '/api/execution-targets/k8s-prod/kubeconfig', { kubeconfig: KUBECONFIG });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ set: true, secretName: 'k8s-prod-kubeconfig', updatedAt: expect.any(Number) });

    const get = await server.api('GET', '/api/execution-targets/k8s-prod');
    expect(get.body.kubeconfig).toMatchObject({ set: true, secretName: 'k8s-prod-kubeconfig' });
    const everything = JSON.stringify([get.body, (await server.api('GET', '/api/execution-targets')).body, put.body]);
    expect(everything).not.toContain('super-secret-marker');

    const db = createClient({ url: `file:${join(server.dataDir, 'harmonic.db')}` });
    const stored = await db.execute('select ciphertext from global_secrets');
    expect(stored.rows).toHaveLength(1);
    expect(String(stored.rows[0]!.ciphertext)).not.toContain('super-secret-marker');
    db.close();
    expect(await server.app.ctx.executionTargets.get('k8s-prod').then(() => true)).toBe(true);

    const cleared = await server.api('DELETE', '/api/execution-targets/k8s-prod/kubeconfig');
    expect(cleared.body).toEqual({ set: false, secretName: null, updatedAt: null });
    expect((await server.api('GET', '/api/execution-targets/k8s-prod')).body.kubeconfig.set).toBe(false);
  });

  it('refuses a kubeconfig for an in-cluster target and drops the stored one when switching to in-cluster', async () => {
    server = await startServer();
    await server.api('POST', '/api/execution-targets', body({ name: 'in', authMethod: 'in-cluster' }));
    expect((await server.api('PUT', '/api/execution-targets/in/kubeconfig', { kubeconfig: KUBECONFIG })).status).toBe(409);

    await server.api('POST', '/api/execution-targets', body());
    await server.api('PUT', '/api/execution-targets/k8s-prod/kubeconfig', { kubeconfig: KUBECONFIG });
    const switched = await server.api('PATCH', '/api/execution-targets/k8s-prod', { authMethod: 'in-cluster' });
    expect(switched.body.kubeconfig).toEqual({ set: false, secretName: null, updatedAt: null });
  });

  it('follows a rename and is removed with the target', async () => {
    server = await startServer();
    await server.api('POST', '/api/execution-targets', body());
    await server.api('PUT', '/api/execution-targets/k8s-prod/kubeconfig', { kubeconfig: KUBECONFIG });
    const renamed = await server.api('PATCH', '/api/execution-targets/k8s-prod', { name: 'k8s-main' });
    expect(renamed.body.kubeconfig).toMatchObject({ set: true, secretName: 'k8s-main-kubeconfig' });
    expect(await server.app.ctx.executionTargets.get('k8s-main').then((t) => t.name)).toBe('k8s-main');

    const del = await server.api('DELETE', '/api/execution-targets/k8s-main');
    expect(del.body).toEqual({ ok: true, escalated: { running: 0, waiting: 0, total: 0 } });
    const db = createClient({ url: `file:${join(server.dataDir, 'harmonic.db')}` });
    expect((await db.execute('select name from global_secrets')).rows).toHaveLength(0);
    expect((await db.execute('select name from execution_targets')).rows).toHaveLength(0);
    db.close();
    expect((await server.api('GET', '/api/execution-targets/k8s-main')).status).toBe(404);
  });
});

describe('Repository Proxy signing key', () => {
  it('is created and replaced by rotation, shown once, and follows a rename and delete', async () => {
    server = await startServer();
    const created = await server.api('POST', '/api/execution-targets', body());
    expect(created.body.proxyKey).toEqual({ set: false, secretName: 'k8s-prod-proxy-key', rotatedAt: null });

    const first = await server.api('POST', '/api/execution-targets/k8s-prod/rotate-proxy-key');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ revokedRunning: 0 });
    const second = await server.api('POST', '/api/execution-targets/k8s-prod/rotate-proxy-key');
    expect(second.body.key).not.toBe(first.body.key);

    const read = await server.api('GET', '/api/execution-targets/k8s-prod');
    expect(read.body.proxyKey).toMatchObject({ set: true, rotatedAt: second.body.rotatedAt });
    expect(JSON.stringify(read.body)).not.toContain(second.body.key);

    const renamed = await server.api('PATCH', '/api/execution-targets/k8s-prod', { name: 'k8s-main' });
    expect(renamed.body.proxyKey).toMatchObject({ set: true, secretName: 'k8s-main-proxy-key' });

    await server.api('DELETE', '/api/execution-targets/k8s-main');
    await server.api('POST', '/api/execution-targets', body({ name: 'k8s-main' }));
    expect((await server.api('GET', '/api/execution-targets/k8s-main')).body.proxyKey.set).toBe(false);
  });

  it('refuses rotating local and an unknown target', async () => {
    server = await startServer();
    expect((await server.api('POST', '/api/execution-targets/local/rotate-proxy-key')).status).toBe(409);
    expect((await server.api('POST', '/api/execution-targets/nope/rotate-proxy-key')).status).toBe(404);
  });
});

describe('deletion impact', () => {
  it('reports zero Tickets escalating while no run state references targets', async () => {
    server = await startServer();
    await server.api('POST', '/api/execution-targets', body());
    const impact = await server.api('GET', '/api/execution-targets/k8s-prod/deletion-impact');
    expect(impact.body).toEqual({ running: 0, waiting: 0, total: 0 });
    expect((await server.api('GET', '/api/execution-targets/nope/deletion-impact')).status).toBe(404);
  });
});

describe('connection test', () => {
  const setup = async (fake: Fake, over: Record<string, unknown> = {}) => {
    server = await startServer(undefined, { kubernetesClientFactory: fake.factory });
    await server.api('POST', '/api/execution-targets', body(over));
    if (over.authMethod !== 'in-cluster') await server.api('PUT', '/api/execution-targets/k8s-prod/kubeconfig', { kubeconfig: KUBECONFIG });
    return server;
  };

  it('reports connected with the pod count, using the stored kubeconfig', async () => {
    const fake = fakeFactory();
    const s = await setup(fake);
    const res = await s.api('POST', '/api/execution-targets/k8s-prod/test-connection');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: 'connected', podCount: 6, namespace: 'harmonic-agents', secretName: 'k8s-prod-kubeconfig' });
    expect(res.body.message).toContain('harmonic-agents');
    expect(fake.accesses).toEqual([{ authMethod: 'kubeconfig', kubeconfig: KUBECONFIG }]);
  });

  it('maps 401 and 403 to unauthorized', async () => {
    for (const code of [401, 403]) {
      const s = await setup(fakeFactory({ countPods: async () => Promise.reject(Object.assign(new Error('nope'), { code })) }));
      const res = await s.api('POST', '/api/execution-targets/k8s-prod/test-connection');
      expect(res.body).toMatchObject({ ok: false, outcome: 'unauthorized' });
      expect(res.body.message).toContain('Unauthorized');
      await s.close();
      server = undefined;
    }
  });

  it('maps a 404 and an empty list in a missing namespace to namespace-not-found', async () => {
    const a = await setup(fakeFactory({ countPods: async () => Promise.reject(Object.assign(new Error('nf'), { code: 404 })) }));
    expect((await a.api('POST', '/api/execution-targets/k8s-prod/test-connection')).body.outcome).toBe('namespace-not-found');
    await a.close();
    const b = await setup(fakeFactory({ countPods: async () => 0, namespaceExists: async () => false }));
    const res = await b.api('POST', '/api/execution-targets/k8s-prod/test-connection');
    expect(res.body).toMatchObject({ ok: false, outcome: 'namespace-not-found' });
    expect(res.body.message).toContain('harmonic-agents');
  });

  it('accepts an empty namespace the credentials cannot confirm, and one that exists', async () => {
    const s = await setup(fakeFactory({ countPods: async () => 0, namespaceExists: async () => null }));
    const res = await s.api('POST', '/api/execution-targets/k8s-prod/test-connection');
    expect(res.body).toMatchObject({ ok: true, outcome: 'connected', podCount: 0 });
  });

  it('maps network failures and a timeout to unreachable', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:6443'), { code: 'ECONNREFUSED' }) });
    const a = await setup(fakeFactory({ countPods: async () => Promise.reject(refused) }));
    const res = await a.api('POST', '/api/execution-targets/k8s-prod/test-connection');
    expect(res.body).toMatchObject({ ok: false, outcome: 'unreachable' });
    expect(res.body.message).toContain('ECONNREFUSED');
    await a.close();

    const b = await startServer(undefined, { kubernetesClientFactory: fakeFactory({ countPods: () => new Promise(() => {}) }).factory });
    server = b;
    await b.api('POST', '/api/execution-targets', body());
    await b.api('PUT', '/api/execution-targets/k8s-prod/kubeconfig', { kubeconfig: KUBECONFIG });
    const svc = b.app.ctx.executionTargets as unknown as { testTimeoutMs: number };
    svc.testTimeoutMs = 50;
    const timedOut = await b.api('POST', '/api/execution-targets/k8s-prod/test-connection');
    expect(timedOut.body).toMatchObject({ ok: false, outcome: 'unreachable' });
    expect(timedOut.body.message).toContain('timed out');
  });

  it('maps a client that cannot be built and a missing kubeconfig to invalid-kubeconfig', async () => {
    const bad = fakeFactory({}, () => {
      throw new InvalidKubeconfigError('the kubeconfig could not be parsed: bad yaml');
    });
    const s = await setup(bad);
    const res = await s.api('POST', '/api/execution-targets/k8s-prod/test-connection');
    expect(res.body).toMatchObject({ ok: false, outcome: 'invalid-kubeconfig' });
    expect(res.body.message).toContain('bad yaml');
    await s.api('DELETE', '/api/execution-targets/k8s-prod/kubeconfig');
    const missing = await s.api('POST', '/api/execution-targets/k8s-prod/test-connection');
    expect(missing.body).toMatchObject({ ok: false, outcome: 'invalid-kubeconfig', secretName: null });
  });

  it('tests an in-cluster target without a kubeconfig', async () => {
    const fake = fakeFactory();
    const s = await setup(fake, { authMethod: 'in-cluster' });
    const res = await s.api('POST', '/api/execution-targets/k8s-prod/test-connection');
    expect(res.body).toMatchObject({ ok: true, outcome: 'connected', secretName: null });
    expect(fake.accesses).toEqual([{ authMethod: 'in-cluster', kubeconfig: null }]);
  });

  it('tests an unsaved draft, preferring its kubeconfig and falling back to the stored Secret, without storing anything', async () => {
    const fake = fakeFactory();
    server = await startServer(undefined, { kubernetesClientFactory: fake.factory });
    const draft = await server.api('POST', '/api/execution-targets/test-connection', { authMethod: 'kubeconfig', namespace: 'x', kubeconfig: 'draft-kubeconfig' });
    expect(draft.body).toMatchObject({ ok: true, namespace: 'x', secretName: null });
    expect(fake.accesses[0]).toEqual({ authMethod: 'kubeconfig', kubeconfig: 'draft-kubeconfig' });

    await server.api('POST', '/api/execution-targets', body());
    await server.api('PUT', '/api/execution-targets/k8s-prod/kubeconfig', { kubeconfig: KUBECONFIG });
    const stored = await server.api('POST', '/api/execution-targets/test-connection', { name: 'k8s-prod', authMethod: 'kubeconfig', namespace: 'other' });
    expect(stored.body).toMatchObject({ ok: true, namespace: 'other', secretName: 'k8s-prod-kubeconfig' });
    expect(fake.accesses[1]).toEqual({ authMethod: 'kubeconfig', kubeconfig: KUBECONFIG });
    expect((await server.api('POST', '/api/execution-targets/test-connection', { name: 'nope', authMethod: 'in-cluster', namespace: 'x' })).status).toBe(404);
    expect((await server.api('GET', '/api/execution-targets/k8s-prod')).body.namespace).toBe('harmonic-agents');
  });
});
