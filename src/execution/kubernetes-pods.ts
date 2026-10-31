import { Writable } from 'node:stream';
import { CoreV1Api, Exec, type V1Pod, type V1Status } from '@kubernetes/client-node';
import { loadKubeConfig, statusCodeOf, type KubernetesAccess } from './kubernetes-client.js';

export const POD_PASS_ENV = 'HARMONIC_PASS';
export const POD_PASS_KEY = 'pass';
export const POD_WORKSPACE = '/workspace';
export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const TASK_LABEL = 'harmonic.mintopia.net/task';
const EXEC_OUTPUT_CAP = 200_000;
const POLL_MS = 1000;
const PULL_FAILURES = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CreateContainerConfigError', 'CreateContainerError']);

export interface PodSpecInput {
  name: string;
  namespace: string;
  secretName: string;
  image: string;
  cpu: string;
  memory: string;
  taskId: number;
}

export interface PodExecOptions {
  timeoutMs: number;
  env?: Record<string, string>;
  cwd?: string;
}

export interface PodExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface PodApi {
  createSecret(namespace: string, name: string, data: Record<string, string>, labels: Record<string, string>): Promise<void>;
  createPod(spec: PodSpecInput): Promise<void>;
  waitForRunning(namespace: string, name: string, timeoutMs: number): Promise<void>;
  exec(namespace: string, pod: string, argv: string[], options: PodExecOptions): Promise<PodExecResult>;
  deletePod(namespace: string, name: string): Promise<void>;
  deleteSecret(namespace: string, name: string): Promise<void>;
  listServices(namespace: string, labelSelector: string): Promise<string[]>;
}

export type PodApiFactory = (access: KubernetesAccess) => PodApi;

export const podLabels = (taskId: number): Record<string, string> => ({ [MANAGED_BY_LABEL]: 'harmonic', [TASK_LABEL]: String(taskId) });

export function buildPodManifest(spec: PodSpecInput): V1Pod {
  return {
    metadata: { name: spec.name, namespace: spec.namespace, labels: podLabels(spec.taskId) },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      containers: [
        {
          name: 'workflow',
          image: spec.image,
          command: ['sleep', 'infinity'],
          workingDir: POD_WORKSPACE,
          env: [
            { name: POD_PASS_ENV, valueFrom: { secretKeyRef: { name: spec.secretName, key: POD_PASS_KEY } } },
            { name: 'GIT_TERMINAL_PROMPT', value: '0' },
            { name: 'GIT_AUTHOR_NAME', value: 'Harmonic' },
            { name: 'GIT_AUTHOR_EMAIL', value: 'harmonic@localhost' },
            { name: 'GIT_COMMITTER_NAME', value: 'Harmonic' },
            { name: 'GIT_COMMITTER_EMAIL', value: 'harmonic@localhost' },
          ],
          resources: { requests: { cpu: spec.cpu, memory: spec.memory }, limits: { cpu: spec.cpu, memory: spec.memory } },
          securityContext: { allowPrivilegeEscalation: false },
          volumeMounts: [{ name: 'workspace', mountPath: POD_WORKSPACE }],
        },
      ],
      volumes: [{ name: 'workspace', emptyDir: {} }],
    },
  };
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function wrapExecArgv(argv: string[], options: Pick<PodExecOptions, 'env' | 'cwd'>): string[] {
  const env = Object.entries(options.env ?? {}).map(([name, value]) => `${name}=${value}`);
  const inner = env.length > 0 ? ['env', ...env, ...argv] : argv;
  if (options.cwd === undefined) return inner;
  return ['sh', '-c', `cd ${shellQuote(options.cwd)} && exec "$@"`, 'sh', ...inner];
}

function exitCodeOf(status: V1Status): number | null {
  if (status.status === 'Success') return 0;
  const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
  const code = cause?.message === undefined ? NaN : Number(cause.message);
  return Number.isInteger(code) ? code : null;
}

class CappedSink extends Writable {
  text = '';
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.text.length < EXEC_OUTPUT_CAP) this.text += chunk.toString('utf8').slice(0, EXEC_OUTPUT_CAP - this.text.length);
    done();
  }
}

async function ignoreNotFound(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (err) {
    if (statusCodeOf(err) !== 404) throw err;
  }
}

export const defaultPodApiFactory: PodApiFactory = (access) => {
  const config = loadKubeConfig(access);
  const core = config.makeApiClient(CoreV1Api);
  const exec = new Exec(config);
  return {
    async createSecret(namespace, name, data, labels) {
      await core.createNamespacedSecret({ namespace, body: { metadata: { name, namespace, labels }, type: 'Opaque', stringData: data } });
    },
    async createPod(spec) {
      await core.createNamespacedPod({ namespace: spec.namespace, body: buildPodManifest(spec) });
    },
    async waitForRunning(namespace, name, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const pod = await core.readNamespacedPod({ name, namespace });
        const phase = pod.status?.phase;
        if (phase === 'Running') return;
        if (phase === 'Failed' || phase === 'Succeeded') throw new Error(`pod ${name} ended in phase ${phase} before it ran`);
        const waiting = pod.status?.containerStatuses?.find((c) => c.state?.waiting && PULL_FAILURES.has(c.state.waiting.reason ?? ''))?.state?.waiting;
        if (waiting) throw new Error(`pod ${name} cannot start: ${waiting.reason}${waiting.message ? ` (${waiting.message})` : ''}`);
        if (Date.now() >= deadline) throw new Error(`pod ${name} was not running after ${Math.round(timeoutMs / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
    async exec(namespace, pod, argv, options) {
      const stdout = new CappedSink();
      const stderr = new CappedSink();
      let status: V1Status | undefined;
      let timedOut = false;
      const ws = await exec.exec(namespace, pod, 'workflow', wrapExecArgv(argv, options), stdout, stderr, null, false, (s) => {
        status = s;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        ws.close();
      }, options.timeoutMs);
      await new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
        ws.on('error', () => resolve());
      });
      clearTimeout(timer);
      return { code: status === undefined ? null : exitCodeOf(status), stdout: stdout.text, stderr: stderr.text, timedOut };
    },
    deletePod: (namespace, name) => ignoreNotFound(core.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 })),
    deleteSecret: (namespace, name) => ignoreNotFound(core.deleteNamespacedSecret({ name, namespace })),
    async listServices(namespace, labelSelector) {
      const list = await core.listNamespacedService({ namespace, labelSelector });
      return list.items.map((s) => s.metadata?.name ?? '');
    },
  };
};
