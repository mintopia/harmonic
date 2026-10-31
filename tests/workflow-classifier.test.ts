import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { TaskEventStore } from '../src/domain/task-events.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { Runner } from '../src/execution/runner.js';
import { RouteClassifier, type ClassifierBackend } from '../src/domain/route-classifier.js';
import { resolveWorkflow } from '../src/domain/workflow-assignment.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { executionPlumbing, allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

const answer = (optionId: string, reason = 'fits') => ({ output: { optionId, reason } });

describe('resolveWorkflow classifier tier', () => {
  const cfg = { ...baselineConfig(), workflowLabels: [{ label: 'bug', workflow: 'fix' }], defaults: { ...baselineConfig().defaults, workflow: 'global-wf' } };
  const workspace = { workflow: 'workspace-wf', workflowLabels: null };
  const classified = { name: 'picked', reason: 'looks like docs' };

  it('beats the Workspace default and the global default', () => {
    expect(resolveWorkflow({ requested: null, trackerLabels: null, workspace, config: cfg, classified })).toEqual({ name: 'picked', chosen: 'classifier', reason: 'looks like docs' });
  });
  it('loses to an operator choice and to a Workflow Label', () => {
    expect(resolveWorkflow({ requested: 'mine', trackerLabels: ['bug'], workspace, config: cfg, classified }).chosen).toBe('explicit');
    expect(resolveWorkflow({ requested: null, trackerLabels: ['bug'], workspace, config: cfg, classified }).chosen).toBe('label');
  });
  it('falls to the Workspace default when the pick is not in the library', () => {
    expect(resolveWorkflow({ requested: null, trackerLabels: null, workspace, config: cfg, classified, exists: (n) => n !== 'picked' })).toEqual({ name: 'workspace-wf', chosen: 'workspace' });
  });
  it('falls to the Workspace default when it abstained', () => {
    expect(resolveWorkflow({ requested: null, trackerLabels: null, workspace, config: cfg, classified: null })).toEqual({ name: 'workspace-wf', chosen: 'workspace' });
  });
});

describe('workflow classifier on a Ticket', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let config: AppConfig;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let runner: Runner;
  let taskEvents: TaskEventStore;
  let wsId: number;
  let backend: ClassifierBackend & { classify: ReturnType<typeof vi.fn> };

  afterEach(async () => {
    await runner.shutdown();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-workflow-classifier-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    settingsStore = await makeSettingsStore(dir);
    config = baselineConfig();
    tasks = new TaskService(asyncDb, () => config, allWorkspaces(asyncDb, settingsStore));
    taskEvents = new TaskEventStore(asyncDb);
    backend = { classify: vi.fn(async () => answer('research', 'needs investigation')) };
    wsId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
    runner = new Runner(tasks, asyncDb, () => config, {
      ...executionPlumbing(),
      taskEvents,
      routeClassifier: new RouteClassifier(() => config, { harness: backend }),
    });
    (runner as unknown as { turnDriver: { drive: () => Promise<void> } }).turnDriver.drive = async () => {};
    await new WorkspaceService(asyncDb, settingsStore).update(wsId, { workflowClassifierEnabled: true, classifierBackend: 'harness' } as never);
  });

  const ready = async (extra: Record<string, unknown> = {}) => {
    const created = await tasks.create({ prompt: 'investigate the flaky build', workspaceId: wsId, ...extra } as never);
    await tasks.setState(created.id, 'ready');
    return (await tasks.claimReady(created.id))!;
  };
  const assign = (task: Awaited<ReturnType<typeof ready>>) => (runner as unknown as { workflowTaskFor: (t: typeof task) => Promise<typeof task> }).workflowTaskFor(task);
  const retry = (task: Awaited<ReturnType<typeof ready>>) => (runner as unknown as { repinWorkflow: (t: typeof task) => Promise<void> }).repinWorkflow(task);
  const activity = async (taskId: number) => (await taskEvents.listEvents(taskId)).map((e) => e.payload as Record<string, unknown>);

  it('chooses the workflow, keeps the reason and records Activity', async () => {
    const pinned = await assign(await ready());
    expect(pinned).toMatchObject({ workflowRef: 'research@1', workflowChosen: 'classifier', workflowReason: 'needs investigation' });
    const input = backend.classify.mock.calls[0]![0] as { options: Array<{ id: string }> };
    expect(input.options.map((o) => o.id)).toEqual(expect.arrayContaining(['implement', 'research']));
    expect(await activity(pinned.id)).toContainEqual(expect.objectContaining({ event: 'workflow-classified', workflow: 'research' }));
  });

  it('records the classifier usage as a routing cost line on the Ticket', async () => {
    backend.classify.mockResolvedValue({
      ...answer('research'),
      costUsd: 0.002,
      model: 'm',
      usage: { models: { m: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }, totals: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7 }, toolCalls: {}, source: 'acp' },
    });
    const pinned = await assign(await ready());
    expect(JSON.parse(pinned.workflowRoutingCost!)).toMatchObject({ totalUsd: 0.002 });
  });

  it('adds a Retry call to the routing spend instead of replacing it', async () => {
    const usage = { models: { m: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }, totals: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7 }, toolCalls: {}, source: 'acp' };
    backend.classify.mockResolvedValue({ ...answer('research'), costUsd: 0.002, model: 'm', usage });
    const pinned = await assign(await ready());
    await retry(pinned);
    expect(JSON.parse((await tasks.get(pinned.id)).workflowRoutingCost!)).toMatchObject({ totalUsd: 0.004 });
  });

  it('does not run for an operator choice', async () => {
    const pinned = await assign(await ready({ workflow: 'implement' }));
    expect(backend.classify).not.toHaveBeenCalled();
    expect(pinned).toMatchObject({ workflowRef: 'implement@1', workflowChosen: 'explicit', workflowReason: null });
  });

  it('does not run when the Workspace has it off', async () => {
    await new WorkspaceService(asyncDb, settingsStore).update(wsId, { workflowClassifierEnabled: false } as never);
    const pinned = await assign(await ready());
    expect(backend.classify).not.toHaveBeenCalled();
    expect(pinned.workflowChosen).not.toBe('classifier');
  });

  it.each([
    ['an unknown workflow id', async () => answer('no-such-workflow')],
    ['an error', async () => { throw new Error('endpoint down'); }],
    ['invalid output', async () => ({ output: { nonsense: true } })],
  ])('abstains to the default on %s, and Activity records why', async (_name, impl) => {
    backend.classify.mockImplementation(impl);
    const pinned = await assign(await ready());
    expect(pinned).toMatchObject({ workflowRef: 'implement@1', workflowChosen: 'global' });
    expect(pinned.workflowReason).toBeTruthy();
    expect(await activity(pinned.id)).toContainEqual(expect.objectContaining({ event: 'workflow-classifier-abstained' }));
  });

  it('keeps an in-flight Ticket on its workflow, and lets Retry pick a different one', async () => {
    const pinned = await assign(await ready());
    expect(pinned.workflowRef).toBe('research@1');
    backend.classify.mockResolvedValue(answer('implement', 'now it needs code'));

    expect((await assign(pinned)).workflowRef).toBe('research@1');
    expect(backend.classify).toHaveBeenCalledTimes(1);

    await retry(pinned);
    expect(await tasks.get(pinned.id)).toMatchObject({ workflowRef: 'implement@1', workflowChosen: 'classifier', workflowReason: 'now it needs code' });
    expect(backend.classify).toHaveBeenCalledTimes(2);
  });
});
