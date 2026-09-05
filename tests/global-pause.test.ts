import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GlobalPause } from '../src/execution/global-pause.js';
import { cancelRunningTasks, startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

describe('Global Pause (issue #505)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({ ...stubHarness(), autoRunner: { enabled: false, maxConcurrentAttempts: 1 } });
  });

  afterAll(async () => {
    await cancelRunningTasks(server);
    await server.close();
  });

  it('freezes running work, pauses new manual starts, and resumes independently of the Auto-Runner master switch', async () => {
    const running = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ exit: 'hang' }) });
    const runningAttempt = await server.api('POST', `/api/tasks/${running.body.id}/run`);
    await waitFor(async () => ((await server.app.ctx.tasks.get(running.body.id)).state === 'working' ? true : undefined));

    expect(await server.api('POST', '/api/global-pause')).toMatchObject({ status: 200, body: { paused: true } });
    await waitFor(async () => ((await server.app.ctx.tasks.get(running.body.id)).state === 'paused' ? true : undefined));
    expect((await server.api('GET', '/api/config')).body.autoRunner.enabled).toBe(false);

    const queued = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ exit: 'hang' }) });
    const started = await server.api('POST', `/api/tasks/${queued.body.id}/run`);
    expect(started.status).toBe(201);
    expect((await server.app.ctx.tasks.get(queued.body.id)).state).toBe('paused');

    expect(await server.api('DELETE', '/api/global-pause')).toMatchObject({ status: 200, body: { paused: false } });
    await waitFor(async () => ((await server.app.ctx.tasks.get(queued.body.id)).state === 'working' ? true : undefined));
    const events = await server.api('GET', `/api/attempts/${runningAttempt.body.id}/events`);
    expect(events.body.events.filter((event: { type: string }) => event.type === 'lifecycle').map((event: { payload: unknown }) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'paused', reason: 'global pause' }),
        expect.objectContaining({ event: 'resumed', reason: 'global pause cleared' }),
      ]),
    );
    const attempts = await server.app.ctx.attempts.listForTask(queued.body.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ id: started.body.id, number: 1 });
    expect((await server.api('GET', '/api/config')).body.autoRunner.enabled).toBe(false);
  });

  it('restores the latch without treating a per-Task pause as a fleet pause', async () => {
    const task = await server.app.ctx.tasks.create({ prompt: 'paused at boot' });
    await server.app.ctx.tasks.setState(task.id, 'working');
    await server.app.ctx.tasks.setState(task.id, 'paused');
    const latch = new GlobalPause(server.app.ctx.tasks, server.app.ctx.runner, server.app.ctx.asyncDb);

    await latch.rebuild();

    expect(latch.isLatched).toBe(false);
    await latch.pause();

    const rebuilt = new GlobalPause(server.app.ctx.tasks, server.app.ctx.runner, server.app.ctx.asyncDb);
    await rebuilt.rebuild();

    expect(rebuilt.isLatched).toBe(true);
  });
});
