import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface AcpHandlers {
  /** ACP session/update notifications. */
  onSessionUpdate: (params: SessionUpdateParams) => void;
  /** Agent→client requests (session/request_permission, fs/*, …). */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
}

export interface SessionUpdateParams {
  sessionId: string;
  update: { sessionUpdate: string; [key: string]: unknown };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Every in-flight ACP request is rejected with this when the harness's stdout
 * reaches EOF (readline `close`) before their responses arrive. Distinct from
 * a child-death `fail()`: the inner harness can close stdout while an outer
 * `npx` wrapper lingers, so the child `exit` the driver watches never fires.
 */
export class AcpConnectionClosedError extends Error {
  constructor(message = 'ACP connection closed (stdout EOF)') {
    super(message);
    this.name = 'AcpConnectionClosedError';
  }
}

/**
 * A JSON-RPC 2.0 connection over newline-delimited JSON, as ACP speaks it
 * on a harness's stdio. Non-JSON lines are tolerated (some adapters leak
 * log noise onto stdout).
 */
export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private rl: Interface;
  private closed = false;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly handlers: AcpHandlers,
  ) {
    this.rl = createInterface({ input: stdout });
    this.rl.on('line', (line) => this.onLine(line));
    this.rl.on('close', () => {
      if (this.closed) return;
      this.fail(new AcpConnectionClosedError());
    });
    // A stdin write can race the harness's death and emit EPIPE asynchronously;
    // in-flight requests already fail via `fail()`.
    this.stdin.on('error', () => {});
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new AcpConnectionClosedError());
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Fire-and-forget notification (no id, no response) — e.g. session/cancel. */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Reject all in-flight requests; called when the process dies. */
  fail(err: Error): void {
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  dispose(): void {
    this.closed = true;
    this.rl.close();
  }

  private write(msg: unknown): void {
    if (this.closed || !this.stdin.writable) return;
    try {
      this.stdin.write(JSON.stringify(msg) + '\n');
    } catch {
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
      else pending.resolve(msg.result);
      return;
    }

    if (msg.id === undefined && msg.method === 'session/update') {
      this.handlers.onSessionUpdate(msg.params as SessionUpdateParams);
      return;
    }
    if (msg.id === undefined) return;

    this.handlers
      .onRequest(msg.method, msg.params)
      .then((result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null }))
      .catch((err: Error) =>
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } }),
      );
  }
}
