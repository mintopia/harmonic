import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import type { DeepPartial } from '../src/config.js';
import type { AppConfig } from '../src/config.js';

const scenario = (s: object) => JSON.stringify(s);

/** A first turn that streams for a while, so a steer merges while it runs. */
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
      // ActiveRun registers, so a steer can 409 briefly — retry until it merges).
      const steered = await waitFor(async () => {
        const res = await noSteerServer.api('POST', `/api/tasks/${taskId}/steer`, { text: 'reread the tests first' });
        return res.status === 200 ? res : undefined;
      });
      expect(steered.body).toEqual({ ok: true });

      // The steer turn (and everything after) runs, then the task settles.
      await waitFor(async () => {
        const { body } = await noSteerServer.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'done' ? body : undefined;
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
    // The steer must merge while the turn is in flight, and no fixed sleep can
    // guarantee that under parallel-suite CPU contention. Instead the stub (a)
    // writes a marker file at turn start — the test's proof that session/prompt
    // has been received — and (b) holds the turn open via `waitForSteer` until
    // the injection merges, so the turn boundary can never race the steer.
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
      return body.state === 'done' ? body : undefined;
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
      return body.state === 'done' ? body : undefined;
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

// Steering a task whose run has settled but whose Session is still warm: the
// message continues that Session in a fresh Run — a follow-up in the same
// conversation — instead of 409ing. Scoped to escalated tasks (the "ended
// without closure" case).
describe('steering a settled task continues its warm session', () => {
  let server: TestServer;

  beforeAll(async () => {
    // A mirrored (auto-driven) Run that runs one turn and ends WITHOUT finish_task
    // and with no candidate escalates (no verifier vouched for empty work) — while
    // leaving a warm, resumable Session bound to the run. The scenario rides the
    // drive prompt (a mirrored task's own prompt is wrapped where the stub can't
    // parse it).
    const scenarioPrompt = scenario({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking' } }],
      stopReason: 'end_turn',
    });
    server = await startServer({ ...stubHarness(), maxAttempts: 1, drive: { prompt: scenarioPrompt } });
  });
  afterAll(async () => {
    await server.close();
  });

  it('continues the warm session as a fresh run seeded with the operator message', async () => {
    const seed = (await server.api('POST', '/api/tasks', { prompt: 'workspace seed' })).body;
    const workspaceId = (await server.app.ctx.tasks.get(seed.id)).workspaceId ?? undefined;
    const mirrored = await server.app.ctx.tasks.upsertMirrored(
      { trackerRef: 90210, prompt: 'ticket 90210\n\nbody', workflow: 'implement', wayfinderType: null, mapRef: null, closed: false },
      workspaceId,
    );
    await server.api('POST', `/api/tasks/${mirrored.id}/run`);
    await waitFor(async () => {
      const task = (await server.api('GET', `/api/tasks/${mirrored.id}`)).body;
      return task.state === 'escalated' ? task : undefined;
    });
    const runsBefore = (await server.app.ctx.attempts.listForTask(mirrored.id)).length;

    const steered = await server.api('POST', `/api/tasks/${mirrored.id}/steer`, { text: 'actually, focus on the parser' });
    expect(steered.status).toBe(200);
    expect(steered.body).toEqual({ ok: true });

    // A fresh Run spawned, and its persisted first-turn prompt IS the operator
    // message (a continuation of the warm Session, not the task prompt re-sent).
    const latest = await waitFor(async () => {
      const all = await server.app.ctx.attempts.listForTask(mirrored.id);
      const last = all.at(-1);
      return all.length > runsBefore && last?.prompt?.includes('actually, focus on the parser') ? last : undefined;
    });
    expect(latest.prompt).toContain('## Operator message');
    expect(latest.prompt).not.toContain('ticket 90210');
  });

  it('409s when the settled task has no warm session (e.g. a plain done native task)', async () => {
    // Own workspace: the sibling test above leaves a warm, un-retired Session on
    // the default workspace that still holds its `direct:<workdir>` work-context
    // lease. A native task sharing that workspace would 409 on `/run` (lease held)
    // and sit `ready` forever — the flake. A distinct workingDir gives this run
    // its own lease key so it launches and settles independently.
    const workingDir = mkdtempSync(join(tmpdir(), 'harmonic-steer-native-'));
    execFileSync('git', ['init', '-b', 'main', workingDir]);
    execFileSync('git', ['-C', workingDir, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', workingDir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', workingDir, 'commit', '--allow-empty', '-m', 'init']);

    const created = await server.api('POST', '/api/tasks', { prompt: 'quick native task', workingDir });
    const taskId = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done' ? true : undefined));
    const res = await server.api('POST', `/api/tasks/${taskId}/steer`, { text: 'too late' });
    expect(res.status).toBe(409);
  });
});
