import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attemptEvents, attempts, type AttemptState, attemptToolCalls, guardrailEvents, tasks, verificationAttempts, workspaces } from '../src/db/schema.js';
import { type GateReason, type SettledTaskAttempt, type SettleEventRow, StatsWorkerClient } from '../src/db/stats-reader.js';
import { type AttemptUsage } from '../src/execution/usage.js';
import { EventLoopMonitor, type StallInfo } from '../src/reliability/event-loop-monitor.js';
import { attemptsPerTask, byWorkspace, costPerMergedTask, gateOutcomes, guardrailTripsByDimension, tasksMergedByDay, verdicts, type WorkspaceAttempt } from '../src/server/stats-aggregates.js';
import { startServer, stubHarness, type TestServer } from './helpers.js';

describe('stats-async-path', () => {
  describe('Stats heavy aggregate runs in a worker (#257)', () => {
    let server: TestServer | undefined;

    afterEach(async () => {
      await server?.close();
    });

    it('wires the typed Stats worker client onto the app context', async () => {
      server = await startServer(stubHarness());
      expect(server.app.ctx.statsReader).toBeInstanceOf(StatsWorkerClient);
    });

    it('serves /api/stats through ctx.statsReader.read, with tool calls from their aggregate store', async () => {
      server = await startServer(stubHarness());
      const { ctx } = server.app;

      const now = Date.now();
      const ws = (await ctx.asyncDb.read((d) => d.select().from(workspaces).get()))!;
      const task = await ctx.asyncDb.write((d) =>
        d
          .insert(tasks)
          .values({ prompt: 'p', state: 'ready', workingDir: '/tmp', createdAt: now, updatedAt: now, workspaceId: ws.id })
          .returning()
          .get(),
      );
      const attempt = await ctx.asyncDb.write((d) =>
        d
          .insert(attempts)
          .values({
            taskId: task.id,
            number: 1,
            state: 'passed',
            startedAt: now,
            usage: JSON.stringify({ models: {}, totals: null, toolCalls: { Bash: 2 }, source: 'session-log' }),
          })
          .returning()
          .get(),
      );
      await ctx.asyncDb.write((d) => d.insert(attemptToolCalls).values({ attemptId: attempt.id, toolName: 'Read', count: 3 }).run());

      const readSpy = vi.spyOn(ctx.statsReader, 'read');
      const res = await server.api('GET', `/api/stats?from=0&to=${now + 1000}`);

      expect(res.status).toBe(200);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(res.body.attemptCount).toBe(1);
      expect(res.body.attemptsByState).toEqual({ completed: 1 });
      expect(res.body.toolCalls).toEqual({ Read: 3 });
    });

    it('scopes by workspace through the async read path (tasks join)', async () => {
      server = await startServer(stubHarness());
      const { ctx } = server.app;

      const now = Date.now();
      const ws = (await ctx.asyncDb.read((d) => d.select().from(workspaces).get()))!;
      const other = await ctx.asyncDb.write((d) =>
        d
          .insert(workspaces)
          .values({ name: 'Other', workingDir: '/tmp/other', createdAt: now, updatedAt: now })
          .returning()
          .get(),
      );
      const seed = async (workspaceId: number): Promise<void> => {
        const task = await ctx.asyncDb.write((d) =>
          d
            .insert(tasks)
            .values({ prompt: 'p', state: 'ready', workingDir: '/tmp', createdAt: now, updatedAt: now, workspaceId })
            .returning()
            .get(),
        );
        await ctx.asyncDb.write((d) =>
          d.insert(attempts).values({ taskId: task.id, number: 1, state: 'passed', startedAt: now }).run(),
        );
      };
      await seed(ws.id);
      await seed(other.id);

      const readSpy = vi.spyOn(ctx.statsReader, 'read');
      const scoped = await server.api('GET', `/api/stats?from=0&to=${now + 1000}&workspaceId=${other.id}`);

      expect(scoped.status).toBe(200);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(scoped.body.attemptCount).toBe(1);
    });

    it('keeps the event-loop monitor quiet during a deliberately heavy worker read', async () => {
      server = await startServer(stubHarness());
      const worker = new StatsWorkerClient(server.dataDir);
      const stalls: StallInfo[] = [];
      const monitor = new EventLoopMonitor({ probeMs: 10, stallMs: 100, onStall: (stall) => stalls.push(stall) });
      monitor.start();
      try {
        const startedAt = performance.now();
        const total = await worker.probeHeavyRead(6000);
        const elapsedMs = performance.now() - startedAt;
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(total).toBeGreaterThan(0);
        expect(elapsedMs).toBeGreaterThan(200);
        expect(stalls).toEqual([]);
      } finally {
        monitor.stop();
        await worker.close();
      }
    }, 30_000);

    it('gracefully closes the Stats worker and rejects later reads', async () => {
      server = await startServer(stubHarness());
      const reader = server.app.ctx.statsReader;
      const closeSpy = vi.spyOn(reader, 'close');
      await server.close();
      server = undefined;

      expect(closeSpy).toHaveBeenCalledOnce();
      await expect(reader.read({ from: 0, to: Date.now() })).rejects.toThrow('Stats worker is closed');
    });
  });
});

describe('stats-enriched', () => {
  describe('Enriched /stats aggregates (ADR-0014)', () => {
    let server: TestServer | undefined;

    afterEach(async () => {
      await server?.close();
    });

    const cost = (usd: number): string => JSON.stringify({ totalUsd: usd, byModel: { 'sonnet-5': usd }, incomplete: false });

    it('aggregates a 3-Attempt self-healed merged Task, verdicts, guardrails and per-workspace rows', async () => {
      server = await startServer(stubHarness());
      const { ctx } = server.app;
      const now = Date.now();
      const ws = (await ctx.asyncDb.read((d) => d.select().from(workspaces).get()))!;
      const other = await ctx.asyncDb.write((d) =>
        d.insert(workspaces).values({ name: 'other', workingDir: '/tmp/other', createdAt: now, updatedAt: now }).returning().get(),
      );

      const makeTask = (workspaceId: number) =>
        ctx.asyncDb.write((d) =>
          d
            .insert(tasks)
            .values({ prompt: 'p', state: 'done', workingDir: '/tmp', createdAt: now, updatedAt: now, workspaceId })
            .returning()
            .get(),
        );
      const makeAttempt = (taskId: number, number: number, state: AttemptState, usd: number) =>
        ctx.asyncDb.write((d) =>
          d
            .insert(attempts)
            .values({
              taskId,
              number,
              state,
              startedAt: now,
              endedAt: now,
              cost: cost(usd),
              usage: JSON.stringify({
                models: {},
                totals: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120 },
                toolCalls: {},
                source: 'acp',
              }),
            })
            .returning()
            .get(),
        );

      const healed = await makeTask(ws.id);
      const a1 = await makeAttempt(healed.id, 1, 'failed', 1);
      await makeAttempt(healed.id, 2, 'failed', 1);
      const a3 = await makeAttempt(healed.id, 3, 'passed', 2);
      await ctx.asyncDb.write((d) =>
        d
          .insert(attemptEvents)
          .values([
            { attemptId: a1.id, seq: 1, ts: now, type: 'lifecycle', payload: JSON.stringify({ event: 'escalated', reason: 'x', gate: 'conflict' }) },
            { attemptId: a3.id, seq: 1, ts: now, type: 'lifecycle', payload: JSON.stringify({ event: 'merged', oid: 'abc', baseBranch: 'develop' }) },
          ])
          .run(),
      );
      await ctx.asyncDb.write((d) =>
        d
          .insert(verificationAttempts)
          .values([
            { attemptId: a1.id, seq: 1, ts: now, mechanism: 'critic', inputOid: 'o1', verdict: 'fail', summary: 's', output: 'o' },
            { attemptId: a3.id, seq: 1, ts: now, mechanism: 'critic', inputOid: 'o2', verdict: 'pass', summary: 's', output: 'o' },
            { attemptId: a3.id, seq: 2, ts: now, mechanism: 'command', inputOid: 'o2', verdict: 'pass', summary: 's', output: 'o' },
          ])
          .run(),
      );
      await ctx.asyncDb.write((d) =>
        d
          .insert(guardrailEvents)
          .values([
            { attemptId: a1.id, seq: 1, ts: now, dimension: 'tokens', limitValue: 1, observedValue: 2, configSource: 'default' },
            { attemptId: a1.id, seq: 2, ts: now, dimension: 'tokens', limitValue: 1, observedValue: 3, configSource: 'default' },
            { attemptId: a1.id, seq: 3, ts: now, dimension: 'wall-clock', limitValue: 1, observedValue: 2, configSource: 'default' },
          ])
          .run(),
      );

      const reverted = await makeTask(other.id);
      const r1 = await makeAttempt(reverted.id, 1, 'escalated', 5);
      await ctx.asyncDb.write((d) =>
        d
          .insert(attemptEvents)
          .values({ attemptId: r1.id, seq: 1, ts: now, type: 'lifecycle', payload: JSON.stringify({ event: 'escalated', reason: 'red', gate: 'post-merge-red' }) })
          .run(),
      );

      const res = await server.api('GET', `/api/stats?from=0&to=${now + 1000}`);
      expect(res.status).toBe(200);
      const body = res.body;

      expect(body.tasksMergedByDay.reduce((sum: number, d: { count: number }) => sum + d.count, 0)).toBe(1);
      expect(body.attemptsPerTask).toEqual({ '1': 0, '2': 0, '3': 1, '4+': 0 });
      expect(body.costPerMergedTask.mergedTasks).toBe(1);
      expect(body.costPerMergedTask.mergedCost.totalUsd).toBeCloseTo(4);
      expect(body.costPerMergedTask.wastedCost.totalUsd).toBeCloseTo(5);

      expect(body.verdicts.critic).toEqual({ pass: 1, block: 1, inconclusive: 0 });
      expect(body.verdicts.command).toEqual({ pass: 1, block: 0, inconclusive: 0 });
      expect(body.gateOutcomes).toEqual({ autoMerged: 1, escalated: 0, revertedOnRed: 1 });
      expect(body.guardrailTrips).toEqual({ tokens: 1, 'wall-clock': 1 });

      expect(body.byWorkspace).toHaveLength(2);
      expect(body.byWorkspace[0].workspaceId).toBe(other.id);
      expect(body.byWorkspace[0].cost.totalUsd).toBeCloseTo(5);
      expect(body.byWorkspace[0].name).toBe('other');
    });

    it('scopes the enriched aggregates to a single workspace', async () => {
      server = await startServer(stubHarness());
      const { ctx } = server.app;
      const now = Date.now();
      const ws = (await ctx.asyncDb.read((d) => d.select().from(workspaces).get()))!;
      const other = await ctx.asyncDb.write((d) =>
        d.insert(workspaces).values({ name: 'other', workingDir: '/tmp/other', createdAt: now, updatedAt: now }).returning().get(),
      );
      const seedMerged = async (workspaceId: number): Promise<void> => {
        const task = await ctx.asyncDb.write((d) =>
          d.insert(tasks).values({ prompt: 'p', state: 'done', workingDir: '/tmp', createdAt: now, updatedAt: now, workspaceId }).returning().get(),
        );
        const a = await ctx.asyncDb.write((d) =>
          d.insert(attempts).values({ taskId: task.id, number: 1, state: 'passed', startedAt: now, endedAt: now, cost: cost(1) }).returning().get(),
        );
        await ctx.asyncDb.write((d) =>
          d.insert(attemptEvents).values({ attemptId: a.id, seq: 1, ts: now, type: 'lifecycle', payload: JSON.stringify({ event: 'merged', oid: 'x', baseBranch: 'develop' }) }).run(),
        );
      };
      await seedMerged(ws.id);
      await seedMerged(other.id);

      const scoped = await server.api('GET', `/api/stats?from=0&to=${now + 1000}&workspaceId=${other.id}`);
      expect(scoped.status).toBe(200);
      expect(scoped.body.gateOutcomes.autoMerged).toBe(1);
      expect(scoped.body.byWorkspace).toHaveLength(1);
      expect(scoped.body.byWorkspace[0].workspaceId).toBe(other.id);
    });
  });
});

describe('stats-route', () => {
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
});

describe('stats-aggregates', () => {
  const merged = (taskId: number, ts: number): SettleEventRow => ({ taskId, ts, kind: 'merged', gate: null });
  const escalated = (taskId: number, ts: number, gate: GateReason | null = null): SettleEventRow => ({
    taskId,
    ts,
    kind: 'escalated',
    gate,
  });
  const att = (taskId: number): SettledTaskAttempt => ({ taskId, cost: null });
  const cost = (usd: number | null, model = 'sonnet-5'): string =>
    JSON.stringify({ totalUsd: usd, byModel: { [model]: usd }, incomplete: usd === null });
  const usage = (input: number, output: number): string =>
    JSON.stringify({
      models: {},
      totals: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolCalls: {},
      source: 'acp',
    });

  const dayAt = (y: number, m: number, d: number, h = 12): number => new Date(y, m, d, h, 0, 0).getTime();

  describe('tasksMergedByDay (ADR-0014 §1)', () => {
    it('buckets a merge by its merge-event day and counts each Task once', () => {
      const jan15 = dayAt(2026, 0, 15);
      const jan16 = dayAt(2026, 0, 16);
      const series = tasksMergedByDay([merged(1, jan15), merged(2, jan15), merged(3, jan16)]);
      expect(series).toEqual([
        { day: new Date(jan15).setHours(0, 0, 0, 0), count: 2 },
        { day: new Date(jan16).setHours(0, 0, 0, 0), count: 1 },
      ]);
    });

    it('counts a self-healed Task once, on its merge day — an earlier escalation is not a settle', () => {
      const jan15 = dayAt(2026, 0, 15);
      const series = tasksMergedByDay([escalated(1, jan15 - 1000), merged(1, jan15)]);
      expect(series).toEqual([{ day: new Date(jan15).setHours(0, 0, 0, 0), count: 1 }]);
    });

    it('omits days with no merges and excludes never-merged Tasks', () => {
      const jan15 = dayAt(2026, 0, 15);
      expect(tasksMergedByDay([escalated(1, jan15)])).toEqual([]);
    });
  });

  describe('attemptsPerTask (ADR-0014 §2)', () => {
    it('buckets by Attempts-to-settle over merged Tasks; a 3-Attempt merged Task lands in 3×', () => {
      const settle = [escalated(1, 100), escalated(1, 200), merged(1, 300)];
      const attempts = [att(1), att(1), att(1)];
      expect(attemptsPerTask(settle, attempts)).toEqual({ '1': 0, '2': 0, '3': 1, '4+': 0 });
    });

    it('buckets first-try merges in 1× and 4-or-more in 4+', () => {
      const settle = [merged(1, 10), merged(2, 20)];
      const attempts = [att(1), att(2), att(2), att(2), att(2), att(2)];
      expect(attemptsPerTask(settle, attempts)).toEqual({ '1': 1, '2': 0, '3': 0, '4+': 1 });
    });

    it('excludes escalated (non-merged) Tasks even when their attempts are present', () => {
      const settle = [escalated(9, 10)];
      const attempts = [att(9), att(9)];
      expect(attemptsPerTask(settle, attempts)).toEqual({ '1': 0, '2': 0, '3': 0, '4+': 0 });
    });
  });

  describe('costPerMergedTask (ADR-0014 §3)', () => {
    it('sums merged spend over merged Tasks and reports reverted/abandoned spend as wasted', () => {
      const settle = [merged(1, 100), escalated(2, 100, 'post-merge-red'), escalated(3, 100)];
      const attempts = [
        { taskId: 1, cost: cost(2) },
        { taskId: 1, cost: cost(1) },
        { taskId: 2, cost: cost(4) },
        { taskId: 3, cost: cost(1.5) },
      ];
      const result = costPerMergedTask(settle, attempts);
      expect(result.mergedTasks).toBe(1);
      expect(result.mergedCost?.totalUsd).toBeCloseTo(3);
      expect(result.wastedCost?.totalUsd).toBeCloseTo(5.5);
    });

    it('null-sticks an unpriceable attempt (a floor, never a fake zero) per ADR-0008', () => {
      const settle = [merged(1, 100)];
      const attempts = [{ taskId: 1, cost: cost(2) }, { taskId: 1, cost: cost(null) }];
      const result = costPerMergedTask(settle, attempts);
      expect(result.mergedCost?.incomplete).toBe(true);
    });

    it('leaves cost null when nothing in range could be priced', () => {
      expect(costPerMergedTask([], []).mergedCost).toBeNull();
    });
  });

  describe('verdicts (ADR-0014 §4)', () => {
    it('counts critic verdicts (fail → block) and keeps command verdicts separate', () => {
      const result = verdicts([
        { mechanism: 'critic', verdict: 'pass' },
        { mechanism: 'critic', verdict: 'fail' },
        { mechanism: 'critic', verdict: 'inconclusive' },
        { mechanism: 'command', verdict: 'pass' },
        { mechanism: 'command', verdict: 'pass' },
      ]);
      expect(result.critic).toEqual({ pass: 1, block: 1, inconclusive: 1 });
      expect(result.command).toEqual({ pass: 2, block: 0, inconclusive: 0 });
    });
  });

  describe('gateOutcomes (ADR-0014 §5)', () => {
    it('classifies settled Tasks by their terminal gate; reverted-on-red is its own bucket', () => {
      const result = gateOutcomes([
        merged(1, 10),
        merged(2, 10),
        escalated(3, 10, 'conflict'),
        escalated(4, 10, 'post-merge-red'),
        escalated(5, 10),
      ]);
      expect(result).toEqual({ autoMerged: 2, escalated: 2, revertedOnRed: 1 });
    });

    it('counts a self-healed Task once, as auto-merged (terminal wins over its earlier escalation)', () => {
      expect(gateOutcomes([escalated(1, 100), merged(1, 200)])).toEqual({
        autoMerged: 1,
        escalated: 0,
        revertedOnRed: 0,
      });
    });
  });

  describe('guardrailTripsByDimension (ADR-0014 §6)', () => {
    it('counts an Attempt that tripped two dimensions in both', () => {
      const trips = [
        { attemptId: 1, dimension: 'tokens' },
        { attemptId: 1, dimension: 'wall-clock' },
        { attemptId: 2, dimension: 'tokens' },
      ];
      expect(guardrailTripsByDimension(trips)).toEqual({ tokens: 2, 'wall-clock': 1 });
    });
  });

  describe('byWorkspace (ADR-0014 §7)', () => {
    const workspaces = [
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ];
    const taskWorkspaces = [
      { taskId: 10, workspaceId: 1 },
      { taskId: 11, workspaceId: 1 },
      { taskId: 20, workspaceId: 2 },
    ];

    it('groups attempts by owning Workspace, splits tokens, and orders by cost', () => {
      const rows: WorkspaceAttempt[] = [
        { taskId: 10, state: 'passed', usage: usage(100, 20), cost: cost(1) },
        { taskId: 11, state: 'failed', usage: usage(50, 10), cost: cost(1) },
        { taskId: 20, state: 'passed', usage: usage(10, 5), cost: cost(9) },
      ];
      const result = byWorkspace(rows, taskWorkspaces, workspaces);
      expect(result.map((r) => r.workspaceId)).toEqual([2, 1]);
      const alpha = result.find((r) => r.workspaceId === 1)!;
      expect(alpha).toMatchObject({ name: 'alpha', inputTokens: 150, outputTokens: 30, tasks: 2 });
      expect(alpha.cost?.totalUsd).toBeCloseTo(2);
      expect(alpha.failureRate).toBeCloseTo(0.5);
    });

    it('returns a single row when the rows were already scoped to one Workspace', () => {
      const rows: WorkspaceAttempt[] = [{ taskId: 20, state: 'passed', usage: null, cost: cost(9) }];
      const result = byWorkspace(rows, taskWorkspaces, workspaces);
      expect(result).toHaveLength(1);
      expect(result[0]?.workspaceId).toBe(2);
    });

    it('reports a null failure rate for a Workspace whose attempts were all cancelled', () => {
      const rows: WorkspaceAttempt[] = [{ taskId: 10, state: 'cancelled', usage: null, cost: null }];
      const result = byWorkspace(rows, taskWorkspaces, workspaces);
      expect(result[0]?.failureRate).toBeNull();
    });
  });
});
