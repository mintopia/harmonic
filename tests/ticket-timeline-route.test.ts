import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';

describe('GET /api/tasks/:id/timeline (issue #328)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });

  afterEach(async () => {
    await server.close();
  });

  it('folds all persisted ticket events into chronological order', async () => {
    const task = await server.api('POST', '/api/tasks', { prompt: 'timeline target' });
    const attempt = await server.app.ctx.attempts.create(task.body.id);
    const skipped = await server.app.ctx.attempts.createStep(attempt.id, { type: 'verification', command: 'npm test' });
    await server.app.ctx.attempts.updateStep(skipped.id, { state: 'skipped', endedAt: 400 });
    await server.app.ctx.attempts.finish(attempt.id, 'passed', 850);
    await server.app.ctx.attempts.update(attempt.id, { startedAt: 100, endedAt: 900 });
    await server.app.ctx.attempts.appendEvent(attempt.id, { type: 'lifecycle', payload: { event: 'progress-nudge', pattern: 'monologue' } });
    await server.app.ctx.attempts.appendEvent(attempt.id, { type: 'permission_request', payload: { reason: 'outside the timeline' } });
    await server.app.ctx.verificationAttempts.append(attempt.id, {
      mechanism: 'command', inputOid: 'abc123', verdict: 'pass', summary: 'checks passed', output: '',
    }, 200);
    await server.app.ctx.guardrailEvents.append(attempt.id, {
      dimension: 'wall-clock', limitValue: 60_000, observedValue: 60_001, configSource: 'default',
    }, 250);
    // Cross-task isolation: an unrelated task's Attempt gets its own lifecycle
    // event, which must never leak into this task's timeline.
    const otherTask = await server.api('POST', '/api/tasks', { prompt: 'another timeline' });
    const otherAttempt = await server.app.ctx.attempts.create(otherTask.body.id);
    await server.app.ctx.attempts.appendEvent(otherAttempt.id, { type: 'lifecycle', payload: { event: 'unrelated' } });

    const response = await server.api('GET', `/api/tasks/${task.body.id}/timeline`);

    expect(response.status).toBe(200);
    // Run/Attempt are one execution ledger now (ADR-0001 #388 S-G): no more
    // duplicate 'run-started'/'run-finished' entries alongside 'attempt-started'/
    // 'attempt-finished' for the same fact.
    // A `task-created` fact heads the lifecycle (its ts is the Task's real
    // createdAt, so it sorts among the wall-clock events, before the lifecycle
    // event appended after it).
    expect(response.body.events.map((event: { kind: string }) => event.kind)).toEqual([
      'attempt-started', 'verification', 'guardrail', 'verification', 'verification', 'attempt-finished', 'fact', 'lifecycle',
    ]);
    expect(response.body.events.map((event: { ts: number }) => event.ts)).toEqual([100, 200, 250, 400, 900, 900, expect.any(Number), expect.any(Number)]);
    expect(response.body.events.find((event: { kind: string }) => event.kind === 'fact')).toMatchObject({ data: { type: 'task-created' } });
    expect(response.body.events.every((event: { attemptId: number | null }) => event.attemptId === null || event.attemptId === attempt.id)).toBe(true);
    expect(response.body.events.find((event: { kind: string }) => event.kind === 'verification')).toMatchObject({ data: {
      verdict: 'pass', summary: 'checks passed', mechanism: 'command',
    } });
    expect(response.body.events.find((event: { data: { outcome?: string } }) => event.data.outcome === 'skipped')).toMatchObject({ data: { outcome: 'skipped' } });
    expect(response.body.events.filter((event: { data: { outcome?: string } }) => event.data.outcome === 'disabled')).toHaveLength(1);
    expect(response.body.events.filter((event: { kind: string }) => event.kind === 'lifecycle')).toMatchObject([
      { data: { type: 'lifecycle', payload: { event: 'progress-nudge', pattern: 'monologue' } } },
    ]);
    const finished = response.body.events.find((event: { kind: string }) => event.kind === 'attempt-finished');
    expect(finished).toMatchObject({ data: { attempt: 1, state: 'passed', feedback: null, reason: null } });
  });

  it('derives Reject with guidance from adjacent attempts without misreporting Close as Reject', async () => {
    const task = await server.api('POST', '/api/tasks', { prompt: 'disposition target' });
    const escalated = await server.app.ctx.attempts.ensureForRun(task.body.id, 1, 100);
    await server.app.ctx.attempts.finish(escalated.id, 'escalated', 150, undefined, 'escalate');
    await server.app.ctx.attempts.setFeedback(escalated.id, 'Use the documented timeout.');
    await server.app.ctx.attempts.ensureForRun(task.body.id, 2, 200);

    const response = await server.api('GET', `/api/tasks/${task.body.id}/timeline`);

    expect(response.status).toBe(200);
    expect(response.body.events).toContainEqual(expect.objectContaining({
      kind: 'operator-reject',
      ts: 200,
      data: { attempt: 1, feedback: 'Use the documented timeout.' },
    }));
    // The Attempt's disposition-kind reason (ADR-0001 #388 S-E) rides on its
    // own attempt-finished event, not a separate fact-derived one.
    expect(response.body.events).toContainEqual(expect.objectContaining({
      kind: 'attempt-finished',
      ts: 150,
      data: { attempt: 1, state: 'escalated', feedback: 'Use the documented timeout.', reason: 'escalate' },
    }));
    expect(response.body.events.filter((event: { kind: string }) => event.kind === 'operator-reject')).toHaveLength(1);
  });

  it('shows only the task-created row for a task with no runs, and 404 for an unknown task', async () => {
    const task = await server.api('POST', '/api/tasks', { prompt: 'empty timeline' });

    // A run-less Task still has its own creation event — the head of the lifecycle.
    await expect(server.api('GET', `/api/tasks/${task.body.id}/timeline`)).resolves.toMatchObject({
      status: 200,
      body: { events: [{ kind: 'fact', data: { type: 'task-created' } }] },
    });
    await expect(server.api('GET', '/api/tasks/999999/timeline')).resolves.toMatchObject({ status: 404 });
  });
});
