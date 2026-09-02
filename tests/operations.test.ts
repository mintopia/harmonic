import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { baselineConfig, verificationCommandSchema } from '../src/config.js';
import { execFileSync } from 'node:child_process';
import { openAsyncDb } from '../src/db/async.js';
import { TaskService } from '../src/domain/tasks.js';
import { AutoRunner } from '../src/execution/auto-runner.js';
import { EventBus } from '../src/server/bus.js';
import { initializeTelemetry, resolveTelemetryOptions } from '../src/telemetry.js';
import { OperationRegistry, startOperation } from '../src/telemetry/operations.js';
import { allWorkspaces, makeSettingsStore, seedLocalMarkdownTicket, startServer, stubHarness } from './helpers.js';

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
    const parent = startOperation({ type: 'attempt', attributes: {} });
    const syncChild = await parent.run(async () => {
      await Promise.resolve();
      return startOperation({ type: 'verify', attributes: {} });
    });
    const asyncChild = startOperation({ type: 'merge', attributes: {}, parent: parent.spanContext });
    syncChild.end();
    asyncChild.end();
    parent.fail('verification failed');

    const spans = exporter.getFinishedSpans();
    const parentSpan = spans.find((span) => span.name === 'harmonic.attempt');
    if (!parentSpan) throw new Error('Expected exported parent span');
    for (const name of ['harmonic.verify', 'harmonic.merge']) {
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
    const third = startOperation({ type: 'attempt', attributes: {} });
    third.end();

    const summaries: { type: string; count: number; errorCount: number }[] = [];
    await registry.flushMetricSummaries((summary) => {
      summaries.push(summary);
    });

    expect(summaries).toEqual([
      { type: 'poll', count: 2, errorCount: 1 },
      { type: 'attempt', count: 1, errorCount: 0 },
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
    const parent = startOperation({ type: 'attempt', attributes: {} });
    const child = await parent.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return startOperation({ type: 'verify', attributes: {} });
    });
    child.end();
    parent.end();

    const spans = exporter.getFinishedSpans();
    const parentSpan = spans.find((span) => span.name === 'harmonic.attempt');
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
      defaults: { ...baselineConfig().defaults, isolationMode: 'worktree' },
      autoRunner: { enabled: true, maxConcurrentAttempts: 1 },
    });

    try {
      const task = await server.app.ctx.tasks.create({ prompt: 'trace a scheduled pick', isolationMode: 'worktree' });
      server.app.ctx.autoRunner.poke();
      await vi.waitFor(() => {
        const spans = exporter.getFinishedSpans();
        const pick = spans.find(
          (span) => span.name === 'harmonic.auto-runner.pick-start' && span.attributes['task.id'] === task.id,
        );
        const run = spans.find((span) => span.name === 'harmonic.attempt' && span.attributes['task.id'] === task.id);
        expect(pick).toBeDefined();
        expect(run).toBeDefined();
      });

      const spans = exporter.getFinishedSpans();
      const pick = spans.find(
        (span) => span.name === 'harmonic.auto-runner.pick-start' && span.attributes['task.id'] === task.id,
      );
      const run = spans.find((span) => span.name === 'harmonic.attempt' && span.attributes['task.id'] === task.id);
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
    const settingsStore = await makeSettingsStore(directory);
    const { exporter, registry } = installOperations();
    const config = { ...baselineConfig(), autoRunner: { enabled: true, maxConcurrentAttempts: 1 } };
    const tasks = new TaskService(db, () => config, allWorkspaces(db, settingsStore));
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
      allWorkspaces(db, settingsStore),
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
    const settingsStore = await makeSettingsStore(directory);
    const { exporter, registry } = installOperations();
    const config = { ...baselineConfig(), autoRunner: { enabled: true, maxConcurrentAttempts: 1 } };
    const tasks = new TaskService(db, () => config, allWorkspaces(db, settingsStore));
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
      allWorkspaces(db, settingsStore),
    );

    try {
      autoRunner.poke();
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
  it('closes the Run operation at escalation and merges the operator Accept as its own operation on that Run', async () => {
    const { exporter, registry } = installOperations();
    const server = await startServer({ ...stubHarness(), maxAttempts: 1 });
    try {
      const repo = mkdtempSync(join(tmpdir(), 'harmonic-ops-merge-'));
      execFileSync('git', ['init', '-b', 'main', repo]);
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '--allow-empty', '-m', 'init']);
      const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
      await server.app.ctx.workspaces.update(wsId, {
        workingDir: repo,
        verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 })],
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
      const attemptId = started.body.id;
      await vi.waitFor(() => {
        expect(exporter.getFinishedSpans().find((span) => span.name === 'harmonic.attempt' && span.attributes['attempt.id'] === attemptId)).toBeDefined();
      });
      expect(registry.list().find((operation) => operation.name === 'harmonic.attempt' && operation.attributes['attempt.id'] === attemptId)).toBeUndefined();

      await server.app.ctx.workspaces.update(wsId, {
        verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 })],
      });

      const escalatedAttempt = await server.app.ctx.attempts.currentForTask(task.body.id);
      expect((await server.api('POST', `/api/tasks/${task.body.id}/accept`)).status).toBe(200);
      await vi.waitFor(() => {
        const merge = exporter.getFinishedSpans().find((span) => span.name === 'harmonic.merge' && span.attributes['attempt.id'] === escalatedAttempt.id);
        expect(merge).toBeDefined();
        expect(merge?.attributes['merge.mechanism']).toBe('policy');
      });
    } finally {
      await server.close();
    }
  });
});

describe('Automated merge policy operations (issue #387)', () => {
  it('nests the harmonic.merge span tree under the real Attempt operation when a worktree task auto-merges', async () => {
    const { exporter } = installOperations();
    const repo = mkdtempSync(join(tmpdir(), 'harmonic-ops-merge-policy-'));
    execFileSync('git', ['init', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    mkdirSync(join(repo, 'docs', 'agents'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: local-markdown\n\nPath: tickets\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'init']);

    const server = await startServer({
      ...stubHarness(),
      defaults: { isolationMode: 'worktree' },
      maxAttempts: 2,
      drive: { continueAttempts: 0, mergeFate: 'auto-merge' },
    });
    try {
      const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
      await server.app.ctx.workspaces.update(wsId, {
        workingDir: repo,
        verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 })],
      });
      await server.app.ctx.settingsStore.updateGlobal({
        merge: { postMergeCheck: false },
        drive: { prompt: JSON.stringify({ writeFiles: { 'impl.txt': 'implementation\n' }, mcpFinish: true }) },
      });

      const trackerRef = 999_001;
      const task = await server.app.ctx.tasks.upsertMirrored({
        trackerRef,
        prompt: `ticket ${trackerRef}\n\nbody`,
        workflow: 'implement',
        wayfinderType: null,
        mapRef: null,
        closed: false,
      });
      seedLocalMarkdownTicket(task.workingDir, trackerRef, 'closed');
      execFileSync('git', ['-C', task.workingDir, 'add', '-A']);
      execFileSync('git', ['-C', task.workingDir, 'commit', '-q', '-m', `ticket ${trackerRef}`]);

      await server.app.ctx.tasks.setState(task.id, 'working');
      const run = await server.app.ctx.runner.launchClaimed(task.id);

      await vi.waitFor(
        async () => {
          const t = await server.app.ctx.tasks.get(task.id);
          if (t.state === 'escalated') throw new Error(`escalated instead of merging: ${(await server.app.ctx.attempts.get(run.id)).reason}`);
          expect(t.state).toBe('done');
        },
        { timeout: 20_000 },
      );

      const spans = exporter.getFinishedSpans();
      const attempt = spans.find((span) => span.name === 'harmonic.attempt' && span.attributes['attempt.id'] === run.id);
      const merge = spans.find((span) => span.name === 'harmonic.merge' && span.attributes['merge.mechanism'] === 'policy');
      if (!attempt || !merge) {
        throw new Error(`missing span(s); exported spans: ${JSON.stringify(spans.map((s) => s.name))}`);
      }
      expect(merge.attributes['merge.mechanism']).toBe('policy');
      expect(merge.parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
    } finally {
      await server.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
