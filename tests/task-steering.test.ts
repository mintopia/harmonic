import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import type { DeepPartial } from '../src/config.js';
import type { AppConfig } from '../src/config.js';

const scenario = (s: object) => JSON.stringify(s);

/** A first turn that streams for a while, so a steer lands while it runs. */
const slowFirstTurn = (n = 6, delayMs = 80) =>
  scenario({
    updates: Array.from({ length: n }, (_, i) => ({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `step ${i}` },
    })),
    delayMs,
    stopReason: 'end_turn',
  });

// Steer a running task (ADR-0018): when the harness supports ACP mid-turn
// steering (`_session/steering`, claude-agent-acp ≥0.69), an operator message
// is injected into the running turn immediately — pre-empting the current
// generation without cancelling it. Otherwise (or when the agent is parked
// between turns) it is queued and delivered as a fresh prompt turn at the
// next turn boundary. Exercised end-to-end against the stub harness, which
// echoes a non-JSON prompt back as `prompt-received:<text>` and, for
// `_session/steering`, streams `steer-injected:<text>`.
describe('steering a running task', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('delivers a queued steer as a follow-up turn, then settles (harness without mid-turn steering)', async () => {
    // Simulate a harness that lacks ACP `_session/steering` (codex/copilot),
    // so this exercises the boundary-queue fallback specifically.
    const overrides = stubHarness() as DeepPartial<AppConfig> & { harnesses: { claude: Record<string, unknown> } };
    overrides.harnesses.claude.env = { STUB_NO_STEERING: '1' };
    const noSteerServer = await startServer(overrides);
    try {
      const created = await noSteerServer.api('POST', '/api/tasks', { prompt: slowFirstTurn() });
      expect(created.status).toBe(201);
      const taskId = created.body.id;
      const started = await noSteerServer.api('POST', `/api/tasks/${taskId}/run`);
      expect(started.status).toBe(201);
      const runId = started.body.id;

      // Queue the steer once the run is active (the task flips running before the
      // ActiveRun registers, so a steer can 409 briefly — retry until it lands).
      const steered = await waitFor(async () => {
        const res = await noSteerServer.api('POST', `/api/tasks/${taskId}/steer`, { text: 'reread the tests first' });
        return res.status === 200 ? res : undefined;
      });
      expect(steered.body).toEqual({ ok: true });

      // The steer turn (and everything after) runs, then the task settles.
      await waitFor(async () => {
        const { body } = await noSteerServer.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'awaiting-review' ? body : undefined;
      });

      const { body } = await noSteerServer.api('GET', `/api/runs/${runId}/events`);
      const lifecycle = body.events.filter((e: any) => e.type === 'lifecycle');
      expect(lifecycle.find((e: any) => e.payload.event === 'steer_queued')?.payload.text).toBe('reread the tests first');
      expect(lifecycle.find((e: any) => e.payload.event === 'steer_delivered')?.payload.text).toBe('reread the tests first');
      expect(lifecycle.find((e: any) => e.payload.event === 'steer_injected')).toBeUndefined();

    } finally {
      await noSteerServer.close();
    }
  });

  it('injects a steer into the running turn when the harness supports it', async () => {
    // The steer must land while the turn is in flight, and no fixed sleep can
    // guarantee that under parallel-suite CPU contention. Instead the stub (a)
    // writes a marker file at turn start — the test's proof that session/prompt
    // has been received — and (b) holds the turn open via `waitForSteer` until
    // the injection lands, so the turn boundary can never race the steer.
    const turnStartedFile = join(mkdtempSync(join(tmpdir(), 'harmonic-steer-')), 'turn-started');
    const created = await server.api('POST', '/api/tasks', {
      prompt: scenario({
        updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } }],
        writeFiles: { [turnStartedFile]: 'started\n' },
        waitForSteer: true,
        stopReason: 'end_turn',
      }),
    });
    expect(created.status).toBe(201);
    const taskId = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    const runId = started.body.id;

    // ACP output is intentionally no longer persisted, so the marker file (not
    // a lifecycle event) is the "turn is running" probe.
    await waitFor(async () => existsSync(turnStartedFile));

    const steered = await waitFor(async () => {
      const res = await server.api('POST', `/api/tasks/${taskId}/steer`, { text: 'switch to the other approach' });
      return res.status === 200 ? res : undefined;
    });
    expect(steered.body).toEqual({ ok: true });

    // The turn (and everything after) runs, then the task settles.
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'awaiting-review' ? body : undefined;
    });

    const { body } = await server.api('GET', `/api/runs/${runId}/events`);
    const lifecycle = body.events.filter((e: any) => e.type === 'lifecycle');
    expect(lifecycle.find((e: any) => e.payload.event === 'steer_injected')?.payload.text).toBe(
      'switch to the other approach',
    );
    expect(lifecycle.find((e: any) => e.payload.event === 'steer_delivered')).toBeUndefined();

  });

  it('409s a steer after the run has fully settled, never a 200 that vanishes', async () => {
    // Regression for the "steer after the turn has ended" race: once a Run
    // commits to settling it closes its steerable gate synchronously, so a
    // steer arriving anywhere in (or after) the settle sequence is rejected
    // honestly rather than accepted into a queue nobody will ever drain.
    const created = await server.api('POST', '/api/tasks', { prompt: 'quick task' });
    const taskId = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);

    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'awaiting-review' ? body : undefined;
    });

    const res = await server.api('POST', `/api/tasks/${taskId}/steer`, { text: 'too late' });
    expect(res.status).toBe(409);
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
