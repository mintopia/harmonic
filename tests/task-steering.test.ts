import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import type { DeepPartial } from '../src/config.js';
import type { AppConfig } from '../src/config.js';

const scenario = (s: object) => JSON.stringify(s);

const slowFirstTurn = (n = 6, delayMs = 80) =>
  scenario({
    updates: Array.from({ length: n }, (_, i) => ({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `step ${i}` },
    })),
    delayMs,
    stopReason: 'end_turn',
  });

describe('steering a running task', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('delivers a queued steer as a follow-up turn, then settles (harness without mid-turn steering)', async () => {
    const overrides = stubHarness() as DeepPartial<AppConfig> & { harnesses: { claude: Record<string, unknown> } };
    overrides.harnesses.claude.env = { STUB_NO_STEERING: '1' };
    const noSteerServer = await startServer(overrides);
    try {
      const created = await noSteerServer.api('POST', '/api/tasks', { prompt: slowFirstTurn() });
      expect(created.status).toBe(201);
      const taskId = created.body.id;
      const started = await noSteerServer.api('POST', `/api/tasks/${taskId}/run`);
      expect(started.status).toBe(201);
      const attemptId = started.body.id;

      const steered = await waitFor(async () => {
        const res = await noSteerServer.api('POST', `/api/tasks/${taskId}/steer`, { text: 'reread the tests first' });
        return res.status === 200 ? res : undefined;
      });
      expect(steered.body).toEqual({ ok: true });

      await waitFor(async () => {
        const { body } = await noSteerServer.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'done' ? body : undefined;
      });

      const { body } = await noSteerServer.api('GET', `/api/attempts/${attemptId}/events`);
      const lifecycle = body.events.filter((e: any) => e.type === 'lifecycle');
      expect(lifecycle.find((e: any) => e.payload.event === 'steer_queued')?.payload.text).toBe('reread the tests first');
      expect(lifecycle.find((e: any) => e.payload.event === 'steer_delivered')?.payload.text).toBe('reread the tests first');
      expect(lifecycle.find((e: any) => e.payload.event === 'steer_injected')).toBeUndefined();

    } finally {
      await noSteerServer.close();
    }
  });

  it('injects a steer into the running turn when the harness supports it', async () => {
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
    const attemptId = started.body.id;

    await waitFor(async () => existsSync(turnStartedFile));

    const steered = await waitFor(async () => {
      const res = await server.api('POST', `/api/tasks/${taskId}/steer`, { text: 'switch to the other approach' });
      return res.status === 200 ? res : undefined;
    });
    expect(steered.body).toEqual({ ok: true });

    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });

    const { body } = await server.api('GET', `/api/attempts/${attemptId}/events`);
    const lifecycle = body.events.filter((e: any) => e.type === 'lifecycle');
    expect(lifecycle.find((e: any) => e.payload.event === 'steer_injected')?.payload.text).toBe(
      'switch to the other approach',
    );
    expect(lifecycle.find((e: any) => e.payload.event === 'steer_delivered')).toBeUndefined();

  });

  it('409s a steer after the run has fully settled, never a 200 that vanishes', async () => {
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

describe('steering a settled task continues its session', () => {
  let server: TestServer;

  beforeAll(async () => {
    const scenarioPrompt = scenario({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking' } }],
      stopReason: 'end_turn',
    });
    const overrides = stubHarness() as DeepPartial<AppConfig>;
    overrides.harnesses!.claude!.cacheWarmSeconds = 1;
    overrides.maxAttempts = 1;
    overrides.drive = { prompt: scenarioPrompt };
    server = await startServer(overrides);
  });
  afterAll(async () => {
    await server.close();
  });

  it('continues a cold session in the same attempt seeded with the operator message', async () => {
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
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    const runsBefore = await server.app.ctx.attempts.listForTask(mirrored.id);
    const attemptBefore = runsBefore.at(-1);

    const steered = await server.api('POST', `/api/tasks/${mirrored.id}/steer`, { text: 'actually, focus on the parser' });
    expect(steered.status).toBe(200);
    expect(steered.body).toEqual({ ok: true });

    const latest = await waitFor(async () => {
      const all = await server.app.ctx.attempts.listForTask(mirrored.id);
      const last = all.at(-1);
      return all.length === runsBefore.length && last?.prompt?.includes('actually, focus on the parser') ? last : undefined;
    });
    expect(latest.id).toBe(attemptBefore?.id);
    expect(latest.prompt).toContain('## Operator message');
    expect(latest.prompt).not.toContain('ticket 90210');
  });

  it('409s when the settled task has no warm session (e.g. a plain done native task)', async () => {
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
