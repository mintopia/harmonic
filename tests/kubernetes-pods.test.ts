import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPodManifest, wrapExecArgv } from '../src/execution/kubernetes-pods.js';

const spec = { name: 'harmonic-task-7-ab12', namespace: 'agents', secretName: 'harmonic-task-7-ab12', image: 'img:1', cpu: '2', memory: '4Gi', taskId: 7 };

describe('buildPodManifest', () => {
  const pod = buildPodManifest(spec);
  const container = pod.spec!.containers[0]!;

  it('sizes the pod from the target and takes the image', () => {
    expect(container.image).toBe('img:1');
    expect(container.resources).toEqual({ requests: { cpu: '2', memory: '4Gi' }, limits: { cpu: '2', memory: '4Gi' } });
  });

  it('idles so Harmonic can exec into it, never restarts, and gets no service account token or service env', () => {
    expect(container.command).toEqual(['sleep', 'infinity']);
    expect(pod.spec).toMatchObject({ restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false });
  });

  it('reads the Repository Proxy pass from the per-pod Secret and never holds its value', () => {
    expect(container.env).toContainEqual({ name: 'HARMONIC_PASS', valueFrom: { secretKeyRef: { name: 'harmonic-task-7-ab12', key: 'pass' } } });
  });

  it('exposes no ports', () => {
    expect(container.ports).toBeUndefined();
  });
});

describe('wrapExecArgv', () => {
  it('leaves a bare command alone', () => {
    expect(wrapExecArgv(['sh', '-c', 'true'], {})).toEqual(['sh', '-c', 'true']);
  });

  it('carries env and cwd to the command without putting either in shell text', () => {
    const argv = wrapExecArgv(['sh', '-c', 'echo "$A $PWD"'], { env: { A: "it's $(bad)" }, cwd: "/tmp/it's here" });
    mkdirSync("/tmp/it's here", { recursive: true });
    const out = execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8' });
    expect(out).toBe("it's $(bad) /tmp/it's here\n");
  });
});
