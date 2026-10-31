import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { startServer, type TestServer } from '../helpers.js';

const kubeconfigPath = process.env.HARMONIC_KIND_KUBECONFIG;

const body = (name: string, namespace: string) => ({
  name,
  authMethod: 'kubeconfig',
  namespace,
  defaultImage: 'ghcr.io/mintopia/harmonic-harnesses:test',
  cpu: '1',
  memory: '1Gi',
  concurrencyLimit: 1,
  repositoryProxyUrl: 'http://repo-proxy.harmonic-agents.svc.cluster.local',
});

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe.skipIf(!kubeconfigPath)('Execution Target connection test against a real kind cluster', () => {
  const kubeconfig = () => readFileSync(kubeconfigPath!, 'utf8');

  it('connects with a valid kubeconfig Secret and lists the namespace', async () => {
    server = await startServer();
    await server.api('POST', '/api/execution-targets', body('kind', 'harmonic-agents'));
    await server.api('PUT', '/api/execution-targets/kind/kubeconfig', { kubeconfig: kubeconfig() });
    const res = await server.api('POST', '/api/execution-targets/kind/test-connection');
    expect(res.body).toMatchObject({ ok: true, outcome: 'connected', namespace: 'harmonic-agents', secretName: 'kind-kubeconfig' });
    expect(typeof res.body.podCount).toBe('number');
  }, 60_000);

  it('reports a missing namespace', async () => {
    server = await startServer();
    await server.api('POST', '/api/execution-targets', body('kind', 'no-such-namespace'));
    await server.api('PUT', '/api/execution-targets/kind/kubeconfig', { kubeconfig: kubeconfig() });
    const res = await server.api('POST', '/api/execution-targets/kind/test-connection');
    expect(res.body).toMatchObject({ ok: false, outcome: 'namespace-not-found' });
  }, 60_000);

  it('fails with a clear outcome for a corrupted kubeconfig', async () => {
    server = await startServer();
    await server.api('POST', '/api/execution-targets', body('kind', 'harmonic-agents'));
    await server.api('PUT', '/api/execution-targets/kind/kubeconfig', { kubeconfig: '{{{ not a kubeconfig' });
    const res = await server.api('POST', '/api/execution-targets/kind/test-connection');
    expect(res.body.ok).toBe(false);
    expect(res.body.outcome).toBe('invalid-kubeconfig');
    expect(res.body.message).toMatch(/kubeconfig/i);
  }, 60_000);

  it('fails as unauthorized or unreachable for a kubeconfig with the wrong credentials', async () => {
    server = await startServer();
    const wrong = kubeconfig().replace(/client-key-data: .*/, 'client-key-data: AAAA').replace(/token: .*/, 'token: wrong');
    await server.api('POST', '/api/execution-targets', body('kind', 'harmonic-agents'));
    await server.api('PUT', '/api/execution-targets/kind/kubeconfig', { kubeconfig: wrong });
    const res = await server.api('POST', '/api/execution-targets/kind/test-connection');
    expect(res.body.ok).toBe(false);
    expect(['unauthorized', 'unreachable', 'invalid-kubeconfig']).toContain(res.body.outcome);
    expect(res.body.message.length).toBeGreaterThan(10);
  }, 60_000);
});
