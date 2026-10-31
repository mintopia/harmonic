import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';

export const CONNECTION_TEST_TIMEOUT_MS = 10_000;

export const CONNECTION_OUTCOMES = ['connected', 'unauthorized', 'namespace-not-found', 'unreachable', 'invalid-kubeconfig'] as const;
export type ConnectionOutcome = (typeof CONNECTION_OUTCOMES)[number];

export interface KubernetesAccess {
  authMethod: 'kubeconfig' | 'in-cluster';
  kubeconfig: string | null;
}

export interface KubernetesClient {
  countPods(namespace: string): Promise<number>;
  /** `null` when the credentials may not read Namespaces, so existence is unknown. */
  namespaceExists(namespace: string): Promise<boolean | null>;
}

export type KubernetesClientFactory = (access: KubernetesAccess) => KubernetesClient;

export class InvalidKubeconfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidKubeconfigError';
  }
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

export class ConnectionTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'ConnectionTimeoutError';
  }
}

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let cur: unknown = err; cur && chain.length < 5; cur = (cur as { cause?: unknown }).cause) chain.push(cur);
  return chain;
}

export function statusCodeOf(err: unknown): number | null {
  for (const link of causeChain(err)) {
    const code = (link as { code?: unknown }).code;
    if (typeof code === 'number') return code;
    const status = (link as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return null;
}

function messageOf(err: unknown): string {
  const parts = causeChain(err).map((link) => (link instanceof Error ? link.message : typeof link === 'string' ? link : '')).filter(Boolean);
  return [...new Set(parts)].join(': ') || 'unknown error';
}

export interface ClassifiedFailure {
  outcome: Exclude<ConnectionOutcome, 'connected'>;
  detail: string;
}

export function classifyConnectionError(err: unknown): ClassifiedFailure {
  if (err instanceof InvalidKubeconfigError) return { outcome: 'invalid-kubeconfig', detail: err.message };
  const status = statusCodeOf(err);
  if (status === 401 || status === 403) return { outcome: 'unauthorized', detail: `the cluster answered ${status}` };
  if (status === 404) return { outcome: 'namespace-not-found', detail: 'the cluster answered 404' };
  if (err instanceof ConnectionTimeoutError) return { outcome: 'unreachable', detail: err.message };
  const hasNetworkCode = causeChain(err).some((link) => typeof (link as { code?: unknown }).code === 'string' && UNREACHABLE_CODES.has((link as { code: string }).code));
  return { outcome: 'unreachable', detail: hasNetworkCode || status === null ? messageOf(err) : `the cluster answered ${status}` };
}

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ConnectionTimeoutError(ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function loadKubeConfig({ authMethod, kubeconfig }: KubernetesAccess): KubeConfig {
  const config = new KubeConfig();
  try {
    if (authMethod === 'in-cluster') {
      config.loadFromCluster();
    } else {
      if (!kubeconfig) throw new InvalidKubeconfigError('no kubeconfig is set for this target');
      config.loadFromString(kubeconfig);
    }
  } catch (err) {
    if (err instanceof InvalidKubeconfigError) throw err;
    throw new InvalidKubeconfigError(authMethod === 'in-cluster' ? `not running in a cluster: ${messageOf(err)}` : `the kubeconfig could not be parsed: ${messageOf(err)}`);
  }
  if (!config.getCurrentCluster()) throw new InvalidKubeconfigError('the kubeconfig has no current cluster');
  if (!config.getCurrentUser() && authMethod === 'kubeconfig') throw new InvalidKubeconfigError('the kubeconfig has no current user');
  return config;
}

export const defaultKubernetesClientFactory: KubernetesClientFactory = (access) => {
  const api = loadKubeConfig(access).makeApiClient(CoreV1Api);
  return {
    async countPods(namespace) {
      const list = await api.listNamespacedPod({ namespace, limit: 500 });
      return list.items.length + (list.metadata?.remainingItemCount ?? 0);
    },
    async namespaceExists(namespace) {
      try {
        await api.readNamespace({ name: namespace });
        return true;
      } catch (err) {
        const status = statusCodeOf(err);
        if (status === 404) return false;
        if (status === 401 || status === 403) return null;
        throw err;
      }
    },
  };
};
