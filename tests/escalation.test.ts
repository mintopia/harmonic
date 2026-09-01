import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { AttemptStore } from '../src/domain/attempts.js';

describe('escalation: the three actions (direct mode)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({ ...stubHarness(), maxAttempts: 1 });
  });
  afterAll(async () => {
    await server.close();
  });

  const timeline = async (taskId: number) =>
    (await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`)).body.attempts as Array<{
      number: number;
      state: string;
      feedback: string | null;
    }>;

  async function runToDone(prompt = 'do the thing'): Promise<number> {
    const created = await server.api('POST', '/api/tasks', { prompt });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
    return created.body.id;
  }

  async function runToEscalated(scenario: Record<string, unknown> = {}): Promise<number> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ exit: 'crash-before-response', ...scenario }),
    });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated');
    return created.body.id;
  }

  it('a passing native run merges to done with no human gate; done is terminal', async () => {
    const taskId = await runToDone();
    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).toBe('done');
    expect(task.escalationReason).toBeNull();

    expect((await server.api('POST', `/api/tasks/${taskId}/cancel`)).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${taskId}/accept`)).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${taskId}/reject`, { guidance: 'x' })).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${taskId}/close`)).status).toBe(409);

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts[0];
    expect(run).toMatchObject({ state: 'completed' });
    const attempt = await new AttemptStore(server.app.ctx.asyncDb).getForTaskNumber(taskId, run.number);
    expect(attempt).toMatchObject({ state: 'passed', reason: 'agent-finish/unresolved' });
  });

  it('an exhausted attempt budget escalates with the reason recorded on the ticket and the attempt', async () => {
    const taskId = await runToEscalated();
    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).toBe('escalated');
    expect(task.escalationReason).toMatch(/^escalated to human: attempt 1 of 1 failed/);

    const attempts = await timeline(taskId);
    expect(attempts.map((attempt) => attempt.state)).toEqual(['escalated']);
    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts[0];
    expect(run.state).toBe('failed');
    expect(run.reason).toContain('escalated to human');
  });

  it('Accept refuses (409) when the escalated ticket has no verified branch head to merge', async () => {
    const taskId = await runToEscalated();
    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(409);
    expect(accepted.body.error.code).toBe('conflict');
    expect((await server.api('GET', `/api/tasks/${taskId}`)).body.state).toBe('escalated');
  });

  it('Reject with start now resumes the loop: the guidance is feedback and the budget resets', async () => {
    const taskId = await runToEscalated();
    const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, {
      guidance: 'Do not crash; write the CSV header first.',
      start: true,
    });
    expect(rejected.status).toBe(200);
    expect(['working', 'escalated']).toContain(rejected.body.state);

    const again = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'escalated' && (await timeline(taskId)).length === 2 ? body : undefined;
    });
    expect(again.escalationReason).toMatch(/attempt 1 of 1 failed/);
    const attemptsAfter = await timeline(taskId);
    expect(attemptsAfter.map((attempt) => ({ number: attempt.number, state: attempt.state }))).toEqual([
      { number: 1, state: 'escalated' },
      { number: 2, state: 'escalated' },
    ]);
    expect(attemptsAfter[0]!.feedback).toBe('Do not crash; write the CSV header first.');
    const runs = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts;
    expect(runs).toHaveLength(2);
    expect(runs[1].number).toBe(2);
    expect(runs[1].prompt).toContain('Do not crash; write the CSV header first.');
    expect(runs[1].prompt).toContain('crash-before-response');
  });

  it('Reject without start requeues to ready and records the guidance, but does not force-start (ADR-0048)', async () => {
    const taskId = await runToEscalated();
    const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, {
      guidance: 'Do not crash; write the CSV header first.',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.state).toBe('ready');
    await new Promise((r) => setTimeout(r, 50));
    expect((await server.api('GET', `/api/tasks/${taskId}`)).body.state).toBe('ready');
    const runs = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts;
    expect(runs).toHaveLength(1);
    expect((await timeline(taskId)).find((a) => a.number === 1)!.feedback).toBe(
      'Do not crash; write the CSV header first.',
    );
  });

  it('Reject without guidance is a validation error and changes nothing', async () => {
    const taskId = await runToEscalated();
    const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, { guidance: '   ' });
    expect(rejected.status).toBe(400);
    expect((await server.api('GET', `/api/tasks/${taskId}`)).body.state).toBe('escalated');
  });

  it('Close cancels the ticket and clears the escalation reason', async () => {
    const taskId = await runToEscalated();
    const closed = await server.api('POST', `/api/tasks/${taskId}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ state: 'cancelled', escalationReason: null });
    expect((await server.api('POST', `/api/tasks/${taskId}/close`)).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${taskId}/uncancel`)).body.state).toBe('ready');
  });

  it('the three actions apply to escalated tickets only', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'p' });
    expect((await server.api('POST', `/api/tasks/${created.body.id}/accept`)).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${created.body.id}/reject`, { guidance: 'x' })).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${created.body.id}/close`)).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${created.body.id}/requeue`, {})).status).toBe(404);
    expect((await server.api('POST', `/api/tasks/${created.body.id}/unescalate`)).status).toBe(404);
    expect((await server.api('POST', `/api/tasks/${created.body.id}/adopt-review`)).status).toBe(404);
    expect((await server.api('POST', `/api/tasks/${created.body.id}/note-to-critic`, { note: 'x' })).status).toBe(404);
  });

  it("the agent's escalate_task escalates to a human immediately, superseding the retry budget", async () => {
    const escServer = await startServer({ ...stubHarness(), maxAttempts: 3 });
    try {
      await escServer.app.ctx.settingsStore.updateGlobal({
        drive: { prompt: JSON.stringify({ mcpEscalate: { reason: 'need a decision on the schema' } }) },
      });
      const workspaceId = (await escServer.app.ctx.workspaces.list())[0]!.id;
      const mirrored = await escServer.app.ctx.tasks.upsertMirrored(
        { trackerRef: 31_401, prompt: 'ticket 31401', workflow: 'implement', wayfinderType: null, mapRef: null, closed: false },
        workspaceId,
      );
      expect((await escServer.api('POST', `/api/tasks/${mirrored.id}/run`)).status).toBe(201);
      await waitFor(async () => (await escServer.api('GET', `/api/tasks/${mirrored.id}`)).body.state === 'escalated');
      const task = (await escServer.api('GET', `/api/tasks/${mirrored.id}`)).body;
      expect(task.escalationReason).toMatch(/the agent asked for a human: need a decision on the schema/);
      const attempts = await new AttemptStore(escServer.app.ctx.asyncDb).listForTask(mirrored.id);
      expect(attempts.map((attempt) => attempt.state)).toEqual(['escalated']);
    } finally {
      await escServer.close();
    }
  });
});
