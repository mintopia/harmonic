import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor, cancelRunningTasks, type TestServer } from './helpers.js';
import { guardrailEvents, runs, runToolCalls } from '../src/db/schema.js';
import type { DeepPartial, AppConfig } from '../src/config.js';
import { AttemptStore } from '../src/domain/attempts.js';

const scenario = (s: object) => JSON.stringify(s);

describe('run execution over ACP (direct mode)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    // Cancel any hung Run this describe leaves behind so it doesn't linger into
    // later tests in the same file (leaked harness process, consumed run slot).
    await cancelRunningTasks(server);
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
    const { taskId, runId } = await createAndRun({ updates, stopReason: 'end_turn' });

    // Task passes through working to done — no human gate (ADR-0041).
    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ taskId, attempt: 1, state: 'completed', phase: 'terminal', stopReason: 'end_turn' });
    expect(run.body.finishedAt).toBeGreaterThan(0);
    // Agent-finish took it executing → verifying → merging, never jumping
    // straight to a terminal phase (`validating` retired by the reshape).
    const phaseEvents = (await server.api('GET', `/api/runs/${runId}/events`)).body.events
      .filter((e: any) => e.type === 'lifecycle' && e.payload.event === 'phase')
      .map((e: any) => e.payload.phase);
    expect(phaseEvents).toEqual(['verifying', 'merging']);

    const events = await server.api('GET', `/api/runs/${runId}/events`);
    expect(events.status).toBe(200);
    expect(events.body.events.filter((e: any) => e.type === 'session_update')).toEqual([]);
    const toolCalls = await server.app.ctx.asyncDb.read((db) =>
      db.select().from(runToolCalls).where(eq(runToolCalls.runId, runId)).all(),
    );
    expect(toolCalls).toEqual([{ runId, toolName: 'Write file', count: 1 }]);
    // seq is a stable per-run ordering
    expect(events.body.events.map((e: any) => e.seq)).toEqual(
      [...events.body.events.map((e: any) => e.seq)].sort((a: number, b: number) => a - b),
    );
  });

  it('a native Run resolves and uses the Workspace Task Prompt override, else inherits the global default (ADR-0044/#339)', async () => {
    const wsId = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id;
    const promptOf = async (runId: number) =>
      (await server.app.ctx.asyncDb.read((d) => d.select().from(runs).where(eq(runs.id, runId)).get()))!.prompt;
    const settle = async (taskId: number) =>
      waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done' ? true : undefined), {
        timeoutMs: 20_000,
      });
    const scenarioObj = { updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }], stopReason: 'end_turn' };

    // Baseline: no override → the native Run inherits the global Task Prompt
    // (`{prompt}`), so the text it sends is the Task's own prompt verbatim.
    const inherit = await createAndRun(scenarioObj);
    await settle(inherit.taskId);
    const inheritPrompt = await promptOf(inherit.runId);

    // Override: the Workspace pins its own Task Prompt template. The next native
    // Run must resolve `workspace ?? global` and actually send the overridden
    // framing — the wiring the critic flagged as missing. `finally` resets the
    // shared server's override so a failure can never leak it to later tests.
    let overridePrompt: string | null;
    try {
      expect((await server.api('PATCH', `/api/workspaces/${wsId}`, { taskPrompt: 'WS-TASKPROMPT::{prompt}' })).status).toBe(200);
      const override = await createAndRun(scenarioObj);
      await settle(override.taskId);
      overridePrompt = await promptOf(override.runId);
    } finally {
      await server.api('PATCH', `/api/workspaces/${wsId}`, { taskPrompt: null });
    }

    expect(inheritPrompt).not.toBeNull();
    expect(overridePrompt).not.toBeNull();
    expect(inheritPrompt!.startsWith(scenario(scenarioObj))).toBe(true); // global `{prompt}` → verbatim
    expect(overridePrompt!.startsWith('WS-TASKPROMPT::')).toBe(true); // the override reached the harness prompt
  });

  it('a native Run merges terminal exactly once — done is final and the escalation actions refuse (ADR-0041)', async () => {
    const { taskId, runId } = await createAndRun({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }],
      stopReason: 'end_turn',
    });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');

    const merged = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(merged.state).toBe('completed');
    expect(merged.phase).toBe('terminal');
    expect(merged.finishedAt).toBeGreaterThan(0);

    // The full phase path is reconstructable from the persisted event log:
    // executing → verifying → merging (the drive loop merges itself; `validating`
    // retired by the reshape). `terminal` is the coordinator's row write, not a
    // drive-loop phase event.
    const phases = (await server.api('GET', `/api/runs/${runId}/events`)).body.events
      .filter((e: any) => e.type === 'lifecycle' && e.payload.event === 'phase')
      .map((e: any) => e.payload.phase);
    expect(phases).toEqual(['verifying', 'merging']);
    // Done is terminal: the human surface does not apply, and nothing re-merges.
    expect((await server.api('POST', `/api/tasks/${taskId}/accept`)).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${taskId}/reject`, { guidance: 'nope' })).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${taskId}/close`)).status).toBe(409);
    expect((await server.api('GET', `/api/runs/${runId}`)).body).toMatchObject({ state: 'completed', phase: 'terminal' });
  });

  it('cancelling a working Task settles its running Run cancelled (issue #114)', async () => {
    const { taskId, runId } = await createAndRun({ exit: 'hang' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'working');
    await waitFor(async () => ((await server.api('GET', `/api/runs/${runId}`)).body.sessionId ? true : undefined));
    expect((await server.api('GET', `/api/runs/${runId}`)).body.state).toBe('running');

    const cancelled = await server.api('POST', `/api/tasks/${taskId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');
    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.state).toBe('cancelled');
    expect(run.phase).toBe('terminal');
  });

  it('records each resumed loop as a distinct run and history survives a Reject with guidance', async () => {
    const { taskId, runId } = await createAndRun({ exit: 'crash-before-response' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'escalated');
    const firstAttempts = (await server.api('GET', `/api/runs/${runId}`)).body.attempt;

    const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, { guidance: 'try again', start: true });
    expect(rejected.status).toBe(200);

    const second = await waitFor(async () => {
      const runs = (await server.api('GET', `/api/tasks/${taskId}/runs`)).body.runs;
      return runs.length === 2 ? runs[1] : undefined;
    });
    expect(second.id).not.toBe(runId);
    expect(second.attempt).toBe(firstAttempts + 1); // history numbering continues across the reset budget

    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'escalated');
    const runs = await server.api('GET', `/api/tasks/${taskId}/runs`);
    expect(runs.body.runs).toHaveLength(2);
  });

  it('escalates the task when the harness crashes on every attempt', async () => {
    const { taskId, runId } = await createAndRun({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'about to die' } }],
      exit: 'crash-before-response',
    });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'escalated');
    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.body.state).toBe('failed');
    expect(run.body.reason).toBeTruthy();
    expect((await server.api('GET', `/api/tasks/${taskId}`)).body.escalationReason).toMatch(/^escalated to human: attempt \d+ of \d+ failed/);
  });

  it('cancelling a running task kills the harness process and the run', async () => {
    const { taskId, runId } = await createAndRun({ exit: 'hang' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'working');

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
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'working');

    const completed = await server.api('POST', `/api/tasks/${taskId}/complete`);
    expect(completed.status).toBe(200);
    expect(completed.body.state).toBe('done');

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
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');

    const events = await server.api('GET', `/api/runs/${runId}/events`);
    const types = events.body.events.map((e: any) => e.type);
    expect(types).toContain('permission_request');
    const permission = events.body.events.find((e: any) => e.type === 'permission_request');
    expect(permission.payload.outcome).toMatchObject({ outcome: 'selected' });
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
      await waitFor(async () => (await codexServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated');

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
      await waitFor(async () => (await codexServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated');

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
          async () => (await codexServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done',
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
      const events = await srv.api('GET', `/api/runs/${started.body.id}/events`);
      return events.body.events.find((e: any) => e.type === 'session_update') ?? null;
    };
    try {
      expect(await setModelEcho(copilotServer, 'copilot', 'claude-haiku-4.5')).toBeNull();
      expect(await setModelEcho(copilotServer, 'copilot', 'auto')).toBeNull();
      // Session-update echoes are intentionally not persisted for any harness.
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
        async () => (await copilotServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated',
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

describe('direct Work Context occupancy (ADR-0001, ADR-0046)', () => {
  let server: TestServer;
  const workingDirA = mkdtempSync(join(tmpdir(), 'harmonic-context-a-'));
  const workingDirC = mkdtempSync(join(tmpdir(), 'harmonic-context-c-'));

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    // Cancel any hung Run this describe leaves behind so it doesn't linger into
    // later tests in the same file (leaked harness process, consumed run slot).
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

    // Task B collides on the exact same workingDir (direct-mode keys ignore
    // branch, so the two are contending for the same physical occupancy). The
    // scheduler's pick predicate (Auto-Runner's `occupiedDirectContexts`) is the
    // only enforcement (ADR-0001), and it does not gate a hand-started run
    // (REST `/run`, bypassing pickNext): direct isolation does not block the
    // second worker (ADR-0046), the attach is the operator's accepted risk.
    const createdB = await server.api('POST', '/api/tasks', {
      prompt: scenario({ exit: 'hang' }),
      workingDir: workingDirA,
    });
    expect(createdB.status).toBe(201);
    const taskBId = createdB.body.id;
    const startedB = await server.api('POST', `/api/tasks/${taskBId}/run`);
    expect(startedB.status).toBe(201);

    // B's Run row is created and it proceeds — not rolled back, not left ready.
    const runsB = await server.api('GET', `/api/tasks/${taskBId}/runs`);
    expect(runsB.body.runs).toHaveLength(1);
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
    // Left running; the harness process dies with the server on afterAll.
  });
});

describe('crash recovery', () => {
  it('marks in-flight runs failed with reason "interrupted" on restart and re-queues their tickets, never re-running them blind', async () => {
    const server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: scenario({ exit: 'hang' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'working');

    // Simulate a workspace reboot: close the app but keep the data dir.
    await server.app.close();
    const reopened = await startServer(stubHarness(), { dataDir: server.dataDir });

    // An interruption is not a failed Attempt: the ticket is back in the queue.
    const task = await reopened.api('GET', `/api/tasks/${created.body.id}`);
    expect(task.body.state).toBe('ready');
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
        return body.state === 'escalated' ? body : undefined;
      });
      expect(task.state).toBe('escalated');

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
      const rows = await server.app.ctx.asyncDb.read((d) =>
        d.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all(),
      );
      expect(rows).toHaveLength(1);
      const event = rows[0]!;
      expect(event).toMatchObject({ dimension: 'wall-clock', configSource: 'default' });
      expect(['executing', 'validating', 'verifying']).toContain(event.phase);
      expect(event.observedValue).toBeGreaterThanOrEqual(event.limitValue);
    } finally {
      await server.close();
    }
  });

  it('does not kill an over-budget run after its attempt tasks enter merging', async () => {
    const server = await startServer({
      ...stubHarness(),
      // 600ms budget: enough headroom for the stub spawn + attempt waitFors
      // below, small enough that the 800ms sleep proves the timer fired.
      guardrails: { budget: { wallClockMinutes: 0.01 } },
    });
    try {
      const created = await server.api('POST', '/api/tasks', { prompt: scenario({ exit: 'hang' }) });
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      const attempts = new AttemptStore(server.app.ctx.asyncDb);
      const attempt = await waitFor(async () => (await attempts.listForTask(created.body.id))[0]);
      const implementation = await waitFor(async () => (await attempts.listSteps(attempt.id))[0]);

      await attempts.updateStep(implementation.id, { state: 'passed', verdict: 'pass', endedAt: Date.now() });
      await attempts.finish(attempt.id, 'passed');
      // Past the 600ms wall-clock budget (the guardrail arms an exact timer for
      // the remaining budget, so a ~200ms margin suffices).
      await new Promise((resolve) => setTimeout(resolve, 800));

      expect((await server.api('GET', `/api/runs/${started.body.id}`)).body.state).toBe('running');
      expect(
        await server.app.ctx.asyncDb.read((db) =>
          db.select().from(guardrailEvents).where(eq(guardrailEvents.runId, started.body.id)).all(),
        ),
      ).toEqual([]);
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
      return body.state === 'escalated' ? body : undefined;
    });
    expect(task.state).toBe('escalated');

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

      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all());
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

      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all());
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

      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all());
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
        return body.state === 'escalated' ? body : undefined;
      });
      expect(task.state).toBe('escalated');

      const run = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(run.state).toBe('failed');
      expect(run.phase).toBe('terminal');
      expect(run.reason).toMatch(/unmeasurable/);

      const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip).toBeTruthy();
      expect(trip.payload.dimension).toBe('tokens');

      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all());
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
        return body.state === 'escalated' ? body : undefined;
      });
      expect(task.state).toBe('escalated');

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

      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all());
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
    // completes normally to done. Tool-timeout is left at its
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

      await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');
      const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      expect(task.state).toBe('done');

      const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
      expect(events.some((e: any) => e.type === 'lifecycle' && e.payload.event === 'progress-nudge')).toBe(false);
      expect(events.some((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped')).toBe(false);
      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all());
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
        return body.state === 'escalated' ? body : undefined;
      });
      expect(task.state).toBe('escalated');

      const run = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(run.state).toBe('failed');
      expect(run.phase).toBe('terminal');
      expect(run.reason).toMatch(/tool unresponsive/);

      const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
      const trip = events.find((e: any) => e.type === 'lifecycle' && e.payload.event === 'guardrail-tripped');
      expect(trip.payload.dimension).toBe('tool-timeout');

      const rows = await server.app.ctx.asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.runId, runId)).all());
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
