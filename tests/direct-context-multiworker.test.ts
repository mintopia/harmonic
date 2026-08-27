import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startServer, stubHarness, cancelRunningTasks, type TestServer } from './helpers.js';
import { workContextKey } from '../src/domain/work-context-key.js';
import { logger } from '../src/logger.js';

/**
 * Direct-context multi-worker tracing (issue #369, ADR-0046): direct isolation's
 * single checkout serialises to one worker per context, but a second worker
 * attaching to an already-claimed direct Work Context is the operator's accepted
 * risk — it is NOT blocked, and it emits a debug-level log line so the attach is
 * reconstructable from logs after the fact without ever being surfaced.
 */
describe('direct-context multi-worker attach (issue #369)', () => {
  let server: TestServer;
  const ctx = () => server.app.ctx;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await cancelRunningTasks(server);
    await server.close();
  });

  it('a second worker attaching to an already-claimed direct checkout is not blocked and is traced at debug', async () => {
    // Worker 1 holds the direct Work Context: a fresh Run owns the lease keyed on
    // the shared workingDir, and its Task is `working` (as Runner.beginRun leaves it).
    const first = await server.api('POST', '/api/tasks', { prompt: 'worker one' });
    const firstTask = await ctx().tasks.get(first.body.id);
    const firstRun = await ctx().runs.create(firstTask.id);
    const key = workContextKey({ isolationMode: 'direct', workingDir: firstTask.workingDir });
    await ctx().leases.acquire(key, firstRun.id, 'executing');
    await ctx().tasks.setState(firstTask.id, 'working');

    // Worker 2: a second direct Task on the SAME checkout, hand-started.
    const second = await server.api('POST', '/api/tasks', { prompt: 'worker two', workingDir: firstTask.workingDir });
    await ctx().tasks.setState(second.body.id, 'working');

    const debugSpy = vi.spyOn(logger, 'debug');

    // No block: launchClaimed resolves with a Run rather than throwing a conflict.
    const run = await ctx().runner.launchClaimed(second.body.id);
    expect(run).toBeDefined();
    expect(run.taskId).toBe(second.body.id);

    // Traced at debug, naming the held context and its owner.
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining(`second worker attaching to already-claimed direct Work Context "${key}"`),
    );

    // The existing lease is untouched — worker 1 still owns the context; the
    // attaching Run neither stole nor released it.
    const held = await ctx().leases.getByKey(key);
    expect(held?.ownerRunId).toBe(firstRun.id);

    debugSpy.mockRestore();
  });
});
