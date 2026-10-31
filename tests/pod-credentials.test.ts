import { describe, expect, it } from 'vitest';
import { buildPodManifest } from '../src/execution/kubernetes-pods.js';
import { createPodOpener } from '../src/execution/pod-opener.js';
import { PodSession } from '../src/execution/pod-session.js';
import { FakePodApi, ok } from './fake-pod-api.js';

const TOKEN = 'sk-ant-oat01-super-secret';
const target = { name: 'k8s-prod', namespace: 'agents', cpu: '1', memory: '1Gi', repositoryProxyUrl: 'http://proxy.test', defaultImage: 'img' };
const creds = [{ envName: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN }];
const spec = { taskId: 7, target, image: 'img', source: 'workflow' as const, codeRepository: 'https://example.test/r.git', baseBranch: 'main', branch: 'harmonic/task-7', credentials: creds };
const passes = { issue: async () => 'pass-token' };

const session = (api: FakePodApi, over: Partial<typeof spec> = {}) =>
  new PodSession({ ...spec, ...over }, { api, passes, onExecution: () => undefined, suffix: () => 'ab12' });

describe('buildPodManifest credentials', () => {
  it('references each credential through secretKeyRef and never inlines the value', () => {
    const pod = buildPodManifest({ name: 'p', namespace: 'agents', secretName: 's', image: 'i', cpu: '1', memory: '1Gi', taskId: 1, credentialKeys: ['CLAUDE_CODE_OAUTH_TOKEN'] });
    const env = pod.spec!.containers[0]!.env!;
    expect(env.find((e) => e.name === 'CLAUDE_CODE_OAUTH_TOKEN')).toEqual({ name: 'CLAUDE_CODE_OAUTH_TOKEN', valueFrom: { secretKeyRef: { name: 's', key: 'CLAUDE_CODE_OAUTH_TOKEN' } } });
    expect(JSON.stringify(pod)).not.toContain(TOKEN);
  });
});

describe('PodSession credentials', () => {
  it('stores credentials as extra keys of the per-pod Secret and exposes them to the container env', async () => {
    const api = new FakePodApi(async (_argv, _options, podEnv) => ok(`${podEnv.CLAUDE_CODE_OAUTH_TOKEN ?? 'missing'}\n`));
    const pod = session(api);
    await pod.start();
    expect(api.secrets.get(pod.podName)).toEqual({ pass: 'pass-token', CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(JSON.stringify([...api.pods.values()])).not.toContain(TOKEN);
    await pod.dispose();
  });

  it('masks every credential value in run output and failure text', async () => {
    const api = new FakePodApi(async (argv) => (argv.at(-1)!.includes('ls-remote') ? ok('\n') : ok(`token=${TOKEN}\n`)));
    const pod = session(api);
    await pod.start();
    const result = await pod.run('echo', {}, 1000);
    expect(result.stdout).toBe('token=***\n');
    await pod.dispose();
  });

  it('masks the token in the clone failure message', async () => {
    const api = new FakePodApi(async () => ({ code: 1, stdout: '', stderr: `fatal ${TOKEN}`, timedOut: false }));
    await expect(session(api).start()).rejects.toThrow(/fatal \*\*\*/);
  });

  it('deletes the Secret with the pod', async () => {
    const api = new FakePodApi();
    const pod = session(api, { credentials: creds });
    await pod.start().catch(() => undefined);
    await pod.dispose();
    expect(api.secrets.has(pod.podName)).toBe(false);
  });
});

describe('pod opener credentials', () => {
  it('passes every credential the target resolves to the PodSession', async () => {
    const api = new FakePodApi(async () => ok('\n'));
    const opener = createPodOpener({
      targets: { podAccess: async () => ({ target, access: { authMethod: 'in-cluster', kubeconfig: null } }), podCredentials: async () => creds },
      passes,
      apiFactory: () => api,
      baseBranchFor: async () => 'main',
      setExecution: async () => undefined,
    });
    await opener.open({ id: 3, workingDir: process.cwd() }, { runsOn: 'k8s-prod', image: undefined, source: 'workflow' }).catch(() => undefined);
    const stored = [...api.secrets.values()][0];
    expect(stored?.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });
});
