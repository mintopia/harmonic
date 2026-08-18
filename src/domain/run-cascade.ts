import { inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  runs,
  runEvents,
  runFacts,
  landingJournal,
  turnQueue,
  verificationAttempts,
  guardrailEvents,
  workContextLeases,
  apiKeys,
} from '../db/schema.js';

/** The transaction handle drizzle hands a `db.transaction((tx) => …)` callback —
 * structurally the same query surface as {@link Db}, extracted so a cascade
 * helper can run inside either service's transaction. */
export type CascadeTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Delete a set of Runs together with every row that references them, in
 * child-before-parent order so it holds under `foreign_keys = ON` (issue #162).
 * Every table with an FK to `runs.id` is purged first — `run_events`,
 * `run_facts`, `landing_journal`, `turn_queue`, `verification_attempts`,
 * `guardrail_events`, `work_context_leases` (via `ownerRunId`) — plus the
 * non-FK scoped `api_keys` rows that would otherwise dangle once their Run is
 * gone, then the `runs` themselves. This is the one place the run-child set is
 * enumerated, so both `TaskService.delete` (a Task's Runs) and
 * `WorkspaceService.delete` (a whole Workspace's Runs) stay in step and a new
 * FK-to-`runs` table is added in exactly one spot. Sessions (a *parent* of a
 * Run) are deliberately not touched here — each caller decides that, since a
 * Session can be shared across sibling Runs. No-op on an empty `runIds`.
 */
export function deleteRunsAndChildren(tx: CascadeTx, runIds: number[]): void {
  if (runIds.length === 0) return;
  tx.delete(runEvents).where(inArray(runEvents.runId, runIds)).run();
  tx.delete(runFacts).where(inArray(runFacts.runId, runIds)).run();
  tx.delete(landingJournal).where(inArray(landingJournal.runId, runIds)).run();
  tx.delete(turnQueue).where(inArray(turnQueue.runId, runIds)).run();
  tx.delete(verificationAttempts).where(inArray(verificationAttempts.runId, runIds)).run();
  tx.delete(guardrailEvents).where(inArray(guardrailEvents.runId, runIds)).run();
  tx.delete(workContextLeases).where(inArray(workContextLeases.ownerRunId, runIds)).run();
  // Not FK-declared, but a scoped Run key otherwise dangles once its Run is gone.
  tx.delete(apiKeys).where(inArray(apiKeys.runId, runIds)).run();
  tx.delete(runs).where(inArray(runs.id, runIds)).run();
}
