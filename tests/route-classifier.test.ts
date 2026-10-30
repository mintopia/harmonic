import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig, type AppConfig, type HarnessConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { Runner } from '../src/execution/runner.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import { trackerRef, type Ticket } from '../src/tracker/adapter.js';
import {
  RouteClassifier,
  createHarnessClassifierBackend,
  type ClassifierBackend,
  type ClassifierInput,
} from '../src/domain/route-classifier.js';
import { createAcpCriticDrive, type CriticDriveRequest, type CriticHarnessDrive } from '../src/verification/critic.js';
import { withRoutingContribution } from '../src/domain/pricing.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { executionPlumbing, allWorkspaces, makeSettingsStore, seedWorkspace, testSpawnProcessGroup, STUB_HARNESS } from './helpers.js';

const OPTIONS = [
  { id: 'cheap-fix', harness: 'claude', model: 'claude-haiku-4-5-20251001', description: 'cheap, small fixes' },
  { id: 'deep-work', harness: 'claude', model: 'claude-opus-5-5', description: 'hard, cross-cutting work' },
  { id: 'other-harness', harness: 'codex', model: '', description: 'when claude keeps failing' },
];

const ticket = (labels: string[], ref = 1): Ticket => ({
  ref: trackerRef(ref),
  title: `Ticket ${ref}`,
  state: 'open',
  body: 'fix the thing',
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

const answer = (optionId: string, reason = 'fits') => ({ output: { optionId, reason } });

describe('Route Classifier', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let config: AppConfig;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let runner: Runner;
  let wsId: number;
  let backend: ClassifierBackend & { classify: ReturnType<typeof vi.fn> };

  const makeRunner = () => {
    runner = new Runner(tasks, asyncDb, () => config, {
      ...executionPlumbing(),
      routeClassifier: new RouteClassifier(() => config, { harness: backend }),
    });
    (runner as unknown as { turnDriver: { drive: () => Promise<void> } }).turnDriver.drive = async () => {};
  };

  const setClassifier = (over: Record<string, unknown> = {}) =>
    new WorkspaceService(asyncDb, settingsStore).update(wsId, { classifierEnabled: true, classifierBackend: 'harness', ...over } as never);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-route-classifier-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    settingsStore = await makeSettingsStore(dir);
    config = {
      ...baselineConfig(),
      routingLabels: [{ label: 'reasoning', harness: 'claude', model: 'claude-opus-5-5' }],
      modelOptions: OPTIONS,
    };
    tasks = new TaskService(asyncDb, () => config, allWorkspaces(asyncDb, settingsStore));
    attempts = new AttemptStore(asyncDb);
    backend = { classify: vi.fn(async () => answer('cheap-fix', 'small change')) };
    wsId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
    makeRunner();
  });
  afterEach(async () => {
    await runner.shutdown();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const beginRun = (task: Awaited<ReturnType<TaskService['claimReady']>>) =>
    (runner as unknown as { beginRun: (t: NonNullable<typeof task>) => Promise<Awaited<ReturnType<AttemptStore['create']>>> }).beginRun(task!);
  const events = async (attemptId: number) =>
    (await attempts.listEvents(attemptId)).map((e) => (typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload) as Record<string, unknown>);
  const claimMirrored = async (labels: string[] = ['ready-for-agent']) => {
    const mirrored = (await mirrorScan(tasks, [ticket(labels)], wsId))[0]!;
    return (await tasks.claimReady(mirrored.id))!;
  };

  describe('precedence', () => {
    it('operator setting beats the classifier', async () => {
      await setClassifier();
      const created = await tasks.create({ prompt: 'p', harness: 'claude', model: 'claude-sonnet-5-5', workspaceId: wsId });
      await tasks.setState(created.id, 'ready');
      const bound = await beginRun(await tasks.claimReady(created.id));
      expect(backend.classify).not.toHaveBeenCalled();
      expect(bound).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5' });
    });

    it('a Routing Label beats the classifier', async () => {
      await setClassifier();
      const bound = await beginRun(await claimMirrored(['ready-for-agent', 'reasoning']));
      expect(backend.classify).not.toHaveBeenCalled();
      expect(bound).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });
    });

    it('the classifier beats the Workspace default and records its decision and reason', async () => {
      await setClassifier();
      const bound = await beginRun(await claimMirrored());
      expect(bound).toMatchObject({ harness: 'claude', model: 'claude-haiku-4-5-20251001' });
      expect(await events(bound.id)).toContainEqual(
        expect.objectContaining({ event: 'route-classified', optionId: 'cheap-fix', reason: 'small change' }),
      );
    });

    it('the Workspace default applies when the classifier is off, and the global default when the Workspace has none', async () => {
      const bound = await beginRun(await claimMirrored());
      expect(backend.classify).not.toHaveBeenCalled();
      expect(bound).toMatchObject({ harness: config.defaults.harness });
    });

    it('a Native Task is classified, and re-classified on its next Attempt', async () => {
      await setClassifier();
      const created = await tasks.create({ prompt: 'native work', workspaceId: wsId });
      await tasks.setState(created.id, 'ready');
      const first = await beginRun(await tasks.claimReady(created.id));
      expect(first).toMatchObject({ model: 'claude-haiku-4-5-20251001' });
      await attempts.update(first.id, { state: 'failed', endedAt: Date.now() });
      backend.classify.mockResolvedValueOnce(answer('deep-work', 'escalate'));
      await tasks.setState(created.id, 'ready');
      const second = await beginRun(await tasks.claimReady(created.id));
      expect(backend.classify).toHaveBeenCalledTimes(2);
      expect(second).toMatchObject({ model: 'claude-opus-5-5' });
    });

    it('Epic resolution never calls the backend', async () => {
      await setClassifier();
      await runner['taskService'].routing.epicRoute(wsId, trackerRef(99));
      expect(backend.classify).not.toHaveBeenCalled();
    });
  });

  describe('abstaining', () => {
    const abstentions: Array<[string, () => void, string]> = [
      ['an option id outside the list', () => backend.classify.mockResolvedValue(answer('nope')), "option 'nope' is not in the list"],
      ['a thrown error', () => backend.classify.mockRejectedValue(new Error('boom')), 'boom'],
      ['malformed output', () => backend.classify.mockResolvedValue({ output: { optionId: 3 } }), 'invalid output'],
    ];
    it.each(abstentions)('%s falls back to the Workspace default and records the reason in Activity', async (_name, arrange, expected) => {
      await setClassifier();
      arrange();
      const bound = await beginRun(await claimMirrored());
      expect(bound).toMatchObject({ harness: config.defaults.harness });
      expect(bound.model).not.toBe('claude-haiku-4-5-20251001');
      expect(await events(bound.id)).toContainEqual(
        expect.objectContaining({ event: 'route-classifier-abstained', message: expect.stringContaining(`Route Classifier abstained: `) }),
      );
      expect(JSON.stringify(await events(bound.id))).toContain(expected);
    });

    it('a backend slower than the Workspace timeout abstains; two Workspaces honour different timeouts', async () => {
      const slow = new RouteClassifier(() => config, {
        harness: { classify: () => new Promise((resolve) => setTimeout(() => resolve(answer('cheap-fix')), 120)) },
      });
      const workspace = (await allWorkspaces(asyncDb, settingsStore)())[0]!;
      const request = { title: 't', description: 'd', labels: [], attemptNumber: 1 };
      const short = await slow.classify({ ...request, workspace: { ...workspace, classifierEnabled: true, classifierTimeoutSeconds: 0.03 } });
      const long = await slow.classify({ ...request, workspace: { ...workspace, classifierEnabled: true, classifierTimeoutSeconds: 5 } });
      expect(short).toMatchObject({ kind: 'abstained', reason: expect.stringContaining('timed out') });
      expect(long).toMatchObject({ kind: 'chosen' });
    });

    it('abstains when the Workspace has no Model Options', async () => {
      config = { ...config, modelOptions: [] };
      await setClassifier();
      const bound = await beginRun(await claimMirrored());
      expect(backend.classify).not.toHaveBeenCalled();
      expect(JSON.stringify(await events(bound.id))).toContain('no Model Options');
    });
  });

  describe('history and cost', () => {
    it("Attempt 2's classifier input carries Attempt 1's verdict and failure reason, and a different Harness starts a cold Session", async () => {
      await setClassifier();
      const first = await beginRun(await claimMirrored());
      await attempts.update(first.id, { state: 'escalated', reason: 'escalate', detail: 'tests keep failing', endedAt: Date.now(), sessionRowId: null });
      backend.classify.mockResolvedValueOnce(answer('other-harness', 'switch harness'));
      const mirrored = (await mirrorScan(tasks, [ticket(['ready-for-agent'])], wsId))[0]!;
      await tasks.setState(mirrored.id, 'ready');
      const second = await beginRun(await tasks.claimReady(mirrored.id));
      const input = backend.classify.mock.calls[1]![0] as ClassifierInput;
      expect(input).toMatchObject({ attemptNumber: 2, previousVerdict: 'escalate', previousFailureReason: 'tests keep failing' });
      expect(second).toMatchObject({ harness: 'codex', sessionRowId: null });
      expect(await events(second.id)).toContainEqual(expect.objectContaining({ event: 'route-changed', sessionKept: false }));
    });

    it("routes Attempt 2 through a real ACP Harness with Attempt 1's history, then starts a cold Session on the new Harness", async () => {
      await setClassifier();
      const stub: HarnessConfig = { command: process.execPath, args: [STUB_HARNESS], env: {}, models: [{ id: 'stub-model' }], defaultModel: 'stub-model', cacheWarmSeconds: 300 };
      config = { ...config, harnesses: { ...config.harnesses, claude: stub }, defaults: { ...config.defaults, harness: 'claude' } } as AppConfig;
      const real = createAcpCriticDrive(testSpawnProcessGroup);
      const prompts: string[] = [];
      const drive: CriticHarnessDrive = {
        run: (req) => {
          prompts.push(req.prompt);
          const optionId = req.prompt.includes('"attemptNumber": 2') ? 'other-harness' : 'cheap-fix';
          const text = JSON.stringify({ optionId, reason: 'scripted' });
          return real.run({ ...req, prompt: JSON.stringify({ updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }] }) });
        },
      };
      await runner.shutdown();
      runner = new Runner(tasks, asyncDb, () => config, {
        ...executionPlumbing(),
        routeClassifier: new RouteClassifier(() => config, { harness: createHarnessClassifierBackend({ drive, getConfig: () => config }) }),
      });
      (runner as unknown as { turnDriver: { drive: () => Promise<void> } }).turnDriver.drive = async () => {};

      const first = await beginRun(await claimMirrored());
      expect(first).toMatchObject({ harness: 'claude', model: 'claude-haiku-4-5-20251001' });
      await attempts.update(first.id, { state: 'escalated', reason: 'escalate', detail: 'tests keep failing', endedAt: Date.now() });
      const mirrored = (await mirrorScan(tasks, [ticket(['ready-for-agent'])], wsId))[0]!;
      await tasks.setState(mirrored.id, 'ready');
      const second = await beginRun(await tasks.claimReady(mirrored.id));

      expect(prompts[1]).toContain('"previousVerdict": "escalate"');
      expect(prompts[1]).toContain('"previousFailureReason": "tests keep failing"');
      expect(second).toMatchObject({ harness: 'codex', sessionRowId: null });
      expect(await events(second.id)).toContainEqual(expect.objectContaining({ event: 'route-changed', sessionKept: false }));
    }, 30_000);

    it('records the classifier usage as a routing cost line on the routed Attempt, not on the implementation cost', async () => {
      await setClassifier();
      backend.classify.mockResolvedValue({
        ...answer('cheap-fix'),
        harness: 'claude',
        model: 'claude-haiku-4-5-20251001',
        usage: {
          models: { 'claude-haiku-4-5-20251001': { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
          totals: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1100 },
          toolCalls: {},
          source: 'acp',
        },
      });
      const bound = await beginRun(await claimMirrored());
      const row = await attempts.get(bound.id);
      expect(row.cost).toBeNull();
      expect(row.usage).toBeNull();
      expect(JSON.parse(row.routingUsage!).totals.totalTokens).toBe(1100);
      expect(JSON.parse(row.routingCost!)).toMatchObject({ byModel: { 'claude-haiku-4-5-20251001': expect.any(Number) } });
    });
  });
});

describe('withRoutingContribution', () => {
  const routing = { cost: { totalUsd: 0.002, byModel: { m: 0.002 }, incomplete: false } };
  const implementation = { totalUsd: 1, byModel: { opus: 1 }, incomplete: false };

  it('adds a separate routing line to the Attempt cost without touching the implementation line', () => {
    expect(withRoutingContribution(implementation, routing)).toEqual({ totalUsd: 1.002, byModel: { opus: 1, routing: 0.002 }, incomplete: false });
    expect(implementation.byModel).toEqual({ opus: 1 });
  });

  it('shows a routing line while the Attempt has no cost yet, and flags an unpriced routing call incomplete', () => {
    expect(withRoutingContribution(null, routing)).toMatchObject({ totalUsd: 0.002, byModel: { routing: 0.002 } });
    expect(withRoutingContribution(implementation, { cost: null })).toMatchObject({ totalUsd: 1, byModel: { opus: 1, routing: null }, incomplete: true });
  });

  it('leaves the cost alone when no classifier ran', () => {
    expect(withRoutingContribution(implementation, null)).toBe(implementation);
  });
});

describe('Harness classifier backend (real ACP Harness)', () => {
  const harness: HarnessConfig = {
    command: process.execPath,
    args: [STUB_HARNESS],
    env: {},
    models: [{ id: 'stub-model' }],
    defaultModel: 'stub-model',
    cacheWarmSeconds: 300,
  };
  const config = { ...baselineConfig(), modelOptions: OPTIONS, harnesses: { ...baselineConfig().harnesses, claude: harness } } as AppConfig;
  const real = createAcpCriticDrive(testSpawnProcessGroup);
  const input: ClassifierInput = {
    title: 'Fix typo',
    description: 'a typo',
    labels: [],
    attemptNumber: 1,
    options: OPTIONS.map(({ id, description, harness: h, model }) => ({ id, description, harness: h, model })),
  };
  const workspace = { id: 1, classifierEnabled: true, classifierBackend: 'harness', classifierTimeoutSeconds: 15, harness: null, model: null } as never;

  it('routes a fixture Ticket to a listed option from a Session whose cwd is outside every repository', async () => {
    const seen: CriticDriveRequest[] = [];
    const drive: CriticHarnessDrive = {
      run: (req) => {
        seen.push(req);
        const scenario = {
          updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '```json\n{"optionId":"deep-work","reason":"typo is trivial but ok"}\n```' } }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
        return real.run({ ...req, prompt: JSON.stringify(scenario) });
      },
    };
    const classifier = new RouteClassifier(() => config, { harness: createHarnessClassifierBackend({ drive, getConfig: () => config }) });
    const outcome = await classifier.classify({ workspace: workspace, title: input.title, description: input.description, labels: [], attemptNumber: 1 });
    expect(outcome).toMatchObject({ kind: 'chosen', option: { id: 'deep-work' }, reason: 'typo is trivial but ok' });
    if (outcome.kind === 'chosen') expect(outcome.routing?.usage.totals?.totalTokens ?? 0).toBeGreaterThanOrEqual(0);

    const cwd = seen[0]!.cwd;
    expect(relative(tmpdir(), cwd).startsWith('..')).toBe(false);
    expect(existsSync(cwd)).toBe(false);
    expect(() => execFileSync('git', ['-C', tmpdir(), 'rev-parse', '--show-toplevel'], { stdio: 'pipe' })).toThrow();
    expect(seen[0]!.denyPermissions).toBe(true);
  }, 30_000);

  it('denies a permission request from the classifier Session', async () => {
    const result = await real.run({
      harness,
      harnessId: 'claude',
      model: 'stub-model',
      cwd: mkdtempSync(join(tmpdir(), 'harmonic-deny-')),
      prompt: JSON.stringify({ requestPermission: { title: 'edit a file', kind: 'edit' } }),
      timeoutMs: 15_000,
      denyPermissions: true,
    });
    expect(result.permissionRequests).toHaveLength(1);
    expect(result.output).toContain('permission:{"outcome":"selected","optionId":"reject"}');
  }, 20_000);
});
