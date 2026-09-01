import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, stubHarness, cancelRunningTasks, type TestServer } from './helpers.js';

describe('direct-context multi-worker attach (ADR-0046)', () => {
  let server: TestServer;
  const ctx = () => server.app.ctx;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await cancelRunningTasks(server);
    await server.close();
  });

  it('a second worker hand-started onto an already-working direct checkout is not blocked', async () => {
    const first = await server.api('POST', '/api/tasks', { prompt: 'worker one' });
    const firstTask = await ctx().tasks.get(first.body.id);
    await ctx().attempts.create(firstTask.id);
    await ctx().tasks.setState(firstTask.id, 'working');

    const second = await server.api('POST', '/api/tasks', { prompt: 'worker two', workingDir: firstTask.workingDir });
    await ctx().tasks.setState(second.body.id, 'working');

    const run = await ctx().runner.launchClaimed(second.body.id);
    expect(run).toBeDefined();
    expect(run.taskId).toBe(second.body.id);
  });
});
