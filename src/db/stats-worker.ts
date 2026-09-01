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

async function readStats({ from, to, workspaceId, epicRef }: StatsRange): Promise<StatsReadResult> {
  const scoped = workspaceId !== undefined || epicRef !== undefined;
  const taskScope = and(
    workspaceId === undefined ? undefined : eq(tasks.workspaceId, workspaceId),
    epicRef === undefined ? undefined : eq(tasks.mapRef, epicRef),
  );

  const rows = !scoped
    ? await db.select().from(attempts).where(and(gte(attempts.startedAt, from), lte(attempts.startedAt, to))).all()
    : (
        await db
          .select({ attempts })
          .from(attempts)
          .innerJoin(tasks, eq(attempts.taskId, tasks.id))
          .where(and(gte(attempts.startedAt, from), lte(attempts.startedAt, to), taskScope))
          .all()
      ).map((row) => row.attempts);

  const attemptReasons = !scoped
    ? await db
        .select({ attemptId: attempts.id, reason: attempts.reason })
        .from(attempts)
        .where(and(eq(attempts.state, 'failed'), gte(attempts.startedAt, from), lte(attempts.startedAt, to)))
        .all()
    : await db
        .select({ attemptId: attempts.id, reason: attempts.reason })
        .from(attempts)
        .innerJoin(tasks, eq(attempts.taskId, tasks.id))
        .where(and(eq(attempts.state, 'failed'), gte(attempts.startedAt, from), lte(attempts.startedAt, to), taskScope))
        .all();

  const range = {
    from,
    to,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(epicRef === undefined ? {} : { epicRef }),
  };
  const toolTotals = await totalsForRange(db, range);

  const workspaceRows = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).all();

  const taskIds = [...new Set(rows.map((r) => r.taskId))];
  const taskWorkspaces =
    taskIds.length === 0
      ? []
      : await db
          .select({ taskId: tasks.id, workspaceId: tasks.workspaceId })
          .from(tasks)
          .where(inArray(tasks.id, taskIds))
          .all();

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
        taskScope,
      ),
    )
    .all();

  const settledTaskIds = [...new Set(settleEvents.map((e) => e.taskId))];
  const settledTaskAttempts =
    settledTaskIds.length === 0
      ? []
      : await db
          .select({ taskId: attempts.taskId, cost: attempts.cost })
          .from(attempts)
          .where(inArray(attempts.taskId, settledTaskIds))
          .all();

  const verifications = await db
    .select({ mechanism: verificationAttempts.mechanism, verdict: verificationAttempts.verdict })
    .from(verificationAttempts)
    .innerJoin(attempts, eq(verificationAttempts.attemptId, attempts.id))
    .innerJoin(tasks, eq(attempts.taskId, tasks.id))
    .where(and(gte(verificationAttempts.ts, from), lte(verificationAttempts.ts, to), taskScope))
    .all();

  const guardrailTrips = await db
    .selectDistinct({ attemptId: guardrailEvents.attemptId, dimension: guardrailEvents.dimension })
    .from(guardrailEvents)
    .innerJoin(attempts, eq(guardrailEvents.attemptId, attempts.id))
    .innerJoin(tasks, eq(attempts.taskId, tasks.id))
    .where(and(gte(guardrailEvents.ts, from), lte(guardrailEvents.ts, to), taskScope))
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
