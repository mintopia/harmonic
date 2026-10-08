import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { Runner } from '../src/execution/runner.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import { trackerRef, type Ticket } from '../src/tracker/adapter.js';
import { executionPlumbing, allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

const ticket = (ref: number, labels: string[]): Ticket => ({
  ref: trackerRef(ref),
  title: `Ticket ${ref}`,
  state: 'open',
  body: '',
  createdAt: '2026-08-07T00:00:00Z',
  closedAt: null,
  labels,
  assignees: [],
  parent: null,
  blockedBy: [],
  blocking: [],
  isMap: false,
  url: `https://github.com/mintopia/harmonic/issues/${ref}`,
});

describe('unavailable Harness at Attempt start (#822)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let config: AppConfig;
  let tasks: TaskService;
  let runs: AttemptStore;
  let runner: Runner;
  let wsId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-unavailable-harness-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    const settingsStore = await makeSettingsStore(dir);
    config = { ...baselineConfig(), routingLabels: [{ label: 'bulk', harness: 'codex', model: '' }] };
    tasks = new TaskService(asyncDb, () => config, allWorkspaces(asyncDb, settingsStore));
    wsId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
    runs = new AttemptStore(asyncDb);
    runner = new Runner(tasks, asyncDb, () => config, executionPlumbing());
  });

  afterEach(async () => {
    await runner.shutdown();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('escalates naming the Routing Label and Harness after the Harness is removed, then runs again once a Harness is set', async () => {
    const [mirrored] = await mirrorScan(tasks, [ticket(1, ['ready-for-agent', 'bulk'])], wsId);
    delete (config.harnesses as Record<string, unknown>).codex;

    await tasks.claimReady(mirrored!.id);
    await runner.launchClaimed(mirrored!.id);

    const escalated = await tasks.get(mirrored!.id);
    expect(escalated.state).toBe('escalated');
    expect(escalated.harness).toBe('codex');
    expect(escalated.escalationReason).toContain("Routing Label 'bulk' needs Harness 'codex', which is not configured.");
    const attempts = await runs.listForTask(mirrored!.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe('escalated');

    const updated = await tasks.update(mirrored!.id, { harness: 'claude' });
    expect(updated.harness).toBe('claude');
    await expect(tasks.update(mirrored!.id, { prompt: 'rewrite' })).rejects.toThrow(/only draft, ready/);
    await tasks.requeue(mirrored!.id);
    const retried = await tasks.claimReady(mirrored!.id);
    expect(retried).toMatchObject({ state: 'working', harness: 'claude' });
  });
});
