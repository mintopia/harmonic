import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { defaultConfig, verificationCommandSchema } from '../src/config.js';
import { execFileSync } from 'node:child_process';
import { openAsyncDb } from '../src/db/async.js';
import { TaskService } from '../src/domain/tasks.js';
import { AutoRunner } from '../src/execution/auto-runner.js';
import { EventBus } from '../src/server/bus.js';
import { initializeTelemetry, resolveTelemetryOptions } from '../src/telemetry.js';
import { OperationRegistry, startOperation } from '../src/telemetry/operations.js';
import { allWorkspaces, startServer, stubHarness } from './helpers.js';

const providers: NodeTracerProvider[] = [];

afterEach(async () => {
  trace.disable();
  context.disable();
  propagation.disable();
  await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
});

function installOperations(recentLimit = 100) {
  const exporter = new InMemorySpanExporter();
  const registry = new OperationRegistry(recentLimit);
  const provider = new NodeTracerProvider({ spanProcessors: [registry, new SimpleSpanProcessor(exporter)] });
  provider.register();
  providers.push(provider);
  return { exporter, registry };
}

describe('operations (issue #284)', () => {
  it('keeps a held-open operation live, emits lifecycle events, and exports its actual duration', async () => {
    const { exporter, registry } = installOperations();
    const bus = new EventBus();
    registry.setBus(bus);
    const events: string[] = [];
    bus.on('operations', ({ type }) => events.push(type));

    const operation = startOperation({ type: 'poll', attributes: { 'tracker.name': 'github' } });
    expect(registry.list()).toHaveLength(1);
    expect(exporter.getFinishedSpans()).toEqual([]);
    operation.update({ 'tracker.page': 2 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    operation.end();

    expect(registry.list()).toEqual([]);
    expect(events).toEqual(['op-started', 'op-updated', 'op-ended']);
    const span = exporter.getFinishedSpans()[0];
    if (!span) throw new Error('Expected exported operation span');
    expect(span.name).toBe('harmonic.poll');
    expect(span.attributes).toMatchObject({
      'harmonic.operation.type': 'poll',
      'tracker.name': 'github',
      'tracker.page': 2,
    });
    expect(span.duration[0] * 1_000 + span.duration[1] / 1_000_000).toBeGreaterThanOrEqual(10);
  });

  it('uses active ALS context across awaits and stored parent context across ticks', async () => {
    const { exporter } = installOperations();
    const parent = startOperation({ type: 'run', attributes: {} });
    const syncChild = await parent.run(async () => {
      await Promise.resolve();
      return startOperation({ type: 'verify', attributes: {} });
    });
    const asyncChild = startOperation({ type: 'land', attributes: {}, parent: parent.spanContext });
    syncChild.end();
    asyncChild.end();
    parent.fail('verification failed');

    const spans = exporter.getFinishedSpans();
    const parentSpan = spans.find((span) => span.name === 'harmonic.run');
    if (!parentSpan) throw new Error('Expected exported parent span');
    for (const name of ['harmonic.verify', 'harmonic.land']) {
      expect(spans.find((span) => span.name === name)?.parentSpanContext?.spanId).toBe(parentSpan.spanContext().spanId);
    }
    expect(parentSpan.status).toEqual({ code: 2, message: 'verification failed' });
    expect(context.active()).not.toBeUndefined();
  });

  it('keeps only recent completed root operations in its in-memory ring', () => {
    const { registry } = installOperations(2);
    const first = startOperation({ type: 'first', attributes: {} });
    first.end();
    const parent = startOperation({ type: 'parent', attributes: {} });
    const child = parent.run(() => startOperation({ type: 'child', attributes: {} }));
    child.end();
    parent.end();
    const last = startOperation({ type: 'last', attributes: {} });
    last.end();

    expect(registry.recentRoots().map((operation) => operation.type)).toEqual(['parent', 'last']);
    expect(registry.recentRoots().every((operation) => operation.endedAt !== undefined)).toBe(true);
  });

  it('aggregates operation counts and errors by type for periodic summaries', async () => {
    const { registry } = installOperations();
    const first = startOperation({ type: 'poll', attributes: {} });
    first.end();
    const second = startOperation({ type: 'poll', attributes: {} });
    second.fail('poll failed');
    const third = startOperation({ type: 'run', attributes: {} });
    third.end();

    const summaries: { type: string; count: number; errorCount: number }[] = [];
    await registry.flushMetricSummaries((summary) => {
      summaries.push(summary);
    });

    expect(summaries).toEqual([
      { type: 'poll', count: 2, errorCount: 1 },
      { type: 'run', count: 1, errorCount: 0 },
    ]);

    const nextPass: { type: string; count: number; errorCount: number }[] = [];
    await registry.flushMetricSummaries((summary) => {
      nextPass.push(summary);
    });
    expect(nextPass).toEqual([]);
  });

  it('registers the real telemetry provider so awaited child operations inherit the parent', async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = initializeTelemetry(resolveTelemetryOptions({ exportEnabled: 'false' }), {
      extraSpanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const parent = startOperation({ type: 'run', attributes: {} });
    const child = await parent.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return startOperation({ type: 'verify', attributes: {} });
    });
    child.end();
    parent.end();

    const spans = exporter.getFinishedSpans();
    const parentSpan = spans.find((span) => span.name === 'harmonic.run');
    const childSpan = spans.find((span) => span.name === 'harmonic.verify');
    if (!parentSpan || !childSpan) throw new Error('Expected exported parent and child spans');
    expect(childSpan.parentSpanContext?.spanId).toBe(parentSpan.spanContext().spanId);
    await telemetry.shutdown();
  });
});

describe('Auto-Runner operations (issue #289)', () => {
  it('nests a task pick and its Run under the scheduler tick', async () => {
    const { exporter, registry } = installOperations();
    const server = await startServer({
      ...stubHarness(),
      defaults: { ...defaultConfig().defaults, isolationMode: 'worktree' },
      autoRunner: { enabled: true, maxConcurrentRuns: 1 },
    });

    try {
      const task = await server.app.ctx.tasks.create({ prompt: 'trace a scheduled pick', isolationMode: 'worktree' });
      server.app.ctx.autoRunner.poke();
      await vi.waitFor(() => {
        const spans = exporter.getFinishedSpans();
        const pick = spans.find(
          (span) => span.name === 'harmonic.auto-runner.pick-start' && span.attributes['task.id'] === task.id,
        );
        const run = spans.find((span) => span.name === 'harmonic.run' && span.attributes['task.id'] === task.id);
        expect(pick).toBeDefined();
        expect(run).toBeDefined();
      });

      const spans = exporter.getFinishedSpans();
      const pick = spans.find(
        (span) => span.name === 'harmonic.auto-runner.pick-start' && span.attributes['task.id'] === task.id,
      );
      const run = spans.find((span) => span.name === 'harmonic.run' && span.attributes['task.id'] === task.id);
      if (!pick || !run) throw new Error('Expected pick/start and Run Operations for the scheduled task');
      const tick = spans.find((span) => span.spanContext().spanId === pick.parentSpanContext?.spanId);
      if (!tick) throw new Error('Expected scheduler tick Operation');
      expect(tick.name).toBe('harmonic.auto-runner.tick');
      expect(pick.parentSpanContext?.spanId).toBe(tick.spanContext().spanId);
      expect(run.parentSpanContext?.spanId).toBe(pick.spanContext().spanId);
      expect(pick.attributes).toMatchObject({ 'task.id': task.id });
      expect(registry.list().filter((operation) => operation.attributes['task.id'] === task.id)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('marks a failed task start as an error and returns the Task to ready', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'harmonic-operation-auto-runner-failure-'));
    const db = await openAsyncDb(directory);
    const { exporter, registry } = installOperations();
    const config = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentRuns: 1 } };
    const tasks = new TaskService(db, () => config, allWorkspaces(db));
    const task = await tasks.create({ prompt: 'fail a scheduled start', isolationMode: 'worktree' });
    let launchAttempts = 0;
    const autoRunner = new AutoRunner(
      tasks,
      {
        countRunning: async () => 0,
        countRunningByWorkspace: async () => new Map<number, number>(),
      },
      {
        escalateUnspawned: async () => {},
        launchClaimed: async () => {
          launchAttempts += 1;
          throw new Error('launch failed');
        },
      },
      () => config,
      allWorkspaces(db),
    );

    try {
      autoRunner.poke();
      await vi.waitFor(() => expect(launchAttempts).toBe(1));
      expect((await tasks.get(task.id)).state).toBe('ready');

      const pick = exporter.getFinishedSpans().find((span) => span.name === 'harmonic.auto-runner.pick-start');
      if (!pick) throw new Error('Expected failed pick/start Operation');
      expect(pick.status).toEqual({ code: 2, message: 'launch failed' });
      await vi.waitFor(() => expect(registry.list()).toEqual([]));
    } finally {
      autoRunner.stop();
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts no tick Operation for an idle pass that attempts no Task', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'harmonic-operation-auto-runner-idle-'));
    const db = await openAsyncDb(directory);
    const { exporter, registry } = installOperations();
    const config = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentRuns: 1 } };
    const tasks = new TaskService(db, () => config, allWorkspaces(db));
    let launchAttempts = 0;
    const autoRunner = new AutoRunner(
      tasks,
      {
        countRunning: async () => 0,
        countRunningByWorkspace: async () => new Map<number, number>(),
      },
      {
        escalateUnspawned: async () => {},
        launchClaimed: async () => {
          launchAttempts += 1;
        },
      },
      () => config,
      allWorkspaces(db),
    );

    try {
      autoRunner.poke();
      // The empty pass only awaits in-memory reads; let it settle, then assert
      // it left no heartbeat span behind — no page row, firehose, or export.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(launchAttempts).toBe(0);
      expect(exporter.getFinishedSpans().some((span) => span.name === 'harmonic.auto-runner.tick')).toBe(false);
      expect(registry.list()).toEqual([]);
    } finally {
      autoRunner.stop();
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('Run operations (issue #290)', () => {
  it('closes the Run operation at escalation and lands the operator Accept as its own operation on that Run', async () => {
    const { exporter, registry } = installOperations();
    // One attempt with a failing verifier: the ticket escalates with a real
    // verified head, so the operator Accept lands it.
    const server = await startServer({ ...stubHarness(), maxAttempts: 1 });
    try {
      const repo = mkdtempSync(join(tmpdir(), 'harmonic-ops-land-'));
      execFileSync('git', ['init', '-b', 'main', repo]);
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '--allow-empty', '-m', 'init']);
      const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
      await server.app.ctx.workspaces.update(wsId, {
        workingDir: repo,
        verificationCommand: verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 }),
      });
      const task = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ writeFiles: { 'ops.txt': 'work\n' } }),
        workingDir: repo,
        isolationMode: 'worktree',
      });
      const started = await server.api('POST', `/api/tasks/${task.body.id}/run`);
      expect(started.status).toBe(201);

      await vi.waitFor(async () => {
        expect((await server.api('GET', `/api/tasks/${task.body.id}`)).body.state).toBe('escalated');
      }, { timeout: 10_000 });
      const runId = started.body.id;
      // Escalation settles the Run: its operation closes there (the human
      // decision is not part of the Run's execution), and nothing is left live.
      await vi.waitFor(() => {
        expect(exporter.getFinishedSpans().find((span) => span.name === 'harmonic.run' && span.attributes['run.id'] === runId)).toBeDefined();
      });
      expect(registry.list().find((operation) => operation.name === 'harmonic.run' && operation.attributes['run.id'] === runId)).toBeUndefined();

      // The operator Accept lands as its own operation, keyed to the same Run.
      expect((await server.api('POST', `/api/tasks/${task.body.id}/accept`)).status).toBe(200);
      await vi.waitFor(() => {
        const land = exporter.getFinishedSpans().find((span) => span.name === 'harmonic.land' && span.attributes['run.id'] === runId);
        expect(land).toBeDefined();
        expect(land?.attributes['landing.mechanism']).toBe('coordinator');
      });
    } finally {
      await server.close();
    }
  });
});
