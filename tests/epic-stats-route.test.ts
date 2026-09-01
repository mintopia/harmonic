import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { startServer, type TestServer } from './helpers.js';
import { attempts, tasks, workspaces, type AttemptState } from '../src/db/schema.js';
import type { AttemptUsage } from '../src/execution/usage.js';

/**
 * The Epic-scoped Stats surface (issue #410, ADR-0014): same aggregation as
 * `GET /api/stats`, scoped to one Epic's child Tasks via `tasks.mapRef`. Seeds
 * Tasks/Attempts directly against the Task's row (the same style as
 * `stats-route.test.ts` and `tool-call-aggregates.test.ts`'s mapRef seeding),
 * so the route's param parsing and scope composition are exercised end to end.
 */
describe('GET /api/epics/:ref/stats', () => {
  let server: TestServer;
  let nextAttemptNumber = 1;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  const cost = (usd: number | null, model = 'sonnet-5'): string =>
    JSON.stringify({ totalUsd: usd, byModel: { [model]: usd }, incomplete: usd === null });

  const usageJson = (usage: Partial<AttemptUsage>): string =>
    JSON.stringify({
      models: {},
      totals: null,
      toolCalls: {},
      source: 'session-log',
      ...usage,
    } satisfies AttemptUsage);

  /** Create a native Task (default Workspace) and set its `mapRef` — the derived
   * Epic rollup key the scoped route filters on. */
  const seedEpicChildTask = async (mapRef: number, prompt = `epic ${mapRef} child`): Promise<number> => {
    const created = await server.api('POST', '/api/tasks', { prompt });
    const taskId = created.body.id as number;
    await server.app.ctx.asyncDb.write((d) => d.update(tasks).set({ mapRef }).where(eq(tasks.id, taskId)).run());
    return taskId;
  };

  /** Insert a Task directly into a given (non-default) Workspace, with `mapRef` set —
   * `POST /api/tasks` only creates in the default Workspace, so a second-Workspace
   * fixture needs a direct insert (mirrors `tool-call-aggregates.test.ts`). */
  const seedEpicChildTaskInWorkspace = async (workspaceId: number, mapRef: number): Promise<number> => {
    const now = Date.now();
    const row = await server.app.ctx.asyncDb.write((d) =>
      d
        .insert(tasks)
        .values({
          prompt: `epic ${mapRef} child (workspace ${workspaceId})`,
          workingDir: '/other-epic-workspace',
          state: 'ready',
          workspaceId,
          mapRef,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get(),
    );
    return row.id;
  };

  const seedAttempt = async (
    taskId: number,
    r: { state: AttemptState; startedAt: number; endedAt: number | null; cost?: string | null; usage?: string | null },
  ) => {
    const number = nextAttemptNumber++;
    return server.app.ctx.asyncDb.write((d) =>
      d
        .insert(attempts)
        .values({
          taskId,
          number,
          state: r.state,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          cost: r.cost ?? null,
          usage: r.usage ?? null,
        })
        .returning()
        .get(),
    );
  };

  describe('scope isolation and shape', () => {
    let epic100TaskId: number;
    let epic200TaskId: number;

    beforeAll(async () => {
      epic100TaskId = await seedEpicChildTask(100);
      epic200TaskId = await seedEpicChildTask(200);

      // Epic 100: two attempts, cost 2.00 + 3.00 = 5.00, 300 input / 150 output tokens.
      await seedAttempt(epic100TaskId, {
        state: 'passed',
        startedAt: 1_000,
        endedAt: 2_000,
        cost: cost(2),
        usage: usageJson({
          totals: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 150 },
        }),
      });
      await seedAttempt(epic100TaskId, {
        state: 'passed',
        startedAt: 3_000,
        endedAt: 4_000,
        cost: cost(3),
        usage: usageJson({
          totals: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 300 },
        }),
      });

      // Epic 200: one attempt, deliberately large cost/tokens — must never leak into epic 100's figures.
      await seedAttempt(epic200TaskId, {
        state: 'passed',
        startedAt: 1_000,
        endedAt: 2_000,
        cost: cost(9_999),
        usage: usageJson({
          totals: { inputTokens: 50_000, outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100_000 },
        }),
      });
    });

    it('scopes attemptCount, cost, and tokens to the epic ref — the other epic never leaks in', async () => {
      const { status, body } = await server.api('GET', '/api/epics/100/stats?from=0');
      expect(status).toBe(200);
      expect(body.attemptCount).toBe(2);
      expect(body.cost?.totalUsd).toBeCloseTo(5);
      expect(body.totals?.inputTokens).toBe(300);
      expect(body.totals?.outputTokens).toBe(150);
    });

    it('scopes byWorkspace to only the epic ref\'s own Tasks', async () => {
      const { body } = await server.api('GET', '/api/epics/100/stats?from=0');
      expect(body.byWorkspace).toHaveLength(1);
      expect(body.byWorkspace[0]).toMatchObject({ tasks: 1 });
      expect(body.byWorkspace[0].cost?.totalUsd).toBeCloseTo(5);
    });

    it('the sibling epic (200) sees only its own attempt, not epic 100\'s', async () => {
      const { body } = await server.api('GET', '/api/epics/200/stats?from=0');
      expect(body.attemptCount).toBe(1);
      expect(body.cost?.totalUsd).toBeCloseTo(9_999);
    });

    it('returns the same response shape as the fleet /api/stats surface', async () => {
      const fleet = await server.api('GET', '/api/stats?from=0');
      const epic = await server.api('GET', '/api/epics/100/stats?from=0');
      expect(fleet.status).toBe(200);
      expect(epic.status).toBe(200);
      const sharedKeys = [
        'attemptCount',
        'attemptsByState',
        'failedAttempts',
        'durationMs',
        'totals',
        'models',
        'cost',
        'series',
        'tasksMergedByDay',
        'attemptsPerTask',
        'costPerMergedTask',
        'verdicts',
        'gateOutcomes',
        'guardrailTrips',
        'byWorkspace',
      ];
      for (const key of sharedKeys) {
        expect(fleet.body).toHaveProperty(key);
        expect(epic.body).toHaveProperty(key);
      }
    });
  });

  describe('empty / unknown epic', () => {
    it('reports honest numbers — never a fabricated 0 or a fake cost — for an epic with no child Tasks', async () => {
      const { status, body } = await server.api('GET', '/api/epics/999999/stats?from=0');
      expect(status).toBe(200);
      expect(body.attemptCount).toBe(0);
      expect(body.cost).toBeNull();
      expect(body.durationMs).toBeNull();
    });
  });

  describe('optional workspaceId narrowing', () => {
    let defaultWorkspaceId: number;
    let otherWorkspaceId: number;

    beforeAll(async () => {
      defaultWorkspaceId = (await server.app.ctx.workspaces.list())[0]!.id;
      otherWorkspaceId = (
        await server.app.ctx.asyncDb.write((d) =>
          d
            .insert(workspaces)
            .values({ name: 'Other workspace', workingDir: '/epic-stats-other-workspace', createdAt: Date.now(), updatedAt: Date.now() })
            .returning()
            .get(),
        )
      ).id;

      const defaultTaskId = await seedEpicChildTask(300, 'epic 300 child (default workspace)');
      const otherTaskId = await seedEpicChildTaskInWorkspace(otherWorkspaceId, 300);

      await seedAttempt(defaultTaskId, { state: 'passed', startedAt: 1_000, endedAt: 2_000, cost: cost(7) });
      await seedAttempt(otherTaskId, { state: 'passed', startedAt: 1_000, endedAt: 2_000, cost: cost(70) });
    });

    it('narrows to the default Workspace\'s child Task when workspaceId is given', async () => {
      const { body } = await server.api('GET', `/api/epics/300/stats?from=0&workspaceId=${defaultWorkspaceId}`);
      expect(body.attemptCount).toBe(1);
      expect(body.cost?.totalUsd).toBeCloseTo(7);
    });

    it('narrows to the other Workspace\'s child Task when workspaceId is given', async () => {
      const { body } = await server.api('GET', `/api/epics/300/stats?from=0&workspaceId=${otherWorkspaceId}`);
      expect(body.attemptCount).toBe(1);
      expect(body.cost?.totalUsd).toBeCloseTo(70);
    });

    it('spans every Workspace holding a ref-300 child when workspaceId is omitted', async () => {
      const { body } = await server.api('GET', '/api/epics/300/stats?from=0');
      expect(body.attemptCount).toBe(2);
      expect(body.cost?.totalUsd).toBeCloseTo(77);
    });
  });

  describe('validation', () => {
    it('rejects a non-numeric :ref with a 400 validation envelope', async () => {
      const res = await server.api('GET', '/api/epics/not-a-number/stats');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'validation' } });
    });
  });
});
