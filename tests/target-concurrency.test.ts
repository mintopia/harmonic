import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AutoRunner } from '../src/execution/auto-runner.js';
import { TargetGate } from '../src/execution/target-gate.js';
import type { AttemptStore } from '../src/domain/attempts.js';
import type { Runner } from '../src/execution/runner.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace, startServer } from './helpers.js';

interface Definition {
  name: string;
  enabled: boolean;
  concurrencyLimit: number;
}
const view = (name: string, over: Partial<Definition> = {}): Definition => ({ name, enabled: true, concurrencyLimit: 1, ...over });

describe('per-target concurrency in the Auto-Runner', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let targets: Definition[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-tc-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    targets = [view('k8s-prod')];
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const build = (ceiling = 1) => {
    const started: number[] = [];
    const runner = { escalateUnspawned: async () => {}, launchClaimed: (id: number) => started.push(id) } as unknown as Runner;
    let workingAttempts = 0;
    const runStore = {
      countRunning: async () => workingAttempts,
      countRunningByWorkspace: async () => new Map<number, number>(),
    } as unknown as AttemptStore;
    const config: AppConfig = { ...baselineConfig(), autoRunner: { enabled: true, maxConcurrentAttempts: ceiling } };
    const targetGate = new TargetGate({
      targets: { definitions: async () => targets },
      targetOf: async (task) => (task.prompt.startsWith('k8s:') ? 'k8s-prod' : undefined),
    });
    const ar = new AutoRunner(tasks, runStore, runner, () => config, allWorkspaces(asyncDb, settingsStore), { targetGate });
    return { ar, started, setWorking: (n: number) => (workingAttempts = n) };
  };
  const ticket = (prompt: string) => tasks.create({ prompt, workingDir: mkdtempSync(join(tmpdir(), 'harmonic-tc-ws-')), state: 'ready' });

  it('holds the second Ticket with the reason, then starts it when the first finishes', async () => {
    const first = await ticket('k8s: one');
    const second = await ticket('k8s: two');
    const { ar, started } = build();
    ar.poke();
    await vi.waitFor(() => expect(started).toEqual([first.id]));
    await vi.waitFor(() => expect(ar.skipReasonFor(second.id)).toBe('waiting for k8s-prod'));
    expect((await tasks.get(second.id)).state).toBe('ready');
    expect(ar.targetWaitFor(second.id)).toEqual({ target: 'k8s-prod', disabled: false, running: 1, limit: 1, position: 1 });

    await tasks.setState(first.id, 'done');
    ar.poke();
    await vi.waitFor(() => expect(started).toEqual([first.id, second.id]));
    expect(ar.skipReasonFor(second.id)).toBeUndefined();
  });

  it('keeps starting local Tickets while the target is full, and k8s Tickets do not use the Host Ceiling', async () => {
    const first = await ticket('k8s: one');
    const second = await ticket('k8s: two');
    const local = await ticket('local work');
    const { ar, started } = build(1);
    ar.poke();
    await vi.waitFor(() => expect(started).toEqual([first.id, local.id]));
    expect(ar.skipReasonFor(second.id)).toBe('waiting for k8s-prod');
  });

  it('holds a disabled target\'s Tickets and starts them once it is re-enabled', async () => {
    targets = [view('k8s-prod', { enabled: false })];
    const held = await ticket('k8s: held');
    const { ar, started } = build();
    ar.poke();
    await vi.waitFor(() => expect(ar.skipReasonFor(held.id)).toBe('waiting for k8s-prod (disabled)'));
    expect(started).toEqual([]);

    targets = [view('k8s-prod')];
    ar.poke();
    await vi.waitFor(() => expect(started).toEqual([held.id]));
  });

  it('yields the event loop while filling over 1,000 ready Tickets', async () => {
    targets = [view('k8s-prod', { enabled: false })];
    const candidate = await ticket('k8s: seed');
    const many = Array.from({ length: 1000 }, (_, i) => ({ ...candidate, id: 10_000 + i, state: 'ready' as const }));
    vi.spyOn(tasks, 'list').mockResolvedValue(many);
    vi.spyOn(tasks, 'orderedEligibleWork').mockResolvedValue(many as never);
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 30));
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const { ar } = build();
    try {
      await ar['fillSlots'](new Map(), 10, () => { throw new Error('unexpected launch'); });
    } finally {
      clock.mockRestore();
    }
    expect(yielded).toBe(true);
  });
});

describe('deleting an Execution Target', () => {
  it('escalates its running and waiting Tickets, naming the target', async () => {
    const server = await startServer();
    try {
      await server.api('POST', '/api/execution-targets', {
        name: 'k8s-prod', authMethod: 'in-cluster', namespace: 'ns', defaultImage: 'img', cpu: '1', memory: '1Gi',
        concurrencyLimit: 1, repositoryProxyUrl: 'https://repo-proxy.example.test',
      });
      const escalated: [number, string][] = [];
      server.app.ctx.executionTargets.attachTickets({
        byTarget: async () => new Map([['k8s-prod', { running: [7], waiting: [8, 9] }]]),
        escalate: async (id, reason) => void escalated.push([id, reason]),
      });
      expect((await server.api('GET', '/api/execution-targets/k8s-prod/deletion-impact')).body).toEqual({ running: 1, waiting: 2, total: 3 });
      const del = await server.api('DELETE', '/api/execution-targets/k8s-prod');
      expect(del.body.escalated).toEqual({ running: 1, waiting: 2, total: 3 });
      expect(escalated.map(([id]) => id)).toEqual([7, 8, 9]);
      expect(escalated[0]?.[1]).toBe("Execution Target 'k8s-prod' was deleted. Its running Attempt was stopped. Change `runs_on` in the workflow, or add the target back in Settings > Execution.");
      expect(escalated[1]?.[1]).toBe("Execution Target 'k8s-prod' was deleted. No Attempt was started. Change `runs_on` in the workflow, or add the target back in Settings > Execution.");
    } finally {
      await server.close();
    }
  });
});
