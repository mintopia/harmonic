import { spawn, type ChildProcess } from 'node:child_process';
import { buildPodManifest, type PodApi, type PodExecOptions, type PodExecResult, type PodSpecInput, type PodStreamOptions } from '../src/execution/kubernetes-pods.js';

export type ExecHandler = (argv: string[], options: PodExecOptions, podEnv: Record<string, string>) => Promise<PodExecResult>;

export const ok = (stdout = '', code = 0): PodExecResult => ({ code, stdout, stderr: '', timedOut: false });

export const hostExec: ExecHandler = (argv, options, podEnv) =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: { ...process.env, ...podEnv, ...options.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message, timedOut: false }));
    child.on('close', (code) => resolve({ code, stdout, stderr, timedOut: false }));
  });

export type StreamHandler = (argv: string[], options: PodStreamOptions, podEnv: Record<string, string>) => ChildProcess;

export const hostStream: StreamHandler = (argv, options, podEnv) =>
  spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: { ...process.env, ...podEnv, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });

export class FakePodApi implements PodApi {
  readonly calls: string[] = [];
  readonly secrets = new Map<string, Record<string, string>>();
  readonly pods = new Map<string, PodSpecInput>();
  readonly services: string[] = [];
  readonly execs: { argv: string[]; options: PodExecOptions }[] = [];
  readonly streams: { argv: string[]; options: PodStreamOptions }[] = [];

  constructor(private readonly handler: ExecHandler = hostExec, private readonly streamHandler: StreamHandler = hostStream) {}

  async createSecret(namespace: string, name: string, data: Record<string, string>): Promise<void> {
    this.calls.push(`createSecret ${namespace}/${name}`);
    this.secrets.set(name, data);
  }

  async createPod(spec: PodSpecInput): Promise<void> {
    this.calls.push(`createPod ${spec.namespace}/${spec.name}`);
    this.pods.set(spec.name, spec);
  }

  async waitForRunning(namespace: string, name: string): Promise<void> {
    this.calls.push(`waitForRunning ${namespace}/${name}`);
  }

  async exec(_namespace: string, pod: string, argv: string[], options: PodExecOptions): Promise<PodExecResult> {
    this.execs.push({ argv, options });
    const spec = this.pods.get(pod);
    if (!spec) throw new Error(`no pod ${pod}`);
    return this.handler(argv, options, this.containerEnv(spec));
  }

  async execStream(_namespace: string, pod: string, argv: string[], options: PodStreamOptions): Promise<ChildProcess> {
    this.streams.push({ argv, options });
    const spec = this.pods.get(pod);
    if (!spec) throw new Error(`no pod ${pod}`);
    return this.streamHandler(argv, options, this.containerEnv(spec));
  }

  async deletePod(namespace: string, name: string): Promise<void> {
    this.calls.push(`deletePod ${namespace}/${name}`);
    this.pods.delete(name);
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    this.calls.push(`deleteSecret ${namespace}/${name}`);
    this.secrets.delete(name);
  }

  async listServices(): Promise<string[]> {
    return [...this.services];
  }

  private containerEnv(spec: PodSpecInput): Record<string, string> {
    const env: Record<string, string> = {};
    for (const entry of buildPodManifest(spec).spec!.containers[0]!.env ?? []) {
      const ref = entry.valueFrom?.secretKeyRef;
      const value = ref ? this.secrets.get(ref.name!)?.[ref.key] : entry.value;
      if (value !== undefined) env[entry.name] = value;
    }
    return env;
  }
}
