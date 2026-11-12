import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { workflowStepRuns } from '../src/db/schema.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { normalizeStepRunUsage } from '../src/execution/usage.js';
import { startServer, type TestServer } from './helpers.js';

const raw = { inputTokens: 10, outputTokens: 1201, cachedReadTokens: 275249, cachedWriteTokens: 44585, totalTokens: 321045 };

describe('critic step-run usage on the task list', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startServer(); });
  afterAll(async () => { await server.close(); });

  const criticRun = async (taskId: number, usage: string) => {
    const store = new WorkflowStepRunStore(server.app.ctx.asyncDb);
    const row = await store.start({ taskId, workflowRef: 'w', stepId: 'review', position: 0, action: 'critic' });
    await store.setSession(row.id, { harness: 'claude', model: 'claude-sonnet-4-5' });
    await server.app.ctx.asyncDb.write((db) => db.update(workflowStepRuns).set({ usage }).where(eq(workflowStepRuns.id, row.id)).run());
  };

  it('legacy raw ACP usage and malformed rows never 500 the list; raw usage is costed', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'x' });
    const id = created.body.id;
    await criticRun(id, JSON.stringify(raw));
    await criticRun(id, '{not json');
    const list = await server.api('GET', '/api/tasks');
    expect(list.status).toBe(200);
    const one = await server.api('GET', `/api/tasks/${id}`);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).toContain('critic');
  });
});

describe('normalizeStepRunUsage', () => {
  it('maps legacy totals to the row model, passes canonical through, nulls junk', () => {
    expect(normalizeStepRunUsage(JSON.stringify(raw), null)!.models.unknown!.cacheReadTokens).toBe(275249);
    const canon = { models: { m: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }, totals: null, toolCalls: {}, source: 'acp' };
    expect(normalizeStepRunUsage(JSON.stringify(canon), 'x')).toEqual(canon);
    expect(normalizeStepRunUsage('{nope', 'x')).toBeNull();
    expect(normalizeStepRunUsage('null', 'x')).toBeNull();
  });
});
