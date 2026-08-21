import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor } from './helpers.js';
import { workContextLeases } from '../src/db/schema.js';

const scenario = (s: object) => JSON.stringify(s);

/**
 * Light integration coverage for the coordinator-driven Work Context lease
 * heartbeat (issue #122): a live afk-direct Run's lease keeps a non-null
 * expiry that advances on the wall-clock heartbeat cadence and stays `held`
 * while the Run is genuinely alive. The store-level deterministic tests
 * (`tests/lease-ttl.test.ts`, `tests/work-context-lease.test.ts`) are the
 * primary AC coverage; this only exercises the live Runner + app wiring
 * end to end, polling via `waitFor` rather than racing a fixed sleep against
 * the timer so it isn't flaky under CI scheduling jitter.
 */
describe('Work Context lease heartbeat wiring (issue #122)', () => {
  it("a live Run's lease has a non-null expiry that advances on the heartbeat cadence and stays held", async () => {
    const server = await startServer(stubHarness(), { leaseTuning: { heartbeatMs: 20 } });
    try {
      const created = await server.api('POST', '/api/tasks', { prompt: scenario({ exit: 'hang' }) });
      expect(created.status).toBe(201);
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      expect(started.status).toBe(201);
      const runId = started.body.id;

      await waitFor(async () => (await server.api('GET', `/api/runs/${runId}`)).body.state === 'running');

      const db = server.app.ctx.asyncDb;
      const leaseFor = () => db.read((d) => d.select().from(workContextLeases).where(eq(workContextLeases.ownerRunId, runId)).get());

      const first = await waitFor(async () => {
        const row = await leaseFor();
        return row?.expiry != null ? row : undefined;
      });
      expect(first.state).toBe('held');

      const second = await waitFor(async () => {
        const row = await leaseFor();
        return row && row.expiry != null && row.expiry > first.expiry! ? row : undefined;
      });
      expect(second.state).toBe('held');
    } finally {
      await server.close();
    }
  });
});
