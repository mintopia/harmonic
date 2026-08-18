import type { RunRow, TaskRow, WorkContextLeaseRow, LeaseState } from '../db/schema.js';
import { workContextKey } from './work-context-key.js';

/**
 * One Work Context lease's operator-facing diagnostic row (issue #125,
 * ADR-0022, reliability-design §0.5): a lease joined against its owning Run
 * and Task, plus the ready Tasks it is blocking — the surface an operator
 * reads to decide whether to `supersede` or `unlock` a stuck context. Every
 * `held` or `suspect` lease gets exactly one entry.
 */
export interface LeaseDiagnostic {
  key: string;
  state: LeaseState;
  phase: string;
  ownerRunId: number;
  /** The owning Run's Task id; null if the owning Run row no longer exists
   * (a defensive case — Run rows are never deleted today, but the join
   * shouldn't throw if that ever changes). */
  ownerTaskId: number | null;
  ownerTaskTitle: string | null;
  ownerTaskState: string | null;
  acquiredAt: number;
  heartbeat: number | null;
  expiry: number | null;
  /** How long the longest-waiting `ready` direct-mode Task blocked on this
   * context has been waiting, in ms as of `now`; null when nothing is waiting
   * (or none of the waiters has a tracked wait-start). */
  longestWaitMs: number | null;
  /** Count of `ready` direct-mode Tasks whose Work Context key matches this
   * lease's — the queue-diagnostics half of the surface (issue #125's "queue
   * diagnostics"). */
  waitingTaskCount: number;
}

/**
 * Build the operator diagnostics view over every currently-persisted lease
 * (issue #125). Pure: no clock, no I/O — `now` and `waitingSince` are passed
 * in, matching the house style for domain modules that sit downstream of a
 * store read (`guardrail-budget.ts`, `lease-ttl.ts`).
 *
 * A lease's owner is resolved by joining `runs`/`tasks` in memory rather than
 * querying — the caller already has both lists from a single pick pass, and
 * this keeps the function trivially unit-testable without a database. Waiting
 * Tasks are computed the same way `AutoRunner`'s House Rule predicate derives
 * direct-mode occupancy (`work-context-key.ts`'s `workContextKey`) — a `ready`
 * direct-mode Task whose key matches `lease.key` is "blocked on this lease".
 * Worktree-mode leases never have direct-mode waiters by construction (their
 * key format is disjoint from a direct key's), so they always report zero.
 */
export function buildLeaseDiagnostics(input: {
  leases: WorkContextLeaseRow[];
  runs: RunRow[];
  tasks: TaskRow[];
  waitingSince: (taskId: number) => number | undefined;
  now: number;
}): LeaseDiagnostic[] {
  const { leases, runs, tasks, waitingSince, now } = input;
  const runsById = new Map(runs.map((r) => [r.id, r]));
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  // Ready direct-mode Tasks, grouped by the Work Context key they'd occupy —
  // computed once, not per-lease, since it doesn't depend on the lease.
  const readyByKey = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    if (t.state !== 'ready' || t.isolationMode !== 'direct') continue;
    const key = workContextKey({ isolationMode: 'direct', workingDir: t.workingDir });
    const bucket = readyByKey.get(key);
    if (bucket) bucket.push(t);
    else readyByKey.set(key, [t]);
  }

  return leases.map((lease) => {
    const ownerRun = runsById.get(lease.ownerRunId);
    const ownerTask = ownerRun ? tasksById.get(ownerRun.taskId) : undefined;

    const waiters = readyByKey.get(lease.key) ?? [];
    const waits = waiters.map((t) => waitingSince(t.id)).filter((since): since is number => since !== undefined);
    const longestWaitMs = waits.length > 0 ? Math.max(...waits.map((since) => now - since)) : null;

    return {
      key: lease.key,
      state: lease.state,
      phase: lease.phase,
      ownerRunId: lease.ownerRunId,
      ownerTaskId: ownerRun?.taskId ?? null,
      ownerTaskTitle: ownerTask?.prompt ?? null,
      ownerTaskState: ownerTask?.state ?? null,
      acquiredAt: lease.acquiredAt,
      heartbeat: lease.heartbeat,
      expiry: lease.expiry,
      longestWaitMs,
      waitingTaskCount: waiters.length,
    };
  });
}
