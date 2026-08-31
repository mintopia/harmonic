import { describe, it, expect, afterEach } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';
import {
  attemptEvents,
  attempts,
  guardrailEvents,
  tasks,
  verificationAttempts,
  workspaces,
  type AttemptState,
} from '../src/db/schema.js';

/**
 * ADR-0014: the task-grain, verification, guardrail & per-Workspace aggregates,
 * exercised end to end through the off-event-loop Stats worker (issue #200) so
 * the new reads (attempt_events / verification_attempts / guardrail_events, the
 * task→workspace join) are proven against a real WAL, not just in unit isolation.
 */
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

    // A self-healed merged Task in the default workspace: escalate, escalate, merge.
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
    // Verdicts: two critic passes + a critic fail (→ block), one command pass.
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
    // Attempt a1 tripped two guardrail dimensions; the tokens dimension twice.
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

    // A reverted-on-red Task in the other workspace.
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

    // Task-grain: the self-healed Task counts once, as a 3× merge.
    expect(body.tasksMergedByDay.reduce((sum: number, d: { count: number }) => sum + d.count, 0)).toBe(1);
    expect(body.attemptsPerTask).toEqual({ '1': 0, '2': 0, '3': 1, '4+': 0 });
    expect(body.costPerMergedTask.mergedTasks).toBe(1);
    expect(body.costPerMergedTask.mergedCost.totalUsd).toBeCloseTo(4); // 1 + 1 + 2 over the merged task's attempts
    expect(body.costPerMergedTask.wastedCost.totalUsd).toBeCloseTo(5); // the reverted task's spend

    // Verification & gate & guardrails.
    expect(body.verdicts.critic).toEqual({ pass: 1, block: 1, inconclusive: 0 });
    expect(body.verdicts.command).toEqual({ pass: 1, block: 0, inconclusive: 0 });
    expect(body.gateOutcomes).toEqual({ autoMerged: 1, escalated: 0, revertedOnRed: 1 });
    expect(body.guardrailTrips).toEqual({ tokens: 1, 'wall-clock': 1 });

    // Per-workspace: two rows, ordered by cost (other = 5 outranks default = 4).
    expect(body.byWorkspace).toHaveLength(2);
    expect(body.byWorkspace[0].workspaceId).toBe(other.id); // highest cost first
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
    expect(scoped.body.gateOutcomes.autoMerged).toBe(1); // only the scoped workspace's merge
    expect(scoped.body.byWorkspace).toHaveLength(1);
    expect(scoped.body.byWorkspace[0].workspaceId).toBe(other.id);
  });
});
