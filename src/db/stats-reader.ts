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
  /**
   * Scope to one Epic's child Tasks (issue #410, ADR-0014): the Attempts of the
   * Tasks whose derived Epic rollup key (`tasks.mapRef`) is this ref. `mapRef`
   * is the canonical Epic/Map rollup key across the domain — for a mirrored
   * child it holds the parent Epic ref (equal to the raw `trackerParent`), and
   * it is the same key the per-Epic tool-call rollup already groups on. Composes
   * with `workspaceId`; omitted means no Epic scope.
   */
  epicRef?: number;
}

/** The merge-policy escalation reason (merge-policy.ts `MergePolicyOutcome`): a
 * closed set, so the reverted-on-red compare is a typo-proof literal. */
export type GateReason = 'conflict' | 'post-merge-red';

/** A settling lifecycle fact (ADR-0014): one `merged`/`escalated` event a Task's
 * Attempt recorded, carrying the merge day and — for an escalation — the merge
 * gate that produced it, so `reverted-on-red` is a first-class number, not a
 * message substring. */
export interface SettleEventRow {
  taskId: number;
  ts: number;
  kind: 'merged' | 'escalated';
  /** The merge gate reason on an escalation; null otherwise. */
  gate: GateReason | null;
}

/** id→name for one Workspace, so the per-Workspace breakdown can label rows. */
export interface WorkspaceNameRow {
  id: number;
  name: string;
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

/** One verification-attempt-grain verdict: mechanism (`critic`/`command`) and
 * verdict (`pass`/`fail`/`inconclusive`), counted separately per ADR-0014. */
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
  /** Failed-only Attempts' disposition (ADR-0001): `attempts.reason` keyed
   * by the Attempt's id. */
  attemptReasons: Array<{ attemptId: number; reason: string | null }>;
  toolTotals: ToolCallTotals;
  workspaces: WorkspaceNameRow[];
  /** The owning Workspace of every Task referenced by an in-range Attempt row. */
  taskWorkspaces: TaskWorkspaceRow[];
  /** Merge/escalation settling events whose ts falls in range (ADR-0014). */
  settleEvents: SettleEventRow[];
  /** Every Attempt of a Task that settled in range — covers Attempts started
   * before the range, so a self-heal Task's full cost-to-settle and
   * Attempt-count are honest. */
  settledTaskAttempts: SettledTaskAttempt[];
  /** Verification-attempt-grain verdicts in range, critic and command apart. */
  verifications: VerificationRow[];
  /** Distinct (Attempt, dimension) Guardrail trips in range — one row per Attempt
   * per dimension, so an Attempt tripping two dimensions counts in both. */
  guardrailTrips: GuardrailTripRow[];
}

export interface StatsReader {
  read(range: StatsRange, opts?: QueryTimeoutOptions): Promise<StatsReadResult>;
  close(): Promise<void>;
}

export type StatsWorkerRequest =
  | { kind: 'read'; id: number; range: StatsRange }
  | { kind: 'probe'; id: number; iterations: number }
  | { kind: 'close' };
export type StatsWorkerResponse =
  | { kind: 'result'; id: number; result: StatsReadResult }
  | { kind: 'probe-result'; id: number; value: number }
  | { kind: 'error'; id: number; message: string; stack?: string }
  | { kind: 'closed' };

const CLOSE_GRACE_MS = 5_000;

type PendingRequest = {
  kind: 'read';
  resolve: (result: StatsReadResult) => void;
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
    && (value.epicRef === undefined || typeof value.epicRef === 'number');
}

export function isStatsWorkerRequest(value: unknown): value is StatsWorkerRequest {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'close') return true;
  if (!isId(value.id)) return false;
  if (value.kind === 'read') return isStatsRange(value.range);
  return value.kind === 'probe'
    && typeof value.iterations === 'number'
    && Number.isSafeInteger(value.iterations)
    && value.iterations > 0
    && value.iterations <= 10_000;
}

function isTotalsDimension(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(
    (bucket) => isRecord(bucket) && Object.values(bucket).every((count) => typeof count === 'number'),
  );
}

function isStatsReadResult(value: unknown): value is StatsReadResult {
  return isRecord(value)
    && Array.isArray(value.rows)
    && value.rows.every(isRecord)
    && Array.isArray(value.attemptReasons)
    && value.attemptReasons.every(
      (row) => isRecord(row) && typeof row.attemptId === 'number' && (row.reason === null || typeof row.reason === 'string'),
    )
    && isRecord(value.toolTotals)
    && isTotalsDimension(value.toolTotals.byTask)
    && isTotalsDimension(value.toolTotals.byEpic)
    && Array.isArray(value.workspaces)
    && value.workspaces.every((row) => isRecord(row) && typeof row.id === 'number' && typeof row.name === 'string')
    && Array.isArray(value.taskWorkspaces)
    && value.taskWorkspaces.every(
      (row) => isRecord(row) && typeof row.taskId === 'number' && (row.workspaceId === null || typeof row.workspaceId === 'number'),
    )
    && Array.isArray(value.settleEvents)
    && value.settleEvents.every(
      (row) =>
        isRecord(row)
        && typeof row.taskId === 'number'
        && typeof row.ts === 'number'
        && (row.kind === 'merged' || row.kind === 'escalated')
        && (row.gate === null || typeof row.gate === 'string'),
    )
    && Array.isArray(value.settledTaskAttempts)
    && value.settledTaskAttempts.every(
      (row) => isRecord(row) && typeof row.taskId === 'number' && (row.cost === null || typeof row.cost === 'string'),
    )
    && Array.isArray(value.verifications)
    && value.verifications.every(
      (row) => isRecord(row) && typeof row.mechanism === 'string' && typeof row.verdict === 'string',
    )
    && Array.isArray(value.guardrailTrips)
    && value.guardrailTrips.every((row) => isRecord(row) && typeof row.attemptId === 'number' && typeof row.dimension === 'string');
}

function isStatsWorkerResponse(value: unknown): value is StatsWorkerResponse {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'closed') return true;
  if (!isId(value.id)) return false;
  if (value.kind === 'result') return isStatsReadResult(value.result);
  if (value.kind === 'probe-result') return typeof value.value === 'number' && Number.isFinite(value.value);
  return value.kind === 'error'
    && typeof value.message === 'string'
    && (value.stack === undefined || typeof value.stack === 'string');
}

/** Typed RPC client for the one heavy read Harmonic currently runs off-loop. */
export class StatsWorkerClient implements StatsReader {
  readonly #worker: Worker;
  readonly #defaultTimeoutMs: number;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #resolveClose: (() => void) | undefined;

  constructor(dataDir: string, defaultTimeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS) {
    this.#defaultTimeoutMs = defaultTimeoutMs;
    const jsEntry = new URL('./stats-worker.js', import.meta.url);
    const runningFromSource = !existsSync(fileURLToPath(jsEntry));
    this.#worker = new Worker(runningFromSource ? new URL('./stats-worker.ts', import.meta.url) : jsEntry, {
      workerData: { dataDir },
      ...(runningFromSource ? { execArgv: ['--import', 'tsx'] } : {}),
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

  read(range: StatsRange, opts?: QueryTimeoutOptions): Promise<StatsReadResult> {
    if (this.#closed) return Promise.reject(new Error('Stats worker is closed'));
    const id = this.#nextId++;
    return new Promise<StatsReadResult>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? this.#defaultTimeoutMs;
      const pending: PendingRequest = { kind: 'read', resolve, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new QueryTimeoutError('read', timeoutMs));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.#pending.set(id, pending);
      this.#worker.postMessage({ kind: 'read', id, range } satisfies StatsWorkerRequest);
    });
  }

  /** Test-only fixed-shape load probe. It never accepts SQL from the caller. */
  probeHeavyRead(iterations: number, opts?: QueryTimeoutOptions): Promise<number> {
    if (this.#closed) return Promise.reject(new Error('Stats worker is closed'));
    if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > 10_000) {
      return Promise.reject(new Error('Stats worker probe iterations must be an integer from 1 to 10000'));
    }
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
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.kind === 'result' && pending.kind === 'read') pending.resolve(message.result);
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

export function openStatsReader(dataDir: string): StatsReader {
  return new StatsWorkerClient(dataDir);
}
