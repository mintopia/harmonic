import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** A Kubernetes exec attach shaped like the slice of ChildProcess that AcpDriver and killProcessGroup use; it has no pid. */
export class PodProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private done = false;

  constructor(private readonly close: () => void = () => undefined) {
    super();
  }

  /** Closing the attach cannot be relied on to stop the in-pod process; the pod is deleted when the run ends. */
  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.done) return false;
    this.killed = true;
    try {
      this.close();
    } catch {
    }
    this.finish(null, typeof signal === 'string' ? signal : 'SIGTERM');
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.done) return;
    this.done = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  fail(error: Error): void {
    if (this.done) return;
    this.emit('error', error);
    this.finish(null);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}
