import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, DeepPartial } from '../src/config.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { safeSegment } from '../src/archive/task-archive.js';
import { connectFirehose, startServer, waitFor, type TestServer } from './helpers.js';

describe('step runs on the Attempt surfaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-step-runs-'));
  let server: TestServer;
  let taskId: number;
  let attemptId: number;
  let store: WorkflowStepRunStore;
  let ids: { check: number; critic: number; agent: number; merge: number; orphan: number };
  const cookie = () => ({ cookie: `harmonic_session=${server.sessionToken}` });
  const base = { workflowRef: 'implement@1' };

  beforeAll(async () => {
    server = await startServer({ defaults: { isolationMode: 'direct' } } as DeepPartial<AppConfig>, { dataDir: join(root, 'data') });
    const task = await server.app.ctx.tasks.create({ prompt: 'step runs', workingDir: root, isolationMode: 'direct' } as never);
    taskId = task.id;
    attemptId = (await server.app.ctx.attempts.create(taskId)).id;
    store = new WorkflowStepRunStore(server.app.ctx.asyncDb);
    const start = (stepId: string, action: string, position: number, attempt: number | null) => store.start({ taskId, ...base, stepId, position, action, attempt, attemptId });
    const agent = await start('build', 'agent', 0, 1);
    await store.setResolvedPrompt(agent.id, 'do the thing');
    await store.finish(agent.id, { outcome: 'pass', outputs: { stdout: 'ok', exitCode: null }, summary: 'agent done' });
    const check = await start('test', 'run', 1, 1);
    await store.finish(check.id, { outcome: 'fail', outputs: { stdout: 'boom', exitCode: 1 }, summary: 'exit 1' });
    const critic = await start('critic', 'critic', 2, 1);
    await store.setSession(critic.id, { harness: 'claude', model: 'claude-opus-5-5' });
    await store.setUsage(critic.id, { models: { 'claude-opus-5-5': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }, totals: null, toolCalls: {}, source: 'session-log' });
    await store.finish(critic.id, { outcome: 'pass', outputs: { stdout: '', exitCode: null, verdict: 'pass', findings: [] }, summary: 'ok' });
    const orphan = await start('lint', 'run', 3, 2);
    await store.closeOrphans();
    const merge = await start('merge', 'merge', 4, null);
    ids = { check: check.id, critic: critic.id, agent: agent.id, merge: merge.id, orphan: orphan.id };
  });

  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves stepRuns on the timeline with derived state, kind, pass, prompt flag and critic cost', async () => {
    const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`);
    const [attempt] = body.attempts;
    expect(attempt).not.toHaveProperty('steps');
    expect(attempt).not.toHaveProperty('verifierStatuses');
    expect(attempt).not.toHaveProperty('verifiedSha');
    const byId = Object.fromEntries(attempt.stepRuns.map((r: { id: number }) => [r.id, r]));
    expect(attempt.stepRuns.map((r: { id: number }) => r.id)).toEqual([ids.agent, ids.check, ids.critic, ids.orphan, ids.merge]);
    expect(byId[ids.agent]).toMatchObject({ kind: 'agent', pass: 1, state: 'pass', hasPrompt: true, attemptId });
    expect(byId[ids.check]).toMatchObject({ kind: 'check', state: 'fail', outcome: 'fail', outputs: { stdout: 'boom', exitCode: 1 } });
    expect(byId[ids.critic]).toMatchObject({ kind: 'critic', harness: 'claude', outputs: { verdict: 'pass' } });
    expect(byId[ids.critic].cost.byModel['claude-opus-5-5']).toBeGreaterThan(0);
    expect(byId[ids.orphan]).toMatchObject({ state: 'interrupted', outcome: null, summary: 'interrupted by process death' });
    expect(byId[ids.merge]).toMatchObject({ kind: 'publish', state: 'running', pass: null, endedAt: null });
  });

  it('derives currentStep and mergeStatus from the running step run, and counts critic cost on the Task', async () => {
    await server.app.ctx.tasks.setState(taskId, 'working');
    await server.app.ctx.asyncDb.write((db) => db.run(`UPDATE attempts SET state = 'running' WHERE id = ${attemptId}` as never));
    const task = await server.api('GET', `/api/tasks/${taskId}`);
    expect(task.body.currentStep).toEqual({ stepId: 'merge', action: 'merge', kind: 'publish' });
    expect(task.body.mergeStatus).toBe('merging');
    expect(task.body.cost.byModel.critic).toBeGreaterThan(0);
    const list = await server.api('GET', '/api/tasks');
    expect(list.body.tasks.find((t: { id: number }) => t.id === taskId).currentStep).toMatchObject({ stepId: 'merge' });
  });

  it('adds the critic cost to the Attempt cost', async () => {
    const { body } = await server.api('GET', `/api/attempts/${attemptId}`);
    expect(body.cost.byModel.critic).toBeGreaterThan(0);
  });

  it('puts step-run start and finish events on the Ticket timeline and no derived verification-disabled', async () => {
    const { body } = await server.api('GET', `/api/tasks/${taskId}/timeline`);
    const stepEvents = body.events.filter((e: { kind: string }) => e.kind === 'step-run');
    expect(stepEvents.filter((e: { data: { stepRunId: number } }) => e.data.stepRunId === ids.check).map((e: { data: { phase: string; outcome?: string } }) => [e.data.phase, e.data.outcome])).toEqual([['started', undefined], ['finished', 'fail']]);
    expect(stepEvents.some((e: { data: { stepRunId: number; phase: string } }) => e.data.stepRunId === ids.merge && e.data.phase === 'finished')).toBe(false);
    expect(body.events.some((e: { kind: string; data: { derived?: boolean } }) => e.kind === 'verification' && e.data.derived)).toBe(false);
  });

  it('serves the resolved prompt and 404s when there is none', async () => {
    const ok = await fetch(`${server.baseUrl}/api/step-runs/${ids.agent}/prompt`, { headers: cookie() });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('do the thing');
    expect((await fetch(`${server.baseUrl}/api/step-runs/${ids.check}/prompt`, { headers: cookie() })).status).toBe(404);
  });

  it('streams the archived full output of a step run', async () => {
    const task = await server.app.ctx.tasks.get(taskId);
    const attempt = await server.app.ctx.attempts.get(attemptId);
    const log = (await server.app.ctx.archive.stepRunOutputLog(task, attempt.number, { pass: 1, stepId: 'test', stepRunId: ids.check }))!;
    expect(log.key).toBe(`steps/1-${safeSegment('test')}-${ids.check}/output.log`);
    expect((await fetch(`${server.baseUrl}/api/step-runs/${ids.check}/output`, { headers: cookie() })).status).toBe(404);
    writeFileSync(log.path, 'FULL OUTPUT');
    const res = await fetch(`${server.baseUrl}/api/step-runs/${ids.check}/output`, { headers: cookie() });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('FULL OUTPUT');
  });

  it('reports an unavailable log for a step run with no Session, and 404s for an unknown step run', async () => {
    const log = await server.api('GET', `/api/step-runs/${ids.check}/log`);
    expect(log.body).toMatchObject({ status: 'unavailable' });
    expect((await server.api('GET', '/api/step-runs/999999/log')).status).toBe(404);
  });

  it('streams step_run_changed with the Task latest Attempt, and no longer serves critic_log', async () => {
    const ws = await connectFirehose(server);
    (server.app.ctx.runner as any).events.onStepChanged(taskId);
    expect(await waitFor(async () => ws.messages.find((m) => m.type === 'step_run_changed'))).toEqual({ type: 'step_run_changed', taskId, attemptId });
    ws.send({ type: 'critic_log_subscribe', attemptId, after: 0, replay: true });
    server.app.ctx.bus.emitAttemptLog({ id: 1, attemptId, seq: 1, ts: 0, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk' } });
    ws.send({ type: 'attempt_log_subscribe', attemptId, after: 0, replay: true });
    await waitFor(async () => ws.messages.some((m) => m.type === 'attempt_log_event'));
    expect(ws.messages.some((m) => m.type === 'critic_log_event')).toBe(false);
    ws.close();
  });

  it('is operator-only: a read-scoped key cannot reach step-run routes', async () => {
    const { token } = await server.app.ctx.auth.createKey('viz', { scope: 'read' });
    const res = await fetch(`${server.baseUrl}/api/step-runs/${ids.agent}/prompt`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });
});
