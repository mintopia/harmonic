import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from './helpers.js';
import { runFacts, runs } from '../src/db/schema.js';
import type { RunState } from '../src/db/schema.js';
import type { RunUsage } from '../src/execution/usage.js';

/**
 * The KPI-band ingredients the stats route now derives (issue #196, ADR-0028):
 * the failed-only failure numerator and the active-execution duration
 * percentiles. Seeds runs + run_facts directly so the wiring — not just the pure
 * helpers — is exercised end to end.
 */
describe('GET /api/stats — failedRuns + durationMs', () => {
  let server: TestServer;
  let taskId: number;

  const seedRun = async (r: {
    state: RunState;
    startedAt: number;
    finishedAt: number | null;
    review?: string | null;
    reason?: string | null;
    agentFinishTs?: number;
    /** Terminal disposition facts to append (type only; seq auto-assigned). */
    dispositions?: string[];
  }) => {
    const row = await server.app.ctx.asyncDb.write((d) =>
      d
        .insert(runs)
        .values({
          taskId,
          attempt: 1,
          state: r.state,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          review: r.review ?? null,
          reason: r.reason ?? null,
        })
        .returning()
        .get(),
    );
    let seq = 1;
    if (r.agentFinishTs !== undefined) {
      const ts = r.agentFinishTs;
      await server.app.ctx.asyncDb.write((d) =>
        d
          .insert(runFacts)
          .values({ runId: row.id, seq: seq++, ts, type: 'agent-finish/unresolved', payload: '{}' })
          .run(),
      );
    }
    for (const type of r.dispositions ?? []) {
      await server.app.ctx.asyncDb.write((d) =>
        d
          .insert(runFacts)
          .values({ runId: row.id, seq: seq++, ts: r.startedAt + seq, type: type as (typeof runFacts.$inferInsert)['type'], payload: '{}' })
          .run(),
      );
    }
    return row;
  };

  beforeAll(async () => {
    server = await startServer();
    const task = await server.api('POST', '/api/tasks', { prompt: 'stats seed' });
    taskId = task.body.id;

    // Two completed runs with measurable durations:
    //  A — agent-finish fact at 4000, finished far later (parked in review/landing):
    //      active duration is the fact span 3000, not the wall-clock 99000.
    await seedRun({ state: 'completed', startedAt: 1000, finishedAt: 100000, agentFinishTs: 4000 });
    //  B — no fact: falls back to wall-clock finished − started = 5000.
    await seedRun({ state: 'completed', startedAt: 1000, finishedAt: 6000 });
    // A genuine execution failure — counts toward the failure numerator and the
    // by-reason breakdown (its winning disposition is 'failed').
    await seedRun({ state: 'failed', startedAt: 1000, finishedAt: null, review: null, reason: 'boom', dispositions: ['failed'] });
    // A review rejection settles to state:'failed' + review:'rejected' — must be
    // EXCLUDED from the failed-only numerator (the ADR-0028 trap) and shown as a
    // distinct rejected slice, never in the by-reason breakdown.
    await seedRun({ state: 'failed', startedAt: 1000, finishedAt: null, review: 'rejected' });
  });
  afterAll(async () => {
    await server.close();
  });

  it('failedRuns is failed-only — the review rejection is excluded', async () => {
    const { status, body } = await server.api('GET', '/api/stats?from=0');
    expect(status).toBe(200);
    expect(body.runCount).toBe(4);
    // runsByState folds the rejection into failed (state alone can't tell them apart)…
    expect(body.runsByState.failed).toBe(2);
    // …but the honest numerator counts only the genuine failure.
    expect(body.failedRuns).toBe(1);
  });

  it('durationMs is p50/p95 of active-execution durations (agent-finish, wall-clock fallback)', async () => {
    const { body } = await server.api('GET', '/api/stats?from=0');
    // durations = [3000 (fact span), 5000 (fallback)] → p50 4000, p95 4900.
    expect(body.durationMs).toEqual({ p50: 4000, p95: 4900 });
  });

  it('splits review rejections out as their own slice, kept out of the failures', async () => {
    const { body } = await server.api('GET', '/api/stats?from=0');
    expect(body.rejectedRuns).toBe(1);
    // The failed-only run keeps failing; the rejection is not in the breakdown.
    expect(body.failedRuns).toBe(1);
  });

  it('buckets execution failures by their winning terminal disposition', async () => {
    const { body } = await server.api('GET', '/api/stats?from=0');
    // Only the genuine failure (disposition 'failed') appears; the rejection does not.
    expect(body.failuresByReason).toEqual({ failed: 1 });
  });

  it('reports failed-only fails per day in the series (rejection excluded)', async () => {
    const { body } = await server.api('GET', '/api/stats?from=0');
    const totalFails = body.series.reduce((sum: number, s: { fails: number }) => sum + s.fails, 0);
    expect(totalFails).toBe(1);
  });
});

describe('GET /api/stats — empty range', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('reports no failures and a null duration when nothing ran (honest numbers, never a fake 0)', async () => {
    const { status, body } = await server.api('GET', '/api/stats?from=0');
    expect(status).toBe(200);
    expect(body.runCount).toBe(0);
    expect(body.failedRuns).toBe(0);
    expect(body.durationMs).toBeNull();
  });
});

describe('GET /api/stats — per-tool output attribution', () => {
  let server: TestServer;
  let taskId: number;

  const usageJson = (usage: Partial<RunUsage>): string =>
    JSON.stringify({
      models: {},
      totals: null,
      toolCalls: {},
      source: 'session-log',
      ...usage,
    } satisfies RunUsage);

  beforeAll(async () => {
    server = await startServer();
    const task = await server.api('POST', '/api/tasks', { prompt: 'tool stats seed' });
    taskId = task.body.id;

    await server.app.ctx.asyncDb.write((d) =>
      d
        .insert(runs)
        .values([
          {
            taskId,
            attempt: 1,
            state: 'completed',
            startedAt: 1_000,
            finishedAt: 2_000,
            usage: usageJson({
              toolTokens: { Read: { outputTokens: 2, cost: 0.02 }, Bash: { outputTokens: 3, cost: 0.03 } },
              reasoning: { outputTokens: 4, cost: 0.04 },
            }),
          },
          {
            taskId,
            attempt: 2,
            state: 'completed',
            startedAt: 3_000,
            finishedAt: 4_000,
            usage: usageJson({
              toolTokens: { Read: { outputTokens: 5, cost: 0.05 }, Edit: { outputTokens: 1, cost: 0.01 } },
            }),
          },
          {
            taskId,
            attempt: 3,
            state: 'completed',
            startedAt: 5_000,
            finishedAt: 6_000,
            usage: usageJson({}),
          },
        ])
        .run(),
    );
  });

  afterAll(async () => {
    await server.close();
  });

  it('aggregates tool buckets and reasoning across the range, keeping missing attribution absent', async () => {
    const { status, body } = await server.api('GET', '/api/stats?from=0');
    expect(status).toBe(200);
    expect(body.toolTokens).toEqual({
      Read: { outputTokens: 7, cost: 0.07 },
      Bash: { outputTokens: 3, cost: 0.03 },
      Edit: { outputTokens: 1, cost: 0.01 },
    });
    expect(body.reasoning).toEqual({ outputTokens: 4, cost: 0.04 });
  });

  it('omits attribution for a range containing only legacy or unparseable usage', async () => {
    const { status, body } = await server.api('GET', '/api/stats?from=5000&to=6000');
    expect(status).toBe(200);
    expect(body.runCount).toBe(1);
    expect(body).not.toHaveProperty('toolTokens');
    expect(body).not.toHaveProperty('reasoning');
  });
});
