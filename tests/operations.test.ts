import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { defaultConfig } from '../src/config.js';
import { openAsyncDb } from '../src/db/async.js';
import { TaskService } from '../src/domain/tasks.js';
import { AutoRunner } from '../src/execution/auto-runner.js';
import { EventBus } from '../src/server/bus.js';
import { initializeTelemetry, resolveTelemetryOptions } from '../src/telemetry.js';
import { OperationRegistry, startOperation } from '../src/telemetry/operations.js';
import { allWorkspaces } from './helpers.js';

const providers: NodeTracerProvider[] = [];

afterEach(async () => {
  trace.disable();
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
    const directory = mkdtempSync(join(tmpdir(), 'harmonic-operation-auto-runner-'));
    const db = await openAsyncDb(directory);
    const { exporter, registry } = installOperations();
    const config = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentRuns: 1 } };
    const tasks = new TaskService(db, () => config, allWorkspaces(db));
    const task = await tasks.create({ prompt: 'trace a scheduled pick', isolationMode: 'worktree' });
    const started: number[] = [];
    const autoRunner = new AutoRunner(
      tasks,
      {
        countRunning: async () => 0,
        countRunningByWorkspace: async () => new Map<number, number>(),
      },
      {
        launchClaimed: async (taskId) => {
          started.push(taskId);
          const run = startOperation({ type: 'run', attributes: { 'task.id': taskId } });
          run.end();
        },
      },
      () => config,
      allWorkspaces(db),
    );

    try {
      autoRunner.poke();
      await vi.waitFor(() => expect(started).toEqual([task.id]));

      const spans = exporter.getFinishedSpans();
      const tick = spans.find((span) => span.name === 'harmonic.auto-runner.tick');
      const pick = spans.find((span) => span.name === 'harmonic.auto-runner.pick-start');
      const run = spans.find((span) => span.name === 'harmonic.run');
      if (!tick || !pick || !run) throw new Error('Expected scheduler tick, pick/start, and Run Operations');
      expect(pick.parentSpanContext?.spanId).toBe(tick.spanContext().spanId);
      expect(run.parentSpanContext?.spanId).toBe(pick.spanContext().spanId);
      expect(pick.attributes).toMatchObject({ 'task.id': task.id });
      expect(registry.list()).toEqual([]);
    } finally {
      autoRunner.stop();
      await db.close();
      rmSync(directory, { recursive: true, force: true });
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
      expect(registry.list()).toEqual([]);
    } finally {
      autoRunner.stop();
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
