import type { TrackerRef } from '../tracker/adapter.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ToolCallTotals } from '../domain/tool-call-aggregates.js';
import type { AttemptRow } from './schema.js';
import { DEFAULT_QUERY_TIMEOUT_MS, QueryTimeoutError, type QueryTimeoutOptions } from './async.js';

export interface StatsRange {
  from: number;
  to: number;
  workspaceId?: number;
  /** Scope to one Epic's child Tasks (those whose `mapRef` is this ref); composes with `workspaceId`. */
  epicRef?: TrackerRef;
}

/** The merge-policy escalation reason (merge-policy.ts `MergePolicyOutcome`). */
export type GateReason = 'conflict' | 'post-merge-red' | 'write-failed' | 'target-advanced';

/** One `merged`/`escalated` settling event, carrying the merge gate that produced an escalation. */
export interface SettleEventRow {
  taskId: number;
  ts: number;
  kind: 'merged' | 'escalated';
  /** The merge gate reason on an escalation; null otherwise. */
  gate: GateReason | null;
}

/** Display identity for one Workspace in the per-Workspace breakdown. */
export interface WorkspaceNameRow {
  id: number;
  name: string;
  color: string;
}

/** The owning Workspace of a Task, the join key the per-Workspace breakdown groups by. */
export interface TaskWorkspaceRow {
  taskId: number;
  workspaceId: number | null;
}

/** One Attempt of a settled Task and its frozen cost JSON. */
export interface SettledTaskAttempt {
  taskId: number;
  cost: string | null;
}

/** One verification-attempt-grain verdict. */
export interface VerificationRow {
  mechanism: string;
  verdict: string;
}

/** One distinct (Attempt, dimension) Guardrail trip. */
export interface GuardrailTripRow {
  attemptId: number;
  dimension: string;
}

export interface StatsReadResult {
  rows: AttemptRow[];
  /** Failed-only Attempts' `attempts.reason`, keyed by Attempt id. */
  attemptReasons: Array<{ attemptId: number; reason: string | null }>;
  toolTotals: ToolCallTotals;
  workspaces: WorkspaceNameRow[];
  /** The owning Workspace of every Task referenced by an in-range Attempt row. */
  taskWorkspaces: TaskWorkspaceRow[];
  /** Merge/escalation settling events whose ts falls in range. */
  settleEvents: SettleEventRow[];
  /** Every Attempt of a Task that settled in range, including Attempts started before the range. */
  settledTaskAttempts: SettledTaskAttempt[];
  /** Verification-attempt-grain verdicts in range. */
  verifications: VerificationRow[];
  /** Distinct (Attempt, dimension) Guardrail trips in range. */
  guardrailTrips: GuardrailTripRow[];
}

export type StatsWorkerRequest =
  | { kind: 'compute'; id: number; range: StatsRange }
  | { kind: 'probe'; id: number; iterations: number }
  | { kind: 'close' };
export type StatsWorkerResponse =
  | { kind: 'result'; id: number; result: unknown }
  | { kind: 'probe-result'; id: number; value: number }
  | { kind: 'error'; id: number; message: string; stack?: string }
  | { kind: 'closed' }
  | { kind: 'invalid'; message: string };

const CLOSE_GRACE_MS = 5_000;
export const MAX_PROBE_ITERATIONS = 10_000;

/** Shared by the client's pre-flight check and the worker's own enforcement, so the two can't drift apart. */
export function invalidProbeIterationsReason(iterations: number): string | null {
  if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > MAX_PROBE_ITERATIONS) {
    return `Stats worker probe iterations must be an integer from 1 to ${MAX_PROBE_ITERATIONS}`;
  }
  return null;
}

type PendingRequest = {
  kind: 'compute';
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
} | {
  kind: 'probe';
  resolve: (value: number) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isStatsRange(value: unknown): value is StatsRange {
  return isRecord(value)
    && typeof value.from === 'number'
    && typeof value.to === 'number'
    && (value.workspaceId === undefined || typeof value.workspaceId === 'number')
    && (value.epicRef === undefined || typeof value.epicRef === 'string');
}

export function isStatsWorkerRequest(value: unknown): value is StatsWorkerRequest {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'close') return true;
  if (!isId(value.id)) return false;
  if (value.kind === 'compute') return isStatsRange(value.range);
  return value.kind === 'probe'
    && typeof value.iterations === 'number'
    && Number.isSafeInteger(value.iterations)
    && value.iterations > 0;
}

function isStatsWorkerResponse(value: unknown): value is StatsWorkerResponse {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'closed') return true;
  if (value.kind === 'invalid') return typeof value.message === 'string';
  if (!isId(value.id)) return false;
  if (value.kind === 'result') return isRecord(value.result);
  if (value.kind === 'probe-result') return typeof value.value === 'number' && Number.isFinite(value.value);
  return value.kind === 'error'
    && typeof value.message === 'string'
    && (value.stack === undefined || typeof value.stack === 'string');
}

/** Resolves the Stats worker's entry point (compiled `.js` if built, else the `.ts` source under `tsx`). */
export function resolveStatsWorkerEntry(): { url: URL; execArgv?: string[] } {
  const jsEntry = new URL('./stats-worker.js', import.meta.url);
  const runningFromSource = !existsSync(fileURLToPath(jsEntry));
  return runningFromSource
    ? { url: new URL('./stats-worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] }
    : { url: jsEntry };
}

export class StatsWorkerClient {
  readonly #worker: Worker;
  readonly #defaultTimeoutMs: number;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #resolveClose: (() => void) | undefined;

  constructor(dataDir: string, defaultTimeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS) {
    this.#defaultTimeoutMs = defaultTimeoutMs;
    const { url, execArgv } = resolveStatsWorkerEntry();
    this.#worker = new Worker(url, {
      workerData: { dataDir },
      ...(execArgv ? { execArgv } : {}),
    });
    this.#worker.on('message', (message: unknown) => {
      if (isStatsWorkerResponse(message)) this.#receive(message);
      else {
        this.#failAll(new Error('Stats worker sent an invalid response'));
        void this.close();
      }
    });
    this.#worker.on('error', (error) => {
      this.#closed = true;
      this.#failAll(error instanceof Error ? error : new Error(String(error)));
      this.#finishClose();
    });
    this.#worker.on('exit', (code) => {
      if (!this.#closed) {
        this.#closed = true;
        this.#failAll(new Error(`Stats worker exited with code ${code}`));
      }
      this.#finishClose();
    });
  }

  compute(range: StatsRange, opts?: QueryTimeoutOptions): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error('Stats worker is closed'));
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? this.#defaultTimeoutMs;
      const pending: PendingRequest = { kind: 'compute', resolve, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new QueryTimeoutError('read', timeoutMs));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.#pending.set(id, pending);
      this.#worker.postMessage({ kind: 'compute', id, range } satisfies StatsWorkerRequest);
    });
  }

  /** Test-only fixed-shape load probe. It never accepts SQL from the caller. */
  probeHeavyRead(iterations: number, opts?: QueryTimeoutOptions): Promise<number> {
    if (this.#closed) return Promise.reject(new Error('Stats worker is closed'));
    const invalidReason = invalidProbeIterationsReason(iterations);
    if (invalidReason) return Promise.reject(new Error(invalidReason));
    const id = this.#nextId++;
    return new Promise<number>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? this.#defaultTimeoutMs;
      const pending: PendingRequest = { kind: 'probe', resolve, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new QueryTimeoutError('read', timeoutMs));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.#pending.set(id, pending);
      this.#worker.postMessage({ kind: 'probe', id, iterations } satisfies StatsWorkerRequest);
    });
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return;
    this.#closed = true;
    this.#closePromise = this.#closeGracefully();
    return this.#closePromise;
  }

  async #closeGracefully(): Promise<void> {
    const graceful = new Promise<void>((resolve) => {
      this.#resolveClose = resolve;
    });
    this.#worker.postMessage({ kind: 'close' } satisfies StatsWorkerRequest);
    const fallback = setTimeout(() => {
      void this.#worker.terminate().then(this.#finishClose, this.#finishClose);
    }, CLOSE_GRACE_MS);
    fallback.unref?.();
    try {
      await graceful;
    } finally {
      clearTimeout(fallback);
    }
  }

  #receive(message: StatsWorkerResponse): void {
    if (message.kind === 'closed') {
      this.#finishClose();
      return;
    }
    if (message.kind === 'invalid') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.kind === 'result' && pending.kind === 'compute') pending.resolve(message.result);
    else if (message.kind === 'probe-result' && pending.kind === 'probe') pending.resolve(message.value);
    else if (message.kind === 'error') {
      const error = new Error(message.message);
      if (message.stack) error.stack = message.stack;
      pending.reject(error);
    } else pending.reject(new Error('Stats worker response did not match its request'));
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #finishClose = (): void => {
    this.#resolveClose?.();
    this.#resolveClose = undefined;
  };
}

export function openStatsReader(dataDir: string): StatsWorkerClient {
  return new StatsWorkerClient(dataDir);
}
