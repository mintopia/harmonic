import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from './helpers.js';
import { runFacts, runs } from '../src/db/schema.js';
import type { RunState } from '../src/db/schema.js';

/**
 * The KPI-band ingredients the stats route now derives (issue #196, ADR-0028):
 * the failed-only failure numerator and the active-execution duration
 * percentiles. Seeds runs + run_facts directly so the wiring — not just the pure
 * helpers — is exercised end to end.
 */
describe('GET /api/stats — failedRuns + durationMs', () => {
  let server: TestServer;
  let taskId: number;

  const seedRun = (r: {
    state: RunState;
    startedAt: number;
    finishedAt: number | null;
    review?: string | null;
    agentFinishTs?: number;
  }) => {
    const row = server.app.ctx.db
      .insert(runs)
      .values({
        taskId,
        attempt: 1,
        state: r.state,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        review: r.review ?? null,
      })
      .returning()
      .get();
    if (r.agentFinishTs !== undefined) {
      server.app.ctx.db
        .insert(runFacts)
        .values({ runId: row.id, seq: 1, ts: r.agentFinishTs, type: 'agent-finish/unresolved', payload: '{}' })
        .run();
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
    seedRun({ state: 'completed', startedAt: 1000, finishedAt: 100000, agentFinishTs: 4000 });
    //  B — no fact: falls back to wall-clock finished − started = 5000.
    seedRun({ state: 'completed', startedAt: 1000, finishedAt: 6000 });
    // A genuine execution failure — counts toward the failure numerator.
    seedRun({ state: 'failed', startedAt: 1000, finishedAt: null, review: null });
    // A review rejection settles to state:'failed' + review:'rejected' — must be
    // EXCLUDED from the failed-only numerator (the ADR-0028 trap).
    seedRun({ state: 'failed', startedAt: 1000, finishedAt: null, review: 'rejected' });
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
