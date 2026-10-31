import { describe, it, expect } from 'vitest';
import { ConnectionTimeoutError, InvalidKubeconfigError, classifyConnectionError, defaultKubernetesClientFactory, withTimeout } from '../src/execution/kubernetes-client.js';

describe('classifyConnectionError', () => {
  it('maps Kubernetes API status codes', () => {
    expect(classifyConnectionError(Object.assign(new Error('x'), { code: 401 })).outcome).toBe('unauthorized');
    expect(classifyConnectionError(Object.assign(new Error('x'), { code: 403 })).outcome).toBe('unauthorized');
    expect(classifyConnectionError(Object.assign(new Error('x'), { code: 404 })).outcome).toBe('namespace-not-found');
    expect(classifyConnectionError(Object.assign(new Error('x'), { code: 500 })).outcome).toBe('unreachable');
  });

  it('maps transport errors found anywhere on the cause chain to unreachable and keeps their text', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.test'), { code: 'ENOTFOUND' }) });
    const result = classifyConnectionError(err);
    expect(result.outcome).toBe('unreachable');
    expect(result.detail).toContain('ENOTFOUND');
    expect(classifyConnectionError(new ConnectionTimeoutError(10_000)).detail).toBe('timed out after 10s');
  });

  it('maps a bad kubeconfig, and treats an unknown failure as unreachable with its message', () => {
    expect(classifyConnectionError(new InvalidKubeconfigError('nope')).outcome).toBe('invalid-kubeconfig');
    expect(classifyConnectionError(new Error('weird')).detail).toBe('weird');
  });
});

describe('withTimeout', () => {
  it('rejects a call that never settles', async () => {
    await expect(withTimeout(new Promise(() => {}), 20)).rejects.toBeInstanceOf(ConnectionTimeoutError);
    await expect(withTimeout(Promise.resolve(1), 20)).resolves.toBe(1);
  });
});

describe('defaultKubernetesClientFactory kubeconfig parsing', () => {
  it('refuses unparsable text, a config without a cluster, and a missing kubeconfig', () => {
    expect(() => defaultKubernetesClientFactory({ authMethod: 'kubeconfig', kubeconfig: '{{{ not yaml' })).toThrow(InvalidKubeconfigError);
    expect(() => defaultKubernetesClientFactory({ authMethod: 'kubeconfig', kubeconfig: 'apiVersion: v1\nkind: Config\n' })).toThrow(/no current cluster/);
    expect(() => defaultKubernetesClientFactory({ authMethod: 'kubeconfig', kubeconfig: null })).toThrow(/no kubeconfig/);
  });

  it('builds a client from a well-formed kubeconfig without contacting the cluster', () => {
    const kubeconfig = [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- name: c',
      '  cluster: { server: "https://127.0.0.1:1" }',
      'users:',
      '- name: u',
      '  user: { token: abc }',
      'contexts:',
      '- name: ctx',
      '  context: { cluster: c, user: u }',
      'current-context: ctx',
    ].join('\n');
    expect(typeof defaultKubernetesClientFactory({ authMethod: 'kubeconfig', kubeconfig }).countPods).toBe('function');
  });
});
