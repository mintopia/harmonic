import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

const scenario = (s: object) => JSON.stringify(s);

// Steer a running task (ADR-0018): an operator message is queued on the active
// run and delivered as a fresh prompt turn at the next turn boundary — never
// injected mid-turn. Exercised end-to-end against the stub harness, which echoes
// a non-JSON prompt back as `prompt-received:<text>`, so the steer turn is
// visible in the run's session updates.
describe('steering a running task', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('delivers a queued steer as a follow-up turn, then settles', async () => {
    // A first turn that streams for a while, so the steer lands while it runs.
    const first = {
      updates: Array.from({ length: 6 }, (_, i) => ({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `step ${i}` },
      })),
      delayMs: 80,
      stopReason: 'end_turn',
    };
    const created = await server.api('POST', '/api/tasks', { prompt: scenario(first) });
    expect(created.status).toBe(201);
    const taskId = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    const runId = started.body.id;

    // Queue the steer once the run is active (the task flips running before the
    // ActiveRun registers, so a steer can 409 briefly — retry until it lands).
    const steered = await waitFor(async () => {
      const res = await server.api('POST', `/api/tasks/${taskId}/steer`, { text: 'reread the tests first' });
      return res.status === 200 ? res : undefined;
    });
    expect(steered.body).toEqual({ ok: true });

    // The steer turn (and everything after) runs, then the task settles.
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'awaiting-review' ? body : undefined;
    });

    const { body } = await server.api('GET', `/api/runs/${runId}/events`);
    const lifecycle = body.events.filter((e: any) => e.type === 'lifecycle');
    expect(lifecycle.find((e: any) => e.payload.event === 'steer_queued')?.payload.text).toBe('reread the tests first');
    expect(lifecycle.find((e: any) => e.payload.event === 'steer_delivered')?.payload.text).toBe('reread the tests first');

    // The stub echoed the steer text back as its own turn — proof the message
    // was sent as a prompt, not just recorded.
    const chunks = body.events
      .filter((e: any) => e.type === 'session_update' && e.payload.sessionUpdate === 'agent_message_chunk')
      .map((e: any) => e.payload.content?.text);
    expect(chunks).toContain('prompt-received:reread the tests first');
  });

  it('409s when the task has no active run to steer', async () => {
    const draft = await server.api('POST', '/api/tasks', { prompt: 'not running' });
    const res = await server.api('POST', `/api/tasks/${draft.body.id}/steer`, { text: 'hello' });
    expect(res.status).toBe(409);
  });

  it('rejects an empty steer message', async () => {
    const draft = await server.api('POST', '/api/tasks', { prompt: 'x' });
    const res = await server.api('POST', `/api/tasks/${draft.body.id}/steer`, { text: '' });
    expect(res.status).toBe(400);
  });
});
