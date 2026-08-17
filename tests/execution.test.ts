import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { guardrailEvents } from '../src/db/schema.js';
import type { DeepPartial, AppConfig } from '../src/config.js';

const scenario = (s: object) => JSON.stringify(s);

describe('run execution over ACP (direct mode)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  async function createAndRun(scenarioObj: object): Promise<{ taskId: number; runId: number }> {
    const created = await server.api('POST', '/api/tasks', { prompt: scenario(scenarioObj) });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, runId: started.body.id };
  }

  it('runs a ready task to awaiting-review, persisting every session/update as a run event', async () => {
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
    const { taskId, runId } = await createAndRun({ updates, stopReason: 'end_turn' });

    // Task passes through running…
    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'awaiting-review' ? body : undefined;
    });
    expect(task.state).toBe('awaiting-review');

    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.status).toBe(200);
    // A native Run parks non-terminal in `phase:'review'` at agent-finish — it
    // holds `state:'running'` until the human accepts/rejects it (issue #114).
    expect(run.body).toMatchObject({ taskId, attempt: 1, state: 'running', phase: 'review', stopReason: 'end_turn' });
    expect(run.body.finishedAt).toBeNull();
    // Agent-finish took it executing → validating → verifying → review, never
    // jumping straight to a terminal phase.
    const phaseEvents = (await server.api('GET', `/api/runs/${runId}/events`)).body.events
      .filter((e: any) => e.type === 'lifecycle' && e.payload.event === 'phase')
      .map((e: any) => e.payload.phase);
    expect(phaseEvents).toEqual(['validating', 'verifying', 'review']);

    const events = await server.api('GET', `/api/runs/${runId}/events`);
    expect(events.status).toBe(200);
    const persisted = events.body.events.filter((e: any) => e.type === 'session_update');
    expect(persisted.map((e: any) => e.payload.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ]);
    // seq is a stable per-run ordering
    expect(events.body.events.map((e: any) => e.seq)).toEqual(
      [...events.body.events.map((e: any) => e.seq)].sort((a: number, b: number) => a - b),
    );
  });

  it('accepting a review-parked native Run lands it terminal — completed exactly once (issue #114)', async () => {
    const { taskId, runId } = await createAndRun({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }],
      stopReason: 'end_turn',
    });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');

    // Parked non-terminal in `review`, holding no terminal disposition yet.
    const parked = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(parked.state).toBe('running');
    expect(parked.phase).toBe('review');
    expect(parked.finishedAt).toBeNull();

    // Accept lands it: Run → completed (phase terminal), Task → completed.
    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.state).toBe('completed');
    const landed = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(landed.state).toBe('completed');
    expect(landed.phase).toBe('terminal');
    expect(landed.review).toBe('accepted');
    expect(landed.finishedAt).toBeGreaterThan(0);

    // The full phase path is reconstructable from the persisted event log:
    // executing → validating → verifying → review (drive loop) then landing on
    // Accept (§0.2: landing happens after Accept). `terminal` is the coordinator's
    // row write, not a drive-loop phase event.
    const phases = (await server.api('GET', `/api/runs/${runId}/events`)).body.events
      .filter((e: any) => e.type === 'lifecycle' && e.payload.event === 'phase')
      .map((e: any) => e.payload.phase);
    expect(phases).toEqual(['validating', 'verifying', 'review', 'landing']);
    // A second accept refuses — the Task is terminal.
    expect((await server.api('POST', `/api/tasks/${taskId}/accept`)).status).toBe(409);
  });

  it('rejecting a review-parked native Run fails it terminal (issue #114)', async () => {
    const { taskId, runId } = await createAndRun({ stopReason: 'end_turn' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');

    const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, { feedback: 'nope' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.state).toBe('failed');
    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.state).toBe('failed');
    expect(run.phase).toBe('terminal');
    expect(run.review).toBe('rejected');
  });

  it('cancelling an awaiting-review Task settles its review-parked Run cancelled (issue #114)', async () => {
    const { taskId, runId } = await createAndRun({ stopReason: 'end_turn' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');
    expect((await server.api('GET', `/api/runs/${runId}`)).body.state).toBe('running');

    const cancelled = await server.api('POST', `/api/tasks/${taskId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');
    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.state).toBe('cancelled');
    expect(run.phase).toBe('terminal');
  });

  it('records each attempt as a distinct run and history survives retries', async () => {
    const { taskId, runId } = await createAndRun({ exit: 'crash-before-response' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'failed');

    const requeued = await server.api('POST', `/api/tasks/${taskId}/requeue`);
    expect(requeued.status).toBe(200);
    expect(requeued.body.state).toBe('ready');

    const second = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(runId);
    expect(second.body.attempt).toBe(2);

    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'failed');
    const runs = await server.api('GET', `/api/tasks/${taskId}/runs`);
    expect(runs.body.runs).toHaveLength(2);
  });

  it('moves the task to failed when the harness crashes mid-run', async () => {
    const { taskId, runId } = await createAndRun({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'about to die' } }],
      exit: 'crash-before-response',
    });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'failed');
    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.body.state).toBe('failed');
    expect(run.body.reason).toBeTruthy();
  });

  it('cancelling a running task kills the harness process and the run', async () => {
    const { taskId, runId } = await createAndRun({ exit: 'hang' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'running');

    const cancelled = await server.api('POST', `/api/tasks/${taskId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'cancelled' ? body : undefined;
    });
    expect(run.state).toBe('cancelled');
  });

  it('force-completing a running task kills the harness and settles the run completed', async () => {
    const { taskId, runId } = await createAndRun({ exit: 'hang' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'running');

    const completed = await server.api('POST', `/api/tasks/${taskId}/complete`);
    expect(completed.status).toBe(200);
    expect(completed.body.state).toBe('completed');

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'completed' ? body : undefined;
    });
    expect(run.state).toBe('completed');

    // Terminal: a second complete refuses.
    expect((await server.api('POST', `/api/tasks/${taskId}/complete`)).status).toBe(409);
  });

  it('auto-grants permission requests and records them as run events', async () => {
    const { taskId, runId } = await createAndRun({
      requestPermission: { title: 'Write hello.txt' },
    });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');

    const events = await server.api('GET', `/api/runs/${runId}/events`);
    const types = events.body.events.map((e: any) => e.type);
    expect(types).toContain('permission_request');
    // The stub echoes the outcome we returned — proving the grant went over the wire.
    const echo = events.body.events.find(
      (e: any) => e.type === 'session_update' && e.payload.content?.text?.startsWith('permission:'),
    );
    expect(echo.payload.content.text).toContain('selected');
  });

  it('an unauthenticated codex spawn fails the run with a legible reason', async () => {
    // Spike (issue 22): codex-acp starts fine unauthenticated; session/new
    // then fails with JSON-RPC {"code":-32000,"message":"Authentication
    // required"}. The operator must see that message, not a bare exit code.
    const overrides = stubHarness('codex') as any;
    overrides.harnesses.codex.env = {
      STUB_SESSION_NEW_ERROR: JSON.stringify({ code: -32000, message: 'Authentication required' }),
    };
    const codexServer = await startServer(overrides);
    try {
      const created = await codexServer.api('POST', '/api/tasks', { harness: 'codex', prompt: 'hi' });
      const started = await codexServer.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(async () => (await codexServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'failed');

      const run = (await codexServer.api('GET', `/api/runs/${started.body.id}`)).body;
      expect(run.state).toBe('failed');
      expect(run.reason).toContain('Authentication required');
    } finally {
      await codexServer.close();
    }
  });

  it('surfaces the harness stderr when it exits non-zero without a clean ACP error', async () => {
    // The user-reported failure mode: the harness process exits code 1 during
    // the handshake and prints its real reason only to stderr (no JSON-RPC
    // error). Harmonic must carry that reason onto the run — a bare "exited
    // (code 1)" is undebuggable.
    const detail = 'stream error: unknown model "gpt-5.2-codex-mini"';
    const overrides = stubHarness('codex') as any;
    overrides.harnesses.codex.env = { STUB_STARTUP_STDERR: detail };
    const codexServer = await startServer(overrides);
    try {
      const created = await codexServer.api('POST', '/api/tasks', { harness: 'codex', prompt: 'hi' });
      const started = await codexServer.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(async () => (await codexServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'failed');

      const run = (await codexServer.api('GET', `/api/runs/${started.body.id}`)).body;
      expect(run.state).toBe('failed');
      expect(run.reason).toContain('exited (code 1'); // still says what happened…
      expect(run.reason).toContain(detail); // …and now why
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
          async () => (await codexServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review',
        );
        const events = await codexServer.api('GET', `/api/runs/${started.body.id}/events`);
        return events.body.events.find((e: any) => e.payload?.event === 'model_mismatch');
      };

      // The harness ran a different model than the task pinned: surfaced.
      const mismatch = await runWith('gpt-5.4-mini[low]', 'gpt-5.5');
      expect(mismatch).toBeTruthy();
      expect(mismatch.payload).toMatchObject({ expected: 'gpt-5.4-mini[low]', observed: ['gpt-5.5'] });

      // Observed model matching the pin's base (effort stripped): no noise.
      expect(await runWith('gpt-5.4-mini[low]', 'gpt-5.4-mini')).toBeUndefined();
    } finally {
      await codexServer.close();
    }
  });

  it('copilot pins the model via ACP session/set_model before the prompt — sent even for auto', async () => {
    // Spike (issue 25): --model/COPILOT_MODEL are dead in --acp mode, and
    // an unpinned session inherits the operator's persisted settings.json
    // model — so the pin must go over session/set_model on every run.
    const copilotServer = await startServer(stubHarness('copilot'));
    const setModelEcho = async (srv: TestServer, harness: string, model: string) => {
      const created = await srv.api('POST', '/api/tasks', {
        harness,
        model,
        prompt: scenario({ echoSetModel: true }),
      });
      const started = await srv.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(
        async () => (await srv.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review',
      );
      const events = await srv.api('GET', `/api/runs/${started.body.id}/events`);
      const echo = events.body.events.find((e: any) =>
        e.payload?.content?.text?.startsWith?.('set-model:'),
      );
      return JSON.parse(echo.payload.content.text.slice('set-model:'.length));
    };
    try {
      expect(await setModelEcho(copilotServer, 'copilot', 'claude-haiku-4.5')).toMatchObject({
        modelId: 'claude-haiku-4.5',
      });
      expect(await setModelEcho(copilotServer, 'copilot', 'auto')).toMatchObject({ modelId: 'auto' });
      // Claude pins at spawn time; no set_model goes over the wire.
      expect(await setModelEcho(server, 'claude', 'claude-sonnet-5')).toBeNull();
    } finally {
      await copilotServer.close();
    }
  });

  it('an unauthenticated copilot spawn fails the run with a legible reason', async () => {
    // Spike (issue 25, capture 6c): session/new fails with JSON-RPC
    // {"code":-32000,"message":"Authentication required"} — byte-identical
    // to codex. The operator must see that message.
    const overrides = stubHarness('copilot') as any;
    overrides.harnesses.copilot.env = {
      STUB_SESSION_NEW_ERROR: JSON.stringify({ code: -32000, message: 'Authentication required' }),
    };
    const copilotServer = await startServer(overrides);
    try {
      const created = await copilotServer.api('POST', '/api/tasks', { harness: 'copilot', prompt: 'hi' });
      const started = await copilotServer.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(
        async () => (await copilotServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'failed',
      );
      const run = (await copilotServer.api('GET', `/api/runs/${started.body.id}`)).body;
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

describe('Work Context lease (issue #119)', () => {
  let server: TestServer;
  const workingDirA = mkdtempSync(join(tmpdir(), 'harmonic-lease-a-'));
  const workingDirC = mkdtempSync(join(tmpdir(), 'harmonic-lease-c-'));
  let taskAId: number;
  let taskBId: number;
  let runAId: number;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('blocks a second Run into an already-held context (409), leaving the Task ready with no run rows', async () => {
    const createdA = await server.api('POST', '/api/tasks', {
      prompt: scenario({ exit: 'hang' }),
      workingDir: workingDirA,
    });
    expect(createdA.status).toBe(201);
    taskAId = createdA.body.id;
    const startedA = await server.api('POST', `/api/tasks/${taskAId}/run`);
    expect(startedA.status).toBe(201);
    runAId = startedA.body.id;
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskAId}`)).body.state === 'running');

    // Task B collides on the exact same workingDir (direct-mode keys ignore
    // branch, so the two are contending for the same physical occupancy).
    const createdB = await server.api('POST', '/api/tasks', {
      prompt: scenario({ exit: 'hang' }),
      workingDir: workingDirA,
    });
    expect(createdB.status).toBe(201);
    taskBId = createdB.body.id;
    const startedB = await server.api('POST', `/api/tasks/${taskBId}/run`);
    expect(startedB.status).toBe(409);

    // Not stranded running, and the rolled-back transaction left no run row.
    const taskB = await server.api('GET', `/api/tasks/${taskBId}`);
    expect(taskB.body.state).toBe('ready');
    const runsB = await server.api('GET', `/api/tasks/${taskBId}/runs`);
    expect(runsB.body.runs).toHaveLength(0);
  });

  it('does not block a different Work Context while A still holds its lease (control)', async () => {
    const createdC = await server.api('POST', '/api/tasks', {
      prompt: scenario({ exit: 'hang' }),
      workingDir: workingDirC,
    });
    expect(createdC.status).toBe(201);
    const startedC = await server.api('POST', `/api/tasks/${createdC.body.id}/run`);
    expect(startedC.status).toBe(201);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${createdC.body.id}`)).body.state === 'running');
    // Left running; the harness process dies with the server on afterAll.
  });

  it('admits the blocked Task once the holder settles and releases its lease', async () => {
    const cancelled = await server.api('POST', `/api/tasks/${taskAId}/cancel`);
    expect(cancelled.status).toBe(200);
    await waitFor(async () => {
      const run = await server.api('GET', `/api/runs/${runAId}`);
      return run.body.state === 'cancelled';
    });

    const startedB = await server.api('POST', `/api/tasks/${taskBId}/run`);
    expect(startedB.status).toBe(201);
  });
});

describe('crash recovery', () => {
  it('marks in-flight runs failed with reason "interrupted" on restart, never re-running them', async () => {
    const server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: scenario({ exit: 'hang' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'running');

    // Simulate a workspace reboot: close the app but keep the data dir.
    await server.app.close();
    const reopened = await startServer(stubHarness(), { dataDir: server.dataDir });

    const task = await reopened.api('GET', `/api/tasks/${created.body.id}`);
    expect(task.body.state).toBe('failed');
    const run = await reopened.api('GET', `/api/runs/${started.body.id}`);
    expect(run.body.state).toBe('failed');
    expect(run.body.reason).toBe('interrupted');

    await reopened.close();
  });
});

describe('wall-clock guardrail (issue #127)', () => {
  it('trips an over-budget run to Escalation via the coordinator, with a budget reason derived from a guardrail_events row', async () => {
    // A tiny mandatory wall-clock budget plus a harness that never ends its
    // turn: the phase-scoped execution clock runs out mid-`executing` and the
    // watchdog trips the Run to Escalation (afk→hitl, ticket flagged) through
    // the terminal-disposition coordinator — never a direct settle, never a new
    // terminal state (reliability-design §0.3 / Unit A, ADR-0019).
    const server = await startServer({
      ...stubHarness(),
      guardrails: { budget: { wallClockMinutes: 0.01 } }, // 600ms execution budget
    });
    try {
      const created = await server.api('POST', '/api/tasks', { prompt: scenario({ exit: 'hang' }) });
      expect(created.status).toBe(201);
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      expect(started.status).toBe(201);
      const taskId = created.body.id;
      const runId = started.body.id;

      // The trip Escalates: the Task is flagged and handed back to a human.
      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.escalated ? body : undefined;
      });
      expect(task.escalated).toBe(true);

      // The Run settled to a terminal disposition (never a new state) with the
      // budget reason on the card — the reason derives from the trip evidence.
      const run = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(run.state).toBe('failed');
      expect(run.phase).toBe('terminal');
      expect(run.reason).toMatch(/^budget:/);

      // The trip is recorded on the timeline for observability.
      const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
      const trip = events.find(
        (e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped',
      );
      expect(trip).toBeTruthy();
      expect(trip.payload.dimension).toBe('wall-clock');

      // The structured guardrail_events row the card reason derives from is
      // persisted, in the execution phase, with observed ≥ the configured limit.
      const rows = server.app.ctx.db
        .select()
        .from(guardrailEvents)
        .where(eq(guardrailEvents.runId, runId))
        .all();
      expect(rows).toHaveLength(1);
      const event = rows[0]!;
      expect(event).toMatchObject({ dimension: 'wall-clock', configSource: 'default' });
      expect(['executing', 'validating', 'verifying']).toContain(event.phase);
      expect(event.observedValue).toBeGreaterThanOrEqual(event.limitValue);
    } finally {
      await server.close();
    }
  });
});

describe('token/cost budget guardrail (issue #128)', () => {
  /**
   * Boot a server whose stub harness "logs" the given per-model token usage
   * (`serverWithLoggedUsage`'s recipe, tests/cost.test.ts) under a Run
   * configured with a token/cost budget and a fast spend-guardrail poll —
   * the Runner-seam integration harness for the live spend-guard poll.
   */
  const serverWithSpendGuardrail = async (opts: {
    workDir: string;
    models: Record<string, number>; // model -> input_tokens
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

  /** Run a hanging afk-less scenario to Escalation and return the settled Task/Run. */
  const runToEscalation = async (server: TestServer, workDir: string) => {
    const created = await server.api('POST', '/api/tasks', {
      prompt: scenario({ exit: 'hang' }),
      workingDir: workDir,
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    const taskId = created.body.id;
    const runId = started.body.id;

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.escalated ? body : undefined;
    });
    expect(task.escalated).toBe(true);

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    return { taskId, runId, task, run };
  };

  it('trips an over-cap token budget to Escalation, with dimension "tokens" on the guardrail_events row', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'harmonic-spend-work-'));
    const server = await serverWithSpendGuardrail({
      workDir,
      models: { 'stub-model': 10_000 }, // well over the 1,000-token cap below
      guardrails: { budget: { tokens: 1_000 } },
    });
    try {
      const { runId, run } = await runToEscalation(server, workDir);
      expect(run.state).toBe('failed');
      expect(run.phase).toBe('terminal');
      expect(run.reason).toMatch(/^budget:/);

      const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip).toBeTruthy();
      expect(trip.payload.dimension).toBe('tokens');

      const rows = server.app.ctx.db.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dimension: 'tokens', configSource: 'default' });
      expect(rows[0]!.observedValue).toBeGreaterThanOrEqual(rows[0]!.limitValue);
    } finally {
      await server.close();
    }
  });

  it('trips an over-cap cost budget (priced model) to Escalation, with dimension "cost" on the guardrail_events row', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'harmonic-spend-work-'));
    // $1/Mtok input-only price: 2,000,000 input tokens -> $2 observed, over a $1 cap.
    const server = await serverWithSpendGuardrail({
      workDir,
      models: { 'stub-model': 2_000_000 },
      guardrails: { budget: { costUsd: 1 } },
      // A cost cap with no token fallback requires every harness-configured
      // model to be priced (config validation, ADR-0019) — including the
      // default config's other harnesses, whose only unpriced entry is
      // copilot's 'auto' router. Price it too so the config accepts a pure
      // cost cap; it's never actually used by this test's stub Run.
      prices: {
        'stub-model': { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
        auto: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });
    try {
      const { runId, run } = await runToEscalation(server, workDir);
      expect(run.state).toBe('failed');
      expect(run.phase).toBe('terminal');
      expect(run.reason).toMatch(/^budget:/);

      const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip).toBeTruthy();
      expect(trip.payload.dimension).toBe('cost');

      const rows = server.app.ctx.db.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dimension: 'cost', configSource: 'default' });
      // Stored in micro-dollars (integer columns): $2 observed >= $1 limit.
      expect(rows[0]!.observedValue).toBeGreaterThanOrEqual(rows[0]!.limitValue);
      expect(rows[0]!.limitValue).toBe(1_000_000);
    } finally {
      await server.close();
    }
  });

  it('falls back to enforcing the token cap when the cost cap is on an unpriced model — not a silent no-op', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'harmonic-spend-work-'));
    // 'stub-model' is left unpriced (no `prices` override): the cost cap can
    // never be measured for it, so `spendTrip` falls back to the token cap.
    const server = await serverWithSpendGuardrail({
      workDir,
      models: { 'stub-model': 10_000 }, // well over the 1,000-token fallback cap
      guardrails: { budget: { costUsd: 5, tokens: 1_000 } },
    });
    try {
      const { runId, run } = await runToEscalation(server, workDir);
      expect(run.state).toBe('failed');
      expect(run.phase).toBe('terminal');
      expect(run.reason).toMatch(/^budget:/);

      const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip).toBeTruthy();
      expect(trip.payload.dimension).toBe('tokens');

      const rows = server.app.ctx.db.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dimension: 'tokens', configSource: 'default' });
    } finally {
      await server.close();
    }
  });

  it('Escalates a configured spend cap that stays unmeasurable past the grace window', async () => {
    // No session log is ever written for this Run's session id, so the live
    // snapshot never yields token telemetry — the configured token cap can
    // never be measured, and the grace window (300ms) elapses while the
    // harness hangs, so the guard Escalates rather than silently no-op'ing.
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
      const runId = started.body.id;

      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.escalated ? body : undefined;
      });
      expect(task.escalated).toBe(true);

      const run = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(run.state).toBe('failed');
      expect(run.phase).toBe('terminal');
      expect(run.reason).toMatch(/unmeasurable/);

      const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip).toBeTruthy();
      expect(trip.payload.dimension).toBe('tokens');

      const rows = server.app.ctx.db.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all();
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
    // The progress detector sees a monologue (three consecutive assistant
    // messages, no tool progress). At the first turn boundary it delivers ONE
    // nudge through the steer channel (not a continue turn — ADR-0018); the
    // nudge turn still makes no progress, so the second boundary trips → the Run
    // Escalates through the same run_fact + coordinator + guardrail_events
    // machinery as the wall-clock Guardrail (ADR-0019, reliability-design Unit A).
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
      const runId = started.body.id;

      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.escalated ? body : undefined;
      });
      expect(task.escalated).toBe(true);

      const run = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(run.state).toBe('failed');
      expect(run.phase).toBe('terminal');
      expect(run.reason).toMatch(/^stalled:/);

      const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
      // Exactly one nudge was delivered (never spends the continue budget).
      const nudges = events.filter((e: any) => e.type === 'lifecycle' && e.payload.event === 'progress-nudge');
      expect(nudges).toHaveLength(1);
      // …delivered through the steer channel, at a turn boundary.
      expect(events.some((e: any) => e.type === 'lifecycle' && e.payload.event === 'steer_delivered')).toBe(true);
      // …and the trip is recorded on the timeline.
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip.payload.dimension).toBe('progress');

      const rows = server.app.ctx.db.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!).toMatchObject({ dimension: 'progress', configSource: 'default' });
    } finally {
      await server.close();
    }
  });

  it('does not false-trip while a tool call is outstanding (the suspend rule)', async () => {
    // The same monologue that would trip above, but the turn ends with an
    // unpaired tool_call still in flight. Idle detection SUSPENDS while a tool
    // call is outstanding (a slow build is indistinguishable from a stuck
    // agent), so the detector returns null: no nudge, no trip — the Run
    // completes normally to awaiting-review. Tool-timeout is left at its
    // generous default, so it never fires inside the test window.
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
      const runId = startedId(await server.api('POST', `/api/tasks/${taskId}/run`));

      await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');
      const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      expect(task.escalated).toBeFalsy();

      const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
      expect(events.some((e: any) => e.type === 'lifecycle' && e.payload.event === 'progress-nudge')).toBe(false);
      expect(events.some((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped')).toBe(false);
      const rows = server.app.ctx.db.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all();
      expect(rows).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('a hard tool-timeout backstops a hung tool call: emits a run_fact and Escalates', async () => {
    // A tool call opens and never completes (the turn hangs). The stall detector
    // stays suspended, but the hard tool-timeout watchdog bounds it: past the
    // generous configured limit it emits a `tool-timeout` guardrail_events row +
    // a guardrail-trip run_fact and Escalates (reliability-design Unit A).
    const server = await startServer({
      ...stubHarness(),
      guardrails: { progress: true, toolTimeoutMinutes: 0.01 }, // 600ms tool-timeout
    });
    try {
      const created = await server.api('POST', '/api/tasks', {
        prompt: scenario({
          updates: [{ sessionUpdate: 'tool_call', toolCallId: 'hang-1', title: 'Endless build', kind: 'execute', status: 'in_progress' }],
          exit: 'hang',
        }),
      });
      const taskId = created.body.id;
      const runId = startedId(await server.api('POST', `/api/tasks/${taskId}/run`));

      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.escalated ? body : undefined;
      });
      expect(task.escalated).toBe(true);

      const run = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(run.state).toBe('failed');
      expect(run.phase).toBe('terminal');
      expect(run.reason).toMatch(/tool unresponsive/);

      const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip.payload.dimension).toBe('tool-timeout');

      const rows = server.app.ctx.db.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!).toMatchObject({ dimension: 'tool-timeout', configSource: 'default' });
      expect(['executing', 'validating', 'verifying']).toContain(rows[0]!.phase);
    } finally {
      await server.close();
    }
  });
});

/** POST /run returns the created Run; assert 201 and hand back its id. */
function startedId(res: { status: number; body: { id: number } }): number {
  expect(res.status).toBe(201);
  return res.body.id;
}
