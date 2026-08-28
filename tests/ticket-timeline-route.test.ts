import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunFactStore } from '../src/domain/run-facts.js';
import { MergeJournalStore } from '../src/domain/merge-journal.js';
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
    const run = await server.app.ctx.runs.create(task.body.id);
    const attempt = await server.app.ctx.attempts.ensureForRun(task.body.id, 1, 50);
    const skipped = await server.app.ctx.attempts.createTask(attempt.id, { type: 'verification', command: 'npm test' });
    await server.app.ctx.attempts.updateTask(skipped.id, { state: 'skipped', endedAt: 400 });
    await server.app.ctx.attempts.finish(attempt.id, 'passed', 850);
    await server.app.ctx.runs.update(run.id, { startedAt: 100, finishedAt: 900, state: 'completed', phase: 'terminal' });
    await server.app.ctx.runs.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'phase', phase: 'verifying' } });
    await server.app.ctx.runs.appendEvent(run.id, { type: 'permission_request', payload: { reason: 'outside the timeline' } });
    const facts = new RunFactStore(server.app.ctx.asyncDb);
    await facts.append(run.id, 'escalate', { reason: 'needs an operator' }, 300);
    await facts.append(run.id, 'operator-accept', {}, 700);
    await server.app.ctx.verificationAttempts.append(run.id, {
      mechanism: 'command', inputOid: 'abc123', verdict: 'pass', summary: 'checks passed', output: '', mutated: false,
    }, 200);
    await server.app.ctx.guardrailEvents.append(run.id, {
      dimension: 'wall-clock', phase: 'executing', limitValue: 60_000, observedValue: 60_001, configSource: 'default',
    }, 250);
    await new MergeJournalStore(server.app.ctx.asyncDb).recordResult(run.id, {
      effect: 'target-ref', idempotencyKey: 'merge', ok: true, observed: { oid: 'def456' },
    }, 800);
    const otherTask = await server.api('POST', '/api/tasks', { prompt: 'another timeline' });
    const otherRun = await server.app.ctx.runs.create(otherTask.body.id);
    await new RunFactStore(server.app.ctx.asyncDb).append(otherRun.id, 'escalate', { reason: 'unrelated' }, 150);

    const response = await server.api('GET', `/api/tasks/${task.body.id}/timeline`);

    expect(response.status).toBe(200);
    expect(response.body.events.map((event: { kind: string }) => event.kind)).toEqual([
      'attempt-started', 'run-started', 'verification', 'guardrail', 'escalation', 'verification', 'operator-accept', 'merging', 'attempt-finished', 'verification', 'run-finished', 'lifecycle',
    ]);
    expect(response.body.events.map((event: { ts: number }) => event.ts)).toEqual([50, 100, 200, 250, 300, 400, 700, 800, 850, 900, 900, expect.any(Number)]);
    expect(response.body.events.every((event: { runId: number | null }) => event.runId === null || event.runId === run.id)).toBe(true);
    expect(response.body.events.find((event: { kind: string }) => event.kind === 'verification')).toMatchObject({ data: {
      verdict: 'pass', summary: 'checks passed', mechanism: 'command',
    } });
    expect(response.body.events.find((event: { kind: string }) => event.kind === 'merging')).toMatchObject({ data: {
      effect: 'target-ref', payload: { ok: true },
    } });
    expect(response.body.events.find((event: { data: { outcome?: string } }) => event.data.outcome === 'skipped')).toMatchObject({ data: { outcome: 'skipped' } });
    expect(response.body.events.filter((event: { data: { outcome?: string } }) => event.data.outcome === 'disabled')).toHaveLength(1);
    expect(response.body.events.filter((event: { kind: string }) => event.kind === 'lifecycle')).toMatchObject([
      { data: { type: 'lifecycle', payload: { event: 'phase', phase: 'verifying' } } },
    ]);
  });

  it('derives Reject with guidance from adjacent attempts without misreporting Close as Reject', async () => {
    const task = await server.api('POST', '/api/tasks', { prompt: 'disposition target' });
    const run = await server.app.ctx.runs.create(task.body.id);
    const escalated = await server.app.ctx.attempts.ensureForRun(task.body.id, 1, 100);
    await server.app.ctx.attempts.finish(escalated.id, 'escalated', 150);
    await server.app.ctx.attempts.setFeedback(escalated.id, 'Use the documented timeout.');
    await server.app.ctx.attempts.ensureForRun(task.body.id, 2, 200);
    await new RunFactStore(server.app.ctx.asyncDb).append(run.id, 'operator-cancel', { reason: 'operator closed it' }, 250);

    const response = await server.api('GET', `/api/tasks/${task.body.id}/timeline`);

    expect(response.status).toBe(200);
    expect(response.body.events).toContainEqual(expect.objectContaining({
      kind: 'operator-reject',
      ts: 200,
      data: { attempt: 1, feedback: 'Use the documented timeout.' },
    }));
    expect(response.body.events).toContainEqual(expect.objectContaining({
      kind: 'fact',
      ts: 250,
      data: { type: 'operator-cancel', payload: { reason: 'operator closed it' } },
    }));
    expect(response.body.events.filter((event: { kind: string }) => event.kind === 'operator-reject')).toHaveLength(1);
  });

  it('returns an empty timeline for an existing task with no runs and 404 for an unknown task', async () => {
    const task = await server.api('POST', '/api/tasks', { prompt: 'empty timeline' });

    await expect(server.api('GET', `/api/tasks/${task.body.id}/timeline`)).resolves.toMatchObject({ status: 200, body: { events: [] } });
    await expect(server.api('GET', '/api/tasks/999999/timeline')).resolves.toMatchObject({ status: 404 });
  });
});
