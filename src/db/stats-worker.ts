import { createClient } from '@libsql/client';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { totalsForRange } from '../domain/tool-call-aggregates.js';
import { attemptEvents, attempts, guardrailEvents, tasks, verificationAttempts, workspaces } from './schema.js';
import * as schema from './schema.js';
import {
  isStatsWorkerRequest,
  type GateReason,
  type StatsRange,
  type StatsReadResult,
  type StatsWorkerResponse,
} from './stats-reader.js';

if (!parentPort) throw new Error('Stats worker requires a parent port');
if (!workerData || typeof workerData !== 'object' || !('dataDir' in workerData) || typeof workerData.dataDir !== 'string') {
  throw new Error('Stats worker requires a data directory');
}

const port = parentPort;
const client = createClient({ url: `file:${join(workerData.dataDir, 'harmonic.db')}` });
const db = drizzle(client, { schema });

async function readStats({ from, to, workspaceId }: StatsRange): Promise<StatsReadResult> {
  const rows =
    workspaceId === undefined
      ? await db.select().from(attempts).where(and(gte(attempts.startedAt, from), lte(attempts.startedAt, to))).all()
      : (
          await db
            .select({ attempts })
            .from(attempts)
            .innerJoin(tasks, eq(attempts.taskId, tasks.id))
            .where(and(gte(attempts.startedAt, from), lte(attempts.startedAt, to), eq(tasks.workspaceId, workspaceId)))
            .all()
        ).map((row) => row.attempts);

  // Failed-only Attempts' disposition (ADR-0001): the Attempt is the single
  // execution ledger, so its own `reason` column is read directly.
  const attemptReasons =
    workspaceId === undefined
      ? await db
          .select({ attemptId: attempts.id, reason: attempts.reason })
          .from(attempts)
          .where(and(eq(attempts.state, 'failed'), gte(attempts.startedAt, from), lte(attempts.startedAt, to)))
          .all()
      : await db
          .select({ attemptId: attempts.id, reason: attempts.reason })
          .from(attempts)
          .innerJoin(tasks, eq(attempts.taskId, tasks.id))
          .where(
            and(
              eq(attempts.state, 'failed'),
              gte(attempts.startedAt, from),
              lte(attempts.startedAt, to),
              eq(tasks.workspaceId, workspaceId),
            ),
          )
          .all();

  const range = { from, to, ...(workspaceId === undefined ? {} : { workspaceId }) };
  const toolTotals = await totalsForRange(db, range);

  // Workspace scope predicate, reused across the task-grain/verification/guardrail
  // scans below. `and()` drops the `undefined`, so an unscoped read carries no
  // extra filter; every table reaches its owning Workspace via attempt → task.
  const wsScope = workspaceId === undefined ? undefined : eq(tasks.workspaceId, workspaceId);

  const workspaceRows = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).all();

  // The owning Workspace of every Task an in-range Attempt belongs to — the join
  // key the per-Workspace breakdown groups by.
  const taskIds = [...new Set(rows.map((r) => r.taskId))];
  const taskWorkspaces =
    taskIds.length === 0
      ? []
      : await db
          .select({ taskId: tasks.id, workspaceId: tasks.workspaceId })
          .from(tasks)
          .where(inArray(tasks.id, taskIds))
          .all();

  // Settling facts (ADR-0014): `merged`/`escalated` lifecycle events whose ts is
  // in range. `json_extract` filters and projects the payload in SQLite so the
  // steer/finished/guardrail firehose never crosses into JS. `gate` carries the
  // merge-policy reason on an escalation, making reverted-on-red a real number.
  const eventKind = sql<'merged' | 'escalated'>`json_extract(${attemptEvents.payload}, '$.event')`;
  const eventGate = sql<GateReason | null>`json_extract(${attemptEvents.payload}, '$.gate')`;
  const settleEvents = await db
    .select({ taskId: attempts.taskId, ts: attemptEvents.ts, kind: eventKind, gate: eventGate })
    .from(attemptEvents)
    .innerJoin(attempts, eq(attemptEvents.attemptId, attempts.id))
    .innerJoin(tasks, eq(attempts.taskId, tasks.id))
    .where(
      and(
        eq(attemptEvents.type, 'lifecycle'),
        gte(attemptEvents.ts, from),
        lte(attemptEvents.ts, to),
        sql`json_extract(${attemptEvents.payload}, '$.event') in ('merged', 'escalated')`,
        wsScope,
      ),
    )
    .all();

  // Every Attempt of a Task that settled in range — its frozen cost, whatever
  // day the Attempt itself started. A self-heal Task's whole cost-to-settle and
  // Attempt count derive from these, counted once per Task downstream.
  const settledTaskIds = [...new Set(settleEvents.map((e) => e.taskId))];
  const settledTaskAttempts =
    settledTaskIds.length === 0
      ? []
      : await db
          .select({ taskId: attempts.taskId, cost: attempts.cost })
          .from(attempts)
          .where(inArray(attempts.taskId, settledTaskIds))
          .all();

  // Verification-attempt-grain verdicts in range, critic and command kept apart.
  const verifications = await db
    .select({ mechanism: verificationAttempts.mechanism, verdict: verificationAttempts.verdict })
    .from(verificationAttempts)
    .innerJoin(attempts, eq(verificationAttempts.attemptId, attempts.id))
    .innerJoin(tasks, eq(attempts.taskId, tasks.id))
    .where(and(gte(verificationAttempts.ts, from), lte(verificationAttempts.ts, to), wsScope))
    .all();

  // Distinct (Attempt, dimension) Guardrail trips in range: an Attempt that
  // tripped a dimension twice counts once, but one tripping two dimensions
  // counts in both.
  const guardrailTrips = await db
    .selectDistinct({ attemptId: guardrailEvents.attemptId, dimension: guardrailEvents.dimension })
    .from(guardrailEvents)
    .innerJoin(attempts, eq(guardrailEvents.attemptId, attempts.id))
    .innerJoin(tasks, eq(attempts.taskId, tasks.id))
    .where(and(gte(guardrailEvents.ts, from), lte(guardrailEvents.ts, to), wsScope))
    .all();

  return {
    rows,
    attemptReasons,
    toolTotals,
    workspaces: workspaceRows,
    taskWorkspaces,
    settleEvents,
    settledTaskAttempts,
    verifications,
    guardrailTrips,
  };
}

async function probeHeavyRead(iterations: number): Promise<number> {
  const result = await client.execute({
    sql: `with recursive n(i) as (
      values(1)
      union all
      select i + 1 from n where i < ?
    )
    select sum(a.i * b.i) as total from n a cross join n b`,
    args: [iterations],
  });
  const total = result.rows[0]?.total;
  if (typeof total === 'number') return total;
  if (typeof total === 'bigint' && total <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(total);
  throw new Error('Stats worker probe returned an invalid total');
}

let tail = Promise.resolve();
port.on('message', (message: unknown) => {
  if (!isStatsWorkerRequest(message)) throw new Error('Stats worker received an invalid request');
  const request = message;
  tail = tail.then(async () => {
    if (request.kind === 'close') {
      client.close();
      port.postMessage({ kind: 'closed' } satisfies StatsWorkerResponse);
      port.close();
      return;
    }
    try {
      if (request.kind === 'probe') {
        const value = await probeHeavyRead(request.iterations);
        port.postMessage({ kind: 'probe-result', id: request.id, value } satisfies StatsWorkerResponse);
        return;
      }
      const result = await readStats(request.range);
      port.postMessage({ kind: 'result', id: request.id, result } satisfies StatsWorkerResponse);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      port.postMessage({ kind: 'error', id: request.id, message, ...(stack ? { stack } : {}) } satisfies StatsWorkerResponse);
    }
  });
});
