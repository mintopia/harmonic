import { inArray } from 'drizzle-orm';
import type { AsyncTx } from '../db/async.js';
import {
  runs,
  runToolCalls,
  runEvents,
  runFacts,
  verificationAttempts,
  guardrailEvents,
  apiKeys,
} from '../db/schema.js';

/**
 * The async twin of the (now-removed) sync cascade helper, run inside an async
 * `Db.transaction` (ADR-0029) — child-before-parent deletion order, every
 * statement awaited. Deletes a set of Runs together with every row that
 * references them (issue #162): every table with an FK to `runs.id` is purged
 * first — `run_tool_calls`, `run_events`, `run_facts`, `verification_attempts`,
 * `guardrail_events` — plus the non-FK scoped `api_keys` rows that would
 * otherwise dangle once their Run is gone, then the `runs` themselves. This is
 * the one place the run-child set is enumerated, so both `TaskService.delete`
 * (a Task's Runs) and `WorkspaceService.delete` (a whole Workspace's Runs)
 * stay in step and a new FK-to-`runs` table is added in exactly one spot.
 * Sessions (a *parent* of a Run) are deliberately not touched here — each
 * caller decides that, since a Session can be shared across sibling Runs.
 * No-op on an empty `runIds`.
 */
export async function deleteRunsAndChildrenAsync(tx: AsyncTx, runIds: number[]): Promise<void> {
  if (runIds.length === 0) return;
  await tx.delete(runToolCalls).where(inArray(runToolCalls.runId, runIds)).run();
  await tx.delete(runEvents).where(inArray(runEvents.runId, runIds)).run();
  await tx.delete(runFacts).where(inArray(runFacts.runId, runIds)).run();
  await tx.delete(verificationAttempts).where(inArray(verificationAttempts.runId, runIds)).run();
  await tx.delete(guardrailEvents).where(inArray(guardrailEvents.runId, runIds)).run();
  // Not FK-declared, but a scoped Run key otherwise dangles once its Run is gone.
  await tx.delete(apiKeys).where(inArray(apiKeys.runId, runIds)).run();
  await tx.delete(runs).where(inArray(runs.id, runIds)).run();
}
