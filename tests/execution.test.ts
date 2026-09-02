import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor, cancelRunningTasks, type TestServer } from './helpers.js';
import { attemptToolCalls, attempts, guardrailEvents } from '../src/db/schema.js';
import type { DeepPartial, AppConfig } from '../src/config.js';
import { AttemptStore } from '../src/domain/attempts.js';

const scenario = (s: object) => JSON.stringify(s);

describe('run execution over ACP (direct mode)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await cancelRunningTasks(server);
  });
  afterAll(async () => {
    await server.close();
  });

  async function createAndRun(scenarioObj: object): Promise<{ taskId: number; attemptId: number }> {
    const created = await server.api('POST', '/api/tasks', { prompt: scenario(scenarioObj) });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, attemptId: started.body.id };
  }

  it('runs a ready task to done, persisting tool-call aggregates but no session/update events', async () => {
    const updates = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working…' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Write file',
        kind: 'edit',
        status: 'pending',
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
    ];
    const { taskId, attemptId } = await createAndRun({ updates, stopReason: 'end_turn' });

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = await server.api('GET', `/api/attempts/${attemptId}`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ taskId, number: 1, state: 'completed', stopReason: 'end_turn' });
    expect(run.body.finishedAt).toBeGreaterThan(0);
    const attempt1 = (await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`)).body.attempts.find((a: any) => a.number === 1);
    expect(attempt1.state).toBe('passed');
    expect(attempt1.steps.map((s: any) => s.type)).toEqual(['implementation']);
    expect(attempt1.steps.every((s: any) => s.state === 'passed')).toBe(true);

    const events = await server.api('GET', `/api/attempts/${attemptId}/events`);
    expect(events.status).toBe(200);
    expect(events.body.events.filter((e: any) => e.type === 'session_update')).toEqual([]);
    const toolCalls = await server.app.ctx.asyncDb.read((db) =>
      db.select().from(attemptToolCalls).where(eq(attemptToolCalls.attemptId, attemptId)).all(),
    );
    expect(toolCalls).toEqual([{ attemptId, toolName: 'Write file', count: 1 }]);
    expect(events.body.events.map((e: any) => e.seq)).toEqual(
      [...events.body.events.map((e: any) => e.seq)].sort((a: number, b: number) => a - b),
    );
  });

  it('a native Run resolves and uses the Workspace Task Prompt override, else inherits the global default (ADR-0044/#339)', async () => {
    const wsId = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id;
    const promptOf = async (attemptId: number) =>
      (await server.app.ctx.asyncDb.read((d) => d.select().from(attempts).where(eq(attempts.id, attemptId)).get()))!.prompt;
    const settle = async (taskId: number) =>
      waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done' ? true : undefined), {
        timeoutMs: 20_000,
      });
    const scenarioObj = { updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }], stopReason: 'end_turn' };

    const inherit = await createAndRun(scenarioObj);
    await settle(inherit.taskId);
    const inheritPrompt = await promptOf(inherit.attemptId);

    let overridePrompt: string | null;
    try {
      expect((await server.api('PATCH', `/api/workspaces/${wsId}`, { taskPrompt: 'WS-TASKPROMPT::{prompt}' })).status).toBe(200);
      const override = await createAndRun(scenarioObj);
      await settle(override.taskId);
      overridePrompt = await promptOf(override.attemptId);
    } finally {
      await server.api('PATCH', `/api/workspaces/${wsId}`, { taskPrompt: null });
    }

    expect(inheritPrompt).not.toBeNull();
    expect(overridePrompt).not.toBeNull();
    expect(inheritPrompt!.startsWith(scenario(scenarioObj))).toBe(true);
    expect(overridePrompt!.startsWith('WS-TASKPROMPT::')).toBe(true);
  });

  it('a native Run merges terminal exactly once — done is final and the escalation actions refuse (ADR-0041)', async () => {
    const { taskId, attemptId } = await createAndRun({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }],
      stopReason: 'end_turn',
    });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');

    const merged = (await server.api('GET', `/api/attempts/${attemptId}`)).body;
    expect(merged.state).toBe('completed');
    expect(merged.finishedAt).toBeGreaterThan(0);

    const attempt1 = (await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`)).body.attempts.find((a: any) => a.number === 1);
    expect(attempt1.state).toBe('passed');
    expect(attempt1.steps.map((s: any) => s.type)).toEqual(['implementation']);
    expect(attempt1.steps.every((s: any) => s.state === 'passed')).toBe(true);
    expect((await server.api('POST', `/api/tasks/${taskId}/accept`)).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${taskId}/reject`, { guidance: 'nope' })).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${taskId}/close`)).status).toBe(409);
    expect((await server.api('GET', `/api/attempts/${attemptId}`)).body).toMatchObject({ state: 'completed' });
  });

  it('cancelling a working Task settles its running Run cancelled (issue #114)', async () => {
    const { taskId, attemptId } = await createAndRun({ exit: 'hang' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'working');
    await waitFor(async () => ((await server.api('GET', `/api/attempts/${attemptId}`)).body.sessionId ? true : undefined));
    expect((await server.api('GET', `/api/attempts/${attemptId}`)).body.state).toBe('running');

    const cancelled = await server.api('POST', `/api/tasks/${taskId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');
    const run = (await server.api('GET', `/api/attempts/${attemptId}`)).body;
    expect(run.state).toBe('cancelled');
  });

  it('records each resumed loop as a distinct run and history survives a Reject with guidance', async () => {
    const { taskId, attemptId } = await createAndRun({ exit: 'crash-before-response' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'escalated');

    const beforeReject = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts;
    expect(beforeReject[0]!.id).toBe(attemptId);
    const lastAttemptBeforeReject = beforeReject.at(-1)!.number;

    const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, { guidance: 'try again', start: true });
    expect(rejected.status).toBe(200);

    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'escalated');

    const afterReject = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts;
    expect(afterReject.slice(0, beforeReject.length)).toEqual(beforeReject);
    expect(afterReject.length).toBeGreaterThan(beforeReject.length);
    const attemptNumbers = afterReject.map((r: { number: number }) => r.number);
    expect(attemptNumbers).toEqual([...attemptNumbers].sort((a, b) => a - b));
    expect(new Set(attemptNumbers).size).toBe(attemptNumbers.length);
    expect(afterReject.at(-1)!.number).toBeGreaterThan(lastAttemptBeforeReject);
  });

  it('escalates the task when the harness crashes on every attempt', async () => {
    const { taskId } = await createAndRun({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'about to die' } }],
      exit: 'crash-before-response',
    });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'escalated');
    const run = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
    expect(run.body.state).toBe('failed');
    expect(run.body.reason).toBeTruthy();
    expect((await server.api('GET', `/api/tasks/${taskId}`)).body.escalationReason).toMatch(/^escalated to human: attempt \d+ of \d+ failed/);
  });

  it('cancelling a running task kills the harness process and the run', async () => {
    const { taskId, attemptId } = await createAndRun({ exit: 'hang' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'working');

    const cancelled = await server.api('POST', `/api/tasks/${taskId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/attempts/${attemptId}`);
      return body.state === 'cancelled' ? body : undefined;
    });
    expect(run.state).toBe('cancelled');
  });

  it('force-completing a running task kills the harness and settles the run completed', async () => {
    const { taskId, attemptId } = await createAndRun({ exit: 'hang' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'working');

    const completed = await server.api('POST', `/api/tasks/${taskId}/complete`);
    expect(completed.status).toBe(200);
    expect(completed.body.state).toBe('done');

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/attempts/${attemptId}`);
      return body.state === 'completed' ? body : undefined;
    });
    expect(run.state).toBe('completed');

    expect((await server.api('POST', `/api/tasks/${taskId}/complete`)).status).toBe(409);
  });

  it('auto-grants permission requests and records them as run events', async () => {
    const { taskId, attemptId } = await createAndRun({
      requestPermission: { title: 'Write hello.txt' },
    });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');

    const events = await server.api('GET', `/api/attempts/${attemptId}/events`);
    const types = events.body.events.map((e: any) => e.type);
    expect(types).toContain('permission_request');
    const permission = events.body.events.find((e: any) => e.type === 'permission_request');
    expect(permission.payload.outcome).toMatchObject({ outcome: 'selected' });
  });

  it('an unauthenticated codex spawn fails the run with a legible reason', async () => {
    const overrides = stubHarness('codex') as any;
    overrides.harnesses.codex.env = {
      STUB_SESSION_NEW_ERROR: JSON.stringify({ code: -32000, message: 'Authentication required' }),
    };
    const codexServer = await startServer(overrides);
    try {
      const created = await codexServer.api('POST', '/api/tasks', { harness: 'codex', prompt: 'hi' });
      await codexServer.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(async () => (await codexServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated');

      const run = (await codexServer.api('GET', `/api/tasks/${created.body.id}/attempts/current`)).body;
      expect(run.state).toBe('failed');
      expect(run.reason).toContain('Authentication required');
    } finally {
      await codexServer.close();
    }
  });

  it('surfaces the harness stderr when it exits non-zero without a clean ACP error', async () => {
    const detail = 'stream error: unknown model "gpt-5.2-codex-mini"';
    const overrides = stubHarness('codex') as any;
    overrides.harnesses.codex.env = { STUB_STARTUP_STDERR: detail };
    const codexServer = await startServer(overrides);
    try {
      const created = await codexServer.api('POST', '/api/tasks', { harness: 'codex', prompt: 'hi' });
      await codexServer.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(async () => (await codexServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated');

      const run = (await codexServer.api('GET', `/api/tasks/${created.body.id}/attempts/current`)).body;
      expect(run.state).toBe('failed');
      expect(run.reason).toContain('exited (code 1');
      expect(run.reason).toContain(detail);
    } finally {
      await codexServer.close();
    }
  });

  it('surfaces a contradicting observed model on the run (Q7: the pin must be real)', async () => {
    const codexServer = await startServer(stubHarness('codex'));
    try {
      const runWith = async (model: string, observedModel: string) => {
        const created = await codexServer.api('POST', '/api/tasks', {
          harness: 'codex',
          model,
          prompt: scenario({
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            _meta: {
              quota: {
                model_usage: [
                  { model: observedModel, token_count: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
                ],
              },
            },
          }),
        });
        const started = await codexServer.api('POST', `/api/tasks/${created.body.id}/run`);
        await waitFor(
          async () => (await codexServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done',
        );
        const events = await codexServer.api('GET', `/api/attempts/${started.body.id}/events`);
        return events.body.events.find((e: any) => e.payload?.event === 'model_mismatch');
      };

      const mismatch = await runWith('gpt-5.4-mini[low]', 'gpt-5.5');
      expect(mismatch).toBeTruthy();
      expect(mismatch.payload).toMatchObject({ expected: 'gpt-5.4-mini[low]', observed: ['gpt-5.5'] });

      expect(await runWith('gpt-5.4-mini[low]', 'gpt-5.4-mini')).toBeUndefined();
    } finally {
      await codexServer.close();
    }
  });

  it('does not persist session-update echoes from model pinning', async () => {
    const copilotServer = await startServer(stubHarness('copilot'));
    const setModelEcho = async (srv: TestServer, harness: string, model: string) => {
      const created = await srv.api('POST', '/api/tasks', {
        harness,
        model,
        prompt: scenario({ echoSetModel: true }),
      });
      const started = await srv.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(
        async () => (await srv.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done',
      );
      const events = await srv.api('GET', `/api/attempts/${started.body.id}/events`);
      return events.body.events.find((e: any) => e.type === 'session_update') ?? null;
    };
    try {
      expect(await setModelEcho(copilotServer, 'copilot', 'claude-haiku-4.5')).toBeNull();
      expect(await setModelEcho(copilotServer, 'copilot', 'auto')).toBeNull();
      expect(await setModelEcho(server, 'claude', 'claude-sonnet-5')).toBeNull();
    } finally {
      await copilotServer.close();
    }
  });

  it('an unauthenticated copilot spawn fails the run with a legible reason', async () => {
    const overrides = stubHarness('copilot') as any;
    overrides.harnesses.copilot.env = {
      STUB_SESSION_NEW_ERROR: JSON.stringify({ code: -32000, message: 'Authentication required' }),
    };
    const copilotServer = await startServer(overrides);
    try {
      const created = await copilotServer.api('POST', '/api/tasks', { harness: 'copilot', prompt: 'hi' });
      await copilotServer.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(
        async () => (await copilotServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated',
      );
      const run = (await copilotServer.api('GET', `/api/tasks/${created.body.id}/attempts/current`)).body;
      expect(run.state).toBe('failed');
      expect(run.reason).toContain('Authentication required');
    } finally {
      await copilotServer.close();
    }
  });

  it('run rejects tasks that are not ready', async () => {
    const draft = await server.api('POST', '/api/tasks', { prompt: 'p', state: 'draft' });
    expect((await server.api('POST', `/api/tasks/${draft.body.id}/run`)).status).toBe(409);
  });
});

describe('direct Work Context occupancy (ADR-0001, ADR-0046)', () => {
  let server: TestServer;
  const workingDirA = mkdtempSync(join(tmpdir(), 'harmonic-context-a-'));
  const workingDirC = mkdtempSync(join(tmpdir(), 'harmonic-context-c-'));

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await cancelRunningTasks(server);
  });
  afterAll(async () => {
    await server.close();
  });

  it('attaches a second Run to an already-working direct context (201), not blocked — the operator\'s accepted risk (ADR-0046, #369)', async () => {
    const createdA = await server.api('POST', '/api/tasks', {
      prompt: scenario({ exit: 'hang' }),
      workingDir: workingDirA,
    });
    expect(createdA.status).toBe(201);
    const taskAId = createdA.body.id;
    const startedA = await server.api('POST', `/api/tasks/${taskAId}/run`);
    expect(startedA.status).toBe(201);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskAId}`)).body.state === 'working');

    const createdB = await server.api('POST', '/api/tasks', {
      prompt: scenario({ exit: 'hang' }),
      workingDir: workingDirA,
    });
    expect(createdB.status).toBe(201);
    const taskBId = createdB.body.id;
    const startedB = await server.api('POST', `/api/tasks/${taskBId}/run`);
    expect(startedB.status).toBe(201);

    const runsB = await server.api('GET', `/api/tasks/${taskBId}/attempts`);
    expect(runsB.body.attempts).toHaveLength(1);
  });

  it('does not block a different Work Context while A is still working (control)', async () => {
    const createdC = await server.api('POST', '/api/tasks', {
      prompt: scenario({ exit: 'hang' }),
      workingDir: workingDirC,
    });
    expect(createdC.status).toBe(201);
    const startedC = await server.api('POST', `/api/tasks/${createdC.body.id}/run`);
    expect(startedC.status).toBe(201);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${createdC.body.id}`)).body.state === 'working');
  });
});

describe('crash recovery', () => {
  it('marks in-flight runs failed with reason "interrupted" on restart and re-queues their tickets, never re-running them blind', async () => {
    const server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: scenario({ exit: 'hang' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'working');

    await server.app.close();
    const reopened = await startServer(stubHarness(), { dataDir: server.dataDir });

    const task = await reopened.api('GET', `/api/tasks/${created.body.id}`);
    expect(task.body.state).toBe('ready');
    const run = await reopened.api('GET', `/api/attempts/${started.body.id}`);
    expect(run.body.state).toBe('failed');
    expect(run.body.reason).toBe('process-death');

    await reopened.close();
  });
});

describe('wall-clock guardrail (issue #127)', () => {
  it('trips an over-budget run to Escalation via the coordinator, with a budget reason derived from a guardrail_events row', async () => {
    const server = await startServer({
      ...stubHarness(),
      guardrails: { budget: { wallClockMinutes: 0.01 } },
    });
    try {
      const created = await server.api('POST', '/api/tasks', { prompt: scenario({ exit: 'hang' }) });
      expect(created.status).toBe(201);
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      expect(started.status).toBe(201);
      const taskId = created.body.id;
      const attemptId = started.body.id;

      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'escalated' ? body : undefined;
      });
      expect(task.state).toBe('escalated');

      const run = (await server.api('GET', `/api/attempts/${attemptId}`)).body;
      expect(run.state).toBe('failed');
      expect(run.reason).toMatch(/^budget:/);

      const events = (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events;
      const trip = events.find(
        (e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped',
      );
      expect(trip).toBeTruthy();
      expect(trip.payload.dimension).toBe('wall-clock');

      const rows = await server.app.ctx.asyncDb.read((d) =>
        d.select().from(guardrailEvents).where(eq(guardrailEvents.attemptId, attemptId)).all(),
      );
      expect(rows).toHaveLength(1);
      const event = rows[0]!;
      expect(event).toMatchObject({ dimension: 'wall-clock', configSource: 'default' });
      expect(event.observedValue).toBeGreaterThanOrEqual(event.limitValue);
    } finally {
      await server.close();
    }
  });

  it('does not kill an over-budget run after its attempt tasks enter merging', async () => {
    const server = await startServer({
      ...stubHarness(),
      guardrails: { budget: { wallClockMinutes: 0.01 } },
    });
    try {
      const created = await server.api('POST', '/api/tasks', { prompt: scenario({ exit: 'hang' }) });
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      const attempts = new AttemptStore(server.app.ctx.asyncDb);
      const attempt = await waitFor(async () => (await attempts.listForTask(created.body.id))[0]);
      const implementation = await waitFor(async () => (await attempts.listSteps(attempt.id))[0]);

      await attempts.updateStep(implementation.id, { state: 'passed', verdict: 'pass', endedAt: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 800));

      expect((await server.api('GET', `/api/attempts/${started.body.id}`)).body.state).toBe('running');
      expect(
        await server.app.ctx.asyncDb.read((db) =>
          db.select().from(guardrailEvents).where(eq(guardrailEvents.attemptId, attempt.id)).all(),
        ),
      ).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe('token/cost budget guardrail (issue #128)', () => {
  const serverWithSpendGuardrail = async (opts: {
    workDir: string;
    models: Record<string, number>;
    guardrails: { budget: { wallClockMinutes?: number; tokens?: number | null; costUsd?: number | null } };
    prices?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
    pollMs?: number;
    graceMs?: number;
  }): Promise<TestServer> => {
    const logRoot = mkdtempSync(join(tmpdir(), 'harmonic-spend-logs-'));
    const overrides = stubHarness() as DeepPartial<AppConfig> & {
      harnesses: { claude: Record<string, unknown> };
      guardrails?: unknown;
      prices?: unknown;
    };
    overrides.harnesses.claude.sessionLogDir = logRoot;
    overrides.harnesses.claude.env = { STUB_SESSION_ID: 'fixed-session' };
    overrides.guardrails = { budget: { wallClockMinutes: 60, ...opts.guardrails.budget } };
    if (opts.prices) overrides.prices = opts.prices;

    const slug = opts.workDir.replace(/[^a-zA-Z0-9]/g, '-');
    mkdirSync(join(logRoot, slug), { recursive: true });
    const lines = Object.entries(opts.models).map(([model, inputTokens], i) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id: `msg-${model}-${i}`,
          model,
          usage: { input_tokens: inputTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }),
    );
    writeFileSync(join(logRoot, slug, 'fixed-session.jsonl'), lines.join('\n'));

    return startServer(overrides, {
      runnerTuning: { spendGuardrail: { pollMs: opts.pollMs ?? 50, graceMs: opts.graceMs ?? 300 } },
    });
  };

  const runToEscalation = async (server: TestServer, workDir: string) => {
    const created = await server.api('POST', '/api/tasks', {
      prompt: scenario({ exit: 'hang' }),
      workingDir: workDir,
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    const taskId = created.body.id;
    const attemptId = started.body.id;

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'escalated' ? body : undefined;
    });
    expect(task.state).toBe('escalated');

    const run = (await server.api('GET', `/api/attempts/${attemptId}`)).body;
    return { taskId, attemptId, task, run };
  };

  it('trips an over-cap token budget to Escalation, with dimension "tokens" on the guardrail_events row', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'harmonic-spend-work-'));
    const server = await serverWithSpendGuardrail({
      workDir,
      models: { 'stub-model': 10_000 },
      guardrails: { budget: { tokens: 1_000 } },
    });
    try {
      const { attemptId, run } = await runToEscalation(server, workDir);
      expect(run.state).toBe('failed');
      expect(run.reason).toMatch(/^budget:/);

      const events = (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events;
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip).toBeTruthy();
      expect(trip.payload.dimension).toBe('tokens');

      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.attemptId, attemptId)).all());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dimension: 'tokens', configSource: 'default' });
      expect(rows[0]!.observedValue).toBeGreaterThanOrEqual(rows[0]!.limitValue);
    } finally {
      await server.close();
    }
  });

  it('trips an over-cap cost budget (priced model) to Escalation, with dimension "cost" on the guardrail_events row', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'harmonic-spend-work-'));
    const server = await serverWithSpendGuardrail({
      workDir,
      models: { 'stub-model': 2_000_000 },
      guardrails: { budget: { costUsd: 1 } },
      prices: {
        'stub-model': { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
        auto: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });
    try {
      const { attemptId, run } = await runToEscalation(server, workDir);
      expect(run.state).toBe('failed');
      expect(run.reason).toMatch(/^budget:/);

      const events = (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events;
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip).toBeTruthy();
      expect(trip.payload.dimension).toBe('cost');

      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.attemptId, attemptId)).all());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dimension: 'cost', configSource: 'default' });
      expect(rows[0]!.observedValue).toBeGreaterThanOrEqual(rows[0]!.limitValue);
      expect(rows[0]!.limitValue).toBe(1_000_000);
    } finally {
      await server.close();
    }
  });

  it('falls back to enforcing the token cap when the cost cap is on an unpriced model — not a silent no-op', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'harmonic-spend-work-'));
    const server = await serverWithSpendGuardrail({
      workDir,
      models: { 'stub-model': 10_000 },
      guardrails: { budget: { costUsd: 5, tokens: 1_000 } },
    });
    try {
      const { attemptId, run } = await runToEscalation(server, workDir);
      expect(run.state).toBe('failed');
      expect(run.reason).toMatch(/^budget:/);

      const events = (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events;
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip).toBeTruthy();
      expect(trip.payload.dimension).toBe('tokens');

      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.attemptId, attemptId)).all());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dimension: 'tokens', configSource: 'default' });
    } finally {
      await server.close();
    }
  });

  it('Escalates a configured spend cap that stays unmeasurable past the grace window', async () => {
    const server = await startServer(
      { ...stubHarness(), guardrails: { budget: { wallClockMinutes: 60, tokens: 1_000 } } },
      { runnerTuning: { spendGuardrail: { pollMs: 50, graceMs: 300 } } },
    );
    try {
      const created = await server.api('POST', '/api/tasks', { prompt: scenario({ exit: 'hang' }) });
      expect(created.status).toBe(201);
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      expect(started.status).toBe(201);
      const taskId = created.body.id;
      const attemptId = started.body.id;

      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'escalated' ? body : undefined;
      });
      expect(task.state).toBe('escalated');

      const run = (await server.api('GET', `/api/attempts/${attemptId}`)).body;
      expect(run.state).toBe('failed');
      expect(run.reason).toMatch(/unmeasurable/);

      const events = (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events;
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip).toBeTruthy();
      expect(trip.payload.dimension).toBe('tokens');

      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.attemptId, attemptId)).all());
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dimension).toBe('tokens');
      expect(JSON.parse(rows[0]!.payload)).toMatchObject({ unmeasurable: true });
    } finally {
      await server.close();
    }
  });

});

describe('progress guardrail (issue #131)', () => {
  const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

  it('nudges once through the steer channel, then trips a still-stalled run to Escalation', async () => {
    const server = await startServer({
      ...stubHarness(),
      guardrails: { progress: true },
    });
    try {
      const created = await server.api('POST', '/api/tasks', {
        prompt: scenario({ updates: [chunk('thinking…'), chunk('still thinking…'), chunk('hmm…')], stopReason: 'end_turn' }),
      });
      expect(created.status).toBe(201);
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      expect(started.status).toBe(201);
      const taskId = created.body.id;
      const attemptId = started.body.id;

      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'escalated' ? body : undefined;
      });
      expect(task.state).toBe('escalated');

      const run = (await server.api('GET', `/api/attempts/${attemptId}`)).body;
      expect(run.state).toBe('failed');
      expect(run.reason).toMatch(/^stalled:/);

      const events = (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events;
      const nudges = events.filter((e: any) => e.type === 'lifecycle' && e.payload.event === 'progress-nudge');
      expect(nudges).toHaveLength(1);
      expect(events.some((e: any) => e.type === 'lifecycle' && e.payload.event === 'steer_delivered')).toBe(true);
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip.payload.dimension).toBe('progress');

      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.attemptId, attemptId)).all());
      expect(rows).toHaveLength(1);
      expect(rows[0]!).toMatchObject({ dimension: 'progress', configSource: 'default' });
    } finally {
      await server.close();
    }
  });

  it('does not false-trip while a tool call is outstanding (the suspend rule)', async () => {
    const server = await startServer({
      ...stubHarness(),
      guardrails: { progress: true },
    });
    try {
      const created = await server.api('POST', '/api/tasks', {
        prompt: scenario({
          updates: [
            chunk('thinking…'),
            chunk('still thinking…'),
            chunk('hmm…'),
            { sessionUpdate: 'tool_call', toolCallId: 'slow-1', title: 'Long build', kind: 'execute', status: 'in_progress' },
          ],
          stopReason: 'end_turn',
        }),
      });
      const taskId = created.body.id;
      const attemptId = startedId(await server.api('POST', `/api/tasks/${taskId}/run`));

      await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');
      const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      expect(task.state).toBe('done');

      const events = (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events;
      expect(events.some((e: any) => e.type === 'lifecycle' && e.payload.event === 'progress-nudge')).toBe(false);
      expect(events.some((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped')).toBe(false);
      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.attemptId, attemptId)).all());
      expect(rows).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('a hard tool-timeout backstops a hung tool call: emits a run_fact and Escalates', async () => {
    const server = await startServer({
      ...stubHarness(),
      guardrails: { progress: true, toolTimeoutMinutes: 0.01 },
    });
    try {
      const created = await server.api('POST', '/api/tasks', {
        prompt: scenario({
          updates: [{ sessionUpdate: 'tool_call', toolCallId: 'hang-1', title: 'Endless build', kind: 'execute', status: 'in_progress' }],
          exit: 'hang',
        }),
      });
      const taskId = created.body.id;
      const attemptId = startedId(await server.api('POST', `/api/tasks/${taskId}/run`));

      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'escalated' ? body : undefined;
      });
      expect(task.state).toBe('escalated');

      const run = (await server.api('GET', `/api/attempts/${attemptId}`)).body;
      expect(run.state).toBe('failed');
      expect(run.reason).toMatch(/tool unresponsive/);

      const events = (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events;
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip.payload.dimension).toBe('tool-timeout');

      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.attemptId, attemptId)).all());
      expect(rows).toHaveLength(1);
      expect(rows[0]!).toMatchObject({ dimension: 'tool-timeout', configSource: 'default' });
    } finally {
      await server.close();
    }
  });
});

function startedId(res: { status: number; body: { id: number } }): number {
  expect(res.status).toBe(201);
  return res.body.id;
}
