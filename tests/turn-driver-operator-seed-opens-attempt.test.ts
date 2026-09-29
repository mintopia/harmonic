import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppConfig, type DeepPartial } from '../src/config.js';
import { startServer, stubHarness, type TestServer, waitFor } from './helpers.js';
import type { ActiveRuns } from '../src/execution/active-runs.js';

/**
 * Regression for issue: a pending operator seed replaced `promptText` entirely
 * whenever the bound Attempt had a `sessionRowId` — even when that Session was
 * only opportunistically reused for this Attempt's own opening turn
 * (`bindContinuationIfEligible`, e.g. a normal re-run of a Task with a recent
 * warm Session), as opposed to a genuine manual resume/steer-continue of an
 * Attempt already under way. In the former case the real instructions must
 * still be sent, with the operator's message appended, not swapped in.
 */
describe('operator seed on an Attempt that opens with a warm, opportunistically-reused Session', () => {
  let server: TestServer;

  beforeAll(async () => {
    const overrides = stubHarness() as DeepPartial<AppConfig>;
    overrides.harnesses!.claude!.cacheWarmSeconds = 600;
    overrides.maxAttempts = 1;
    overrides.drive = {
      prompt: JSON.stringify({
        updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking' } }],
        stopReason: 'end_turn',
      }),
    };
    server = await startServer(overrides);
  });
  afterAll(async () => {
    await server.close();
  });

  it('appends the operator message to the real prompt instead of replacing it', async () => {
    const seed = (await server.api('POST', '/api/tasks', { prompt: 'workspace seed' })).body;
    const workspaceId = (await server.app.ctx.tasks.get(seed.id)).workspaceId ?? undefined;
    const mirrored = await server.app.ctx.tasks.upsertMirrored(
      { trackerRef: 77001, prompt: 'ticket 77001\n\nfix the parser', workflow: 'implement', wayfinderType: null, mapRef: null, closed: false },
      workspaceId,
    );
    await server.api('POST', `/api/tasks/${mirrored.id}/run`);
    await waitFor(async () => {
      const task = (await server.api('GET', `/api/tasks/${mirrored.id}`)).body;
      return task.state === 'escalated' ? task : undefined;
    });
    // Back to ready with the escalated Attempt's Session still warm — the next
    // run's own fresh Attempt opportunistically reuses it (bindContinuationIfEligible).
    await server.app.ctx.tasks.setState(mirrored.id, 'ready');
    const runsBefore = await server.app.ctx.attempts.listForTask(mirrored.id);

    // Seed an operator message ahead of the run the way a steer accepted just
    // before the first turn would, without racing the real timing window.
    const activeRuns = (server.app.ctx.runner as unknown as { activeRuns: ActiveRuns }).activeRuns;
    activeRuns.setPendingOperatorSeed(mirrored.id, 'focus on the tokenizer first');

    await server.api('POST', `/api/tasks/${mirrored.id}/run`);

    const latest = await waitFor(async () => {
      const all = await server.app.ctx.attempts.listForTask(mirrored.id);
      const last = all.at(-1);
      return all.length === runsBefore.length + 1 && last?.prompt ? last : undefined;
    });

    expect(latest.sessionRowId).not.toBeNull();
    // The real turn instructions (the auto-drive prompt the stub script stands in
    // for) survive alongside the operator message — proof it was appended, not
    // swapped in for them.
    expect(latest.prompt).toContain('Running unattended');
    expect(latest.prompt).toContain('## Operator message');
    expect(latest.prompt).toContain('focus on the tokenizer first');
  });
});
