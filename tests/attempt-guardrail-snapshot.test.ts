import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { resolveGuardrails } from '../src/domain/setting-override.js';
import { resolvePrices } from '../src/domain/pricing.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

describe('AttemptStore.create Guardrail snapshot (issue #126, ADR-0019)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let runStore: AttemptStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-grs-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    runStore = new AttemptStore(asyncDb);
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures the effective Guardrail config + price table onto the Run at start', async () => {
    const task = await tasks.create({ prompt: 'snapshot me', state: 'ready' });
    const config = defaultConfig();
    const snapshot = {
      guardrailConfig: resolveGuardrails({ guardrailBudget: null, guardrailProgress: null, toolTimeoutMinutes: null }, config),
      priceTable: resolvePrices(config.prices),
    };

    const run = await runStore.create(task.id, snapshot);

    expect(JSON.parse(run.guardrailConfig!).budget.wallClockMinutes).toBe(60);
    expect(JSON.parse(run.priceTable!)['claude-sonnet-5']).toBeDefined();
  });

  it('is frozen: a later config change does not retroactively alter the stored snapshot', async () => {
    const task = await tasks.create({ prompt: 'frozen snapshot', state: 'ready' });
    const config = defaultConfig();
    const originalSnapshot = {
      guardrailConfig: resolveGuardrails({ guardrailBudget: null, guardrailProgress: null, toolTimeoutMinutes: null }, config),
      priceTable: resolvePrices(config.prices),
    };

    const run = await runStore.create(task.id, originalSnapshot);
    const originalPriceTable = run.priceTable;

    const laterPrices = resolvePrices({ 'claude-sonnet-5': { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 } });
    expect(laterPrices['claude-sonnet-5']).not.toEqual(resolvePrices(config.prices)['claude-sonnet-5']);

    const refetched = await runStore.get(run.id);
    expect(refetched.priceTable).toBe(originalPriceTable);
    expect(JSON.parse(refetched.priceTable!)['claude-sonnet-5']).toEqual(resolvePrices(config.prices)['claude-sonnet-5']);
  });
});
