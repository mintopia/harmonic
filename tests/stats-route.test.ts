import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from './helpers.js';
import { attempts } from '../src/db/schema.js';
import type { AttemptState } from '../src/db/schema.js';
import type { AttemptUsage } from '../src/execution/usage.js';

describe('GET /api/stats — failedAttempts + durationMs', () => {
  let server: TestServer;
  let taskId: number;
  let nextAttemptNumber = 1;

  const seedRun = async (r: {
    state: AttemptState;
    startedAt: number;
    finishedAt: number | null;
    reason?: string | null;
  }) => {
    const attemptNumber = nextAttemptNumber++;
    return server.app.ctx.asyncDb.write((d) =>
      d
        .insert(attempts)
        .values({
          taskId,
          number: attemptNumber,
          state: r.state,
          startedAt: r.startedAt,
          endedAt: r.finishedAt,
          reason: r.reason ?? null,
        })
        .returning()
        .get(),
    );
  };

  beforeAll(async () => {
    server = await startServer();
    const task = await server.api('POST', '/api/tasks', { prompt: 'stats seed' });
    taskId = task.body.id;

    await seedRun({ state: 'passed', startedAt: 1000, finishedAt: 100000 });
    await seedRun({ state: 'passed', startedAt: 1000, finishedAt: 6000 });
    await seedRun({ state: 'failed', startedAt: 1000, finishedAt: null, reason: 'failed' });
    await seedRun({ state: 'cancelled', startedAt: 1000, finishedAt: null, reason: 'operator-cancel' });
  });
  afterAll(async () => {
    await server.close();
  });

  it('failedAttempts is failed-only — the cancelled Run is excluded', async () => {
    const { status, body } = await server.api('GET', '/api/stats?from=0');
    expect(status).toBe(200);
    expect(body.attemptCount).toBe(4);
    expect(body.attemptsByState.failed).toBe(1);
    expect(body.attemptsByState.cancelled).toBe(1);
    expect(body.failedAttempts).toBe(1);
  });

  it('durationMs is p50/p95 of wall-clock active-execution durations', async () => {
    const { body } = await server.api('GET', '/api/stats?from=0');
    expect(body.durationMs).toEqual({ p50: 52000, p95: 94300 });
  });

  it('no longer reports a review-rejected slice (the review gate is gone)', async () => {
    const { body } = await server.api('GET', '/api/stats?from=0');
    expect(body).not.toHaveProperty('rejectedRuns');
    expect(body.failedAttempts).toBe(1);
  });

  it('buckets execution failures by their winning terminal disposition', async () => {
    const { body } = await server.api('GET', '/api/stats?from=0');
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
    expect(body.attemptCount).toBe(0);
    expect(body.failedAttempts).toBe(0);
    expect(body.durationMs).toBeNull();
  });
});

describe('GET /api/stats — per-tool output attribution', () => {
  let server: TestServer;
  let taskId: number;

  const usageJson = (usage: Partial<AttemptUsage>): string =>
    JSON.stringify({
      models: {},
      totals: null,
      toolCalls: {},
      source: 'session-log',
      ...usage,
    } satisfies AttemptUsage);

  beforeAll(async () => {
    server = await startServer();
    const task = await server.api('POST', '/api/tasks', { prompt: 'tool stats seed' });
    taskId = task.body.id;

    await server.app.ctx.asyncDb.write((d) =>
      d
        .insert(attempts)
        .values([
          {
            taskId,
            number: 1,
            state: 'passed',
            startedAt: 1_000,
            endedAt: 2_000,
            usage: usageJson({
              toolTokens: { Read: { outputTokens: 2, cost: 0.02 }, Bash: { outputTokens: 3, cost: 0.03 } },
              reasoning: { outputTokens: 4, cost: 0.04 },
            }),
          },
          {
            taskId,
            number: 2,
            state: 'passed',
            startedAt: 3_000,
            endedAt: 4_000,
            usage: usageJson({
              toolTokens: { Read: { outputTokens: 5, cost: 0.05 }, Edit: { outputTokens: 1, cost: 0.01 } },
            }),
          },
          {
            taskId,
            number: 3,
            state: 'passed',
            startedAt: 5_000,
            endedAt: 6_000,
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
    expect(body.attemptCount).toBe(1);
    expect(body).not.toHaveProperty('toolTokens');
    expect(body).not.toHaveProperty('reasoning');
  });
});
