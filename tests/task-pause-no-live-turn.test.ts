import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelRunningTasks, startServer, stubHarness, type TestServer } from './helpers.js';
import type { ActiveRuns } from '../src/execution/active-runs.js';
import type { RunBoundaryResult } from '../src/execution/run-control.js';

/** Reaches into the Runner's private drive-loop bookkeeping the way the loop
 * itself does, to arrange and observe "no live turn" states no scripted
 * harness scenario can time deterministically. */
function runnerInternals(server: TestServer) {
  return server.app.ctx.runner as unknown as {
    activeRuns: ActiveRuns;
    checkRunBoundary: (taskId: number) => Promise<RunBoundaryResult>;
  };
}

describe('Pause/cancel/complete outside a live turn (operator-control gaps)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({ ...stubHarness(), autoRunner: { enabled: false, maxConcurrentAttempts: 1 } });
  });
  afterAll(async () => {
    await cancelRunningTasks(server);
    await server.close();
  });

  async function workingTaskWithRunningAttempt() {
    const created = await server.api('POST', '/api/tasks', { prompt: 'x' });
    const taskId = created.body.id;
    await server.app.ctx.tasks.setState(taskId, 'ready');
    await server.app.ctx.tasks.setState(taskId, 'working');
    const attempt = await server.app.ctx.attempts.create(taskId);
    return { taskId, attemptId: attempt.id };
  }

  describe('Pause', () => {
    it('stranded (no ActiveRun, no drive loop): pauses immediately, and Resume works afterwards', async () => {
      const { taskId, attemptId } = await workingTaskWithRunningAttempt();

      const res = await server.api('POST', `/api/tasks/${taskId}/pause`);
      expect(res.status).toBe(200);
      expect((await server.app.ctx.tasks.get(taskId)).state).toBe('paused');
      const events = await server.app.ctx.attempts.listEvents(attemptId);
      expect(events.some((e) => (e.payload as { event?: string }).event === 'paused')).toBe(true);

      const resumed = await server.api('POST', `/api/tasks/${taskId}/resume`);
      expect(resumed.status).toBe(200);
      expect((await server.app.ctx.tasks.get(taskId)).state).toBe('working');
    });

    it('driving between turns: freezes at the next boundary instead of writing paused immediately', async () => {
      const { taskId } = await workingTaskWithRunningAttempt();
      const internals = runnerInternals(server);
      internals.activeRuns.markDriving(taskId);
      try {
        const res = await server.api('POST', `/api/tasks/${taskId}/pause`);
        expect(res.status).toBe(200);
        // Not honoured yet — no boundary has run since the request.
        expect((await server.app.ctx.tasks.get(taskId)).state).toBe('working');

        // A second concurrent pause request must not be accepted twice.
        const second = await server.api('POST', `/api/tasks/${taskId}/pause`);
        expect(second.status).toBe(409);

        const boundary = await internals.checkRunBoundary(taskId);
        expect(boundary).toMatchObject({ stop: true, reason: 'operator-pause', pauseReason: 'operator request' });
        expect((await server.app.ctx.tasks.get(taskId)).state).toBe('paused');
      } finally {
        internals.activeRuns.clearDriving(taskId);
      }
    });
  });

  describe('Cancel / Complete between turns', () => {
    it('cancel on a stranded task settles the Attempt and the Task consistently', async () => {
      const { taskId, attemptId } = await workingTaskWithRunningAttempt();

      const res = await server.api('POST', `/api/tasks/${taskId}/cancel`);
      expect(res.status).toBe(200);
      expect((await server.app.ctx.tasks.get(taskId)).state).toBe('cancelled');
      expect((await server.app.ctx.attempts.get(attemptId)).state).toBe('cancelled');
    });

    it('complete on a stranded task settles the Attempt and the Task consistently', async () => {
      const { taskId, attemptId } = await workingTaskWithRunningAttempt();

      const res = await server.api('POST', `/api/tasks/${taskId}/complete`);
      expect(res.status).toBe(200);
      expect((await server.app.ctx.tasks.get(taskId)).state).toBe('done');
      expect((await server.app.ctx.attempts.get(attemptId)).state).toBe('passed');
    });

    it('cancel while driving between turns stops the loop from spawning another turn (boundary check reports settled)', async () => {
      const { taskId, attemptId } = await workingTaskWithRunningAttempt();
      const internals = runnerInternals(server);
      internals.activeRuns.markDriving(taskId);
      try {
        const res = await server.api('POST', `/api/tasks/${taskId}/cancel`);
        expect(res.status).toBe(200);
        expect((await server.app.ctx.tasks.get(taskId)).state).toBe('cancelled');
        expect((await server.app.ctx.attempts.get(attemptId)).state).toBe('cancelled');

        // The exact check driveOnce runs before spawning its next turn/self-heal
        // attempt: it must see the Task as settled and refuse to spawn anything.
        const boundary = await internals.checkRunBoundary(taskId);
        expect(boundary).toEqual({ stop: true, reason: 'settled' });
      } finally {
        internals.activeRuns.clearDriving(taskId);
      }
    });
  });
});
