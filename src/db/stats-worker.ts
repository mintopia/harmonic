import { createClient } from '@libsql/client';
import { and, eq, gte, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { totalsForRange } from '../domain/tool-call-aggregates.js';
import { attempts, runs, tasks } from './schema.js';
import * as schema from './schema.js';
import {
  isStatsWorkerRequest,
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
      ? await db.select().from(runs).where(and(gte(runs.startedAt, from), lte(runs.startedAt, to))).all()
      : (
          await db
            .select({ runs })
            .from(runs)
            .innerJoin(tasks, eq(runs.taskId, tasks.id))
            .where(and(gte(runs.startedAt, from), lte(runs.startedAt, to), eq(tasks.workspaceId, workspaceId)))
            .all()
        ).map((row) => row.runs);

  // Failed-only Runs' Attempt disposition (ADR-0001 #388 S-E): joined by the
  // (taskId, attempt=number) pair every Run/Attempt pair shares — replaces the
  // deleted `run_facts` disposition-fact join.
  const attemptReasons =
    workspaceId === undefined
      ? await db
          .select({ runId: runs.id, reason: attempts.reason })
          .from(runs)
          .leftJoin(attempts, and(eq(attempts.taskId, runs.taskId), eq(attempts.number, runs.attempt)))
          .where(and(eq(runs.state, 'failed'), gte(runs.startedAt, from), lte(runs.startedAt, to)))
          .all()
      : await db
          .select({ runId: runs.id, reason: attempts.reason })
          .from(runs)
          .leftJoin(attempts, and(eq(attempts.taskId, runs.taskId), eq(attempts.number, runs.attempt)))
          .innerJoin(tasks, eq(runs.taskId, tasks.id))
          .where(
            and(
              eq(runs.state, 'failed'),
              gte(runs.startedAt, from),
              lte(runs.startedAt, to),
              eq(tasks.workspaceId, workspaceId),
            ),
          )
          .all();

  const range = { from, to, ...(workspaceId === undefined ? {} : { workspaceId }) };
  const toolTotals = await totalsForRange(db, range);
  return { rows, attemptReasons, toolTotals };
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
