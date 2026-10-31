import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

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

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.done) return false;
    this.killed = true;
    try {
      this.close();
    } catch {
      // a closed attach has nothing left to stop; the pod is deleted at run end
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
