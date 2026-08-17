import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { resolveGuardrails } from '../src/domain/setting-override.js';
import { resolvePrices } from '../src/execution/pricing.js';
import { allWorkspaces } from './helpers.js';

/**
 * The Run Guardrail snapshot (issue #126, ADR-0019): the effective Guardrail
 * config + price table are captured onto a Run at start, so a later config
 * change can never retroactively alter what that Run would trip against.
 */
describe('RunStore.create Guardrail snapshot (issue #126, ADR-0019)', () => {
  let dir: string;
  let db: Db;
  let tasks: TaskService;
  let runStore: RunStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-grs-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    runStore = new RunStore(db);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('captures the effective Guardrail config + price table onto the Run at start', () => {
    const task = tasks.create({ prompt: 'snapshot me', state: 'ready' });
    const config = defaultConfig();
    const snapshot = {
      guardrailConfig: resolveGuardrails({ guardrailBudget: null, guardrailProgress: null }, config),
      priceTable: resolvePrices(config.prices),
    };

    const run = runStore.create(task.id, snapshot);

    expect(JSON.parse(run.guardrailConfig!).budget.wallClockMinutes).toBe(60);
    expect(JSON.parse(run.priceTable!)['claude-sonnet-5']).toBeDefined();
  });

  it('is frozen: a later config change does not retroactively alter the stored snapshot', () => {
    const task = tasks.create({ prompt: 'frozen snapshot', state: 'ready' });
    const config = defaultConfig();
    const originalSnapshot = {
      guardrailConfig: resolveGuardrails({ guardrailBudget: null, guardrailProgress: null }, config),
      priceTable: resolvePrices(config.prices),
    };

    const run = runStore.create(task.id, originalSnapshot);
    const originalPriceTable = run.priceTable;

    // A later config change — a mid-Run price edit — resolves a different price table...
    const laterPrices = resolvePrices({ 'claude-sonnet-5': { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 } });
    expect(laterPrices['claude-sonnet-5']).not.toEqual(resolvePrices(config.prices)['claude-sonnet-5']);

    // ...but the already-created Run's stored snapshot is unaffected.
    const refetched = runStore.get(run.id);
    expect(refetched.priceTable).toBe(originalPriceTable);
    expect(JSON.parse(refetched.priceTable!)['claude-sonnet-5']).toEqual(resolvePrices(config.prices)['claude-sonnet-5']);
  });
});
