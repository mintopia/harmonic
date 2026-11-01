import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { SettingsStore } from '../src/server/settings-store.js';
import { appConfigSchema, baselineConfig, loadBaselineConfig, mergeConfig, budgetGuardrailSchema } from '../src/config.js';

describe('SettingsStore (issue #391)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-settings-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a missing file yields defaults and writes settings.yaml', async () => {
    const store = await SettingsStore.create(dir);
    expect(store.getGlobal()).toEqual(baselineConfig());

    const path = join(dir, 'settings.yaml');
    const raw = parse(readFileSync(path, 'utf8'));
    expect(raw.global).toEqual({});
    expect(raw.workspaces).toEqual({});
  });

  it('converges a flattened global config to a sparse patch without changing its resolved values', async () => {
    const flattened = { ...baselineConfig(), maxAttempts: 7 };
    const path = join(dir, 'settings.yaml');
    writeFileSync(path, stringify({ global: flattened, workspaces: {} }));

    const store = await SettingsStore.create(dir);
    expect(store.getGlobal()).toEqual(flattened);
    expect(parse(readFileSync(path, 'utf8'))).toEqual({ global: { maxAttempts: 7 }, workspaces: {} });
  });

  it('a flattened config predating baseline model prices inherits them, never tombstones them', async () => {
    // A whole-config global saved before baseline.yaml carried model prices:
    // every model is valid but priceless, plus one operator-added model.
    const flattened = structuredClone(baselineConfig());
    for (const harness of Object.values(flattened.harnesses)) {
      harness.models = harness.models.map(({ price: _price, ...rest }) => rest);
    }
    flattened.harnesses.claude.models.push({ id: 'operator-added', price: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.5 }, contextWindow: 128_000 });

    const path = join(dir, 'settings.yaml');
    writeFileSync(path, stringify({ global: flattened, workspaces: {} }));

    const store = await SettingsStore.create(dir);
    const base = baselineConfig();
    const harnessIds = ['claude', 'codex', 'copilot', 'opencode'] satisfies Array<keyof typeof base.harnesses>;
    for (const id of harnessIds) {
      for (const baseModel of base.harnesses[id].models) {
        const resolved = store.getGlobal().harnesses[id].models.find((m) => m.id === baseModel.id);
        expect(resolved?.price).toEqual(baseModel.price);
      }
    }
    expect(store.getGlobal().harnesses.claude.models).toContainEqual(
      expect.objectContaining({ id: 'operator-added', price: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.5 } }),
    );

    // The converged sparse patch carries only the real addition — no price tombstones.
    const persisted = parse(readFileSync(path, 'utf8')).global;
    expect(JSON.stringify(persisted)).not.toContain('"price":null');
    expect(persisted.harnesses.claude.models).toEqual({
      'operator-added': { id: 'operator-added', price: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.5 }, contextWindow: 128_000 },
    });
    expect(persisted.harnesses.codex).toBeUndefined();
  });

  it('migrates legacy top-level price and context data without harness overrides', async () => {
    const path = join(dir, 'settings.yaml');
    writeFileSync(path, stringify({
      global: {
        prices: { 'claude-opus-5': { input: 9, output: 18, cacheRead: 0.9, cacheWrite: 1.8 } },
        modelInfo: {
          'claude-opus-5': { contextWindow: 123_456 },
          'custom-legacy-model': { contextWindow: 65_536 },
        },
      },
      workspaces: {},
    }));

    const store = await SettingsStore.create(dir);
    expect(store.getGlobal().harnesses.claude.models.find((model) => model.id === 'claude-opus-5')).toEqual({
      id: 'claude-opus-5',
      price: { input: 9, output: 18, cacheRead: 0.9, cacheWrite: 1.8 },
      contextWindow: 123_456,
    });
    const persisted = parse(readFileSync(path, 'utf8')).global;
    expect(persisted.harnesses.claude.models).toEqual({
      'claude-opus-5': { price: { input: 9, output: 18, cacheRead: 0.9, cacheWrite: 1.8 }, contextWindow: 123_456 },
      'custom-legacy-model': { id: 'custom-legacy-model', contextWindow: 65_536 },
    });
    for (const id of ['codex', 'copilot']) {
      expect(persisted.harnesses[id].models).toEqual({
        'claude-opus-5': { id: 'claude-opus-5', price: { input: 9, output: 18, cacheRead: 0.9, cacheWrite: 1.8 }, contextWindow: 123_456 },
        'custom-legacy-model': { id: 'custom-legacy-model', contextWindow: 65_536 },
      });
    }
    for (const harness of Object.values(store.getGlobal().harnesses)) {
      expect(harness.models).toContainEqual({ id: 'custom-legacy-model', contextWindow: 65_536 });
    }
  });

  it('writes changed arrays as whole sparse-patch values', async () => {
    const store = await SettingsStore.create(dir);
    await store.updateGlobal({ verify: { epic: { preMerge: { commands: [{ id: 'cmd-test', command: 'npm', args: ['test'] }], critics: [] } } } });

    expect(parse(readFileSync(join(dir, 'settings.yaml'), 'utf8')).global).toEqual({
      verify: { epic: { preMerge: { commands: [{ id: 'cmd-test', command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }] } } },
    });
  });

  it('persists model catalog changes by id while untouched models track the baseline', async () => {
    const store = await SettingsStore.create(dir);
    const baseline = baselineConfig();
    const [edited, removed] = baseline.harnesses.claude.models;
    if (!edited || !removed) throw new Error('Claude baseline requires two models');

    await store.replaceGlobal({
      ...baseline,
      harnesses: {
        ...baseline.harnesses,
        claude: {
          ...baseline.harnesses.claude,
          models: [
            { ...edited, contextWindow: 123_456 },
            ...baseline.harnesses.claude.models.slice(2),
            { id: 'operator-model', contextWindow: 65_536 },
          ],
        },
      },
    });

    expect(parse(readFileSync(join(dir, 'settings.yaml'), 'utf8')).global).toEqual({
      harnesses: {
        claude: {
          models: {
            [edited.id]: { contextWindow: 123_456 },
            [removed.id]: null,
            'operator-model': { id: 'operator-model', contextWindow: 65_536 },
          },
        },
      },
    });

    const evolvedBaseline = {
      ...baseline,
      harnesses: {
        ...baseline.harnesses,
        claude: {
          ...baseline.harnesses.claude,
          models: [...baseline.harnesses.claude.models, { id: 'shipped-later-model', contextWindow: 200_000 }],
        },
      },
    };
    const patch = parse(readFileSync(join(dir, 'settings.yaml'), 'utf8')).global;
    const resolved = mergeConfig(evolvedBaseline, patch);

    expect(resolved.harnesses.claude.models).toContainEqual({ ...edited, contextWindow: 123_456 });
    expect(resolved.harnesses.claude.models).not.toContainEqual(removed);
    expect(resolved.harnesses.claude.models).toContainEqual({ id: 'operator-model', contextWindow: 65_536 });
    expect(resolved.harnesses.claude.models).toContainEqual({ id: 'shipped-later-model', contextWindow: 200_000 });
  });

  it('persists clearing an optional model field as a keyed field tombstone', async () => {
    const store = await SettingsStore.create(dir);
    const baseline = baselineConfig();
    const [model] = baseline.harnesses.claude.models;
    if (!model) throw new Error('Claude baseline requires a model');
    const { contextWindow: _contextWindow, ...withoutContextWindow } = model;

    await store.replaceGlobal({
      ...baseline,
      harnesses: {
        ...baseline.harnesses,
        claude: { ...baseline.harnesses.claude, models: [withoutContextWindow, ...baseline.harnesses.claude.models.slice(1)] },
      },
    });

    expect(parse(readFileSync(join(dir, 'settings.yaml'), 'utf8')).global.harnesses.claude.models).toEqual({
      [model.id]: { contextWindow: null },
    });
    const reopened = await SettingsStore.create(dir);
    expect(reopened.getGlobal().harnesses.claude.models.find((entry) => entry.id === model.id)?.contextWindow).toBeUndefined();
  });

  it('names the baseline file when it is incomplete', () => {
    const path = join(dir, 'baseline.yaml');
    writeFileSync(path, 'maxAttempts: 3\n');

    expect(() => loadBaselineConfig(path)).toThrow(path);
  });

  it('does not apply shipped defaults outside the baseline', () => {
    const { maxAttempts: _maxAttempts, ...withoutMaxAttempts } = baselineConfig();

    expect(appConfigSchema.safeParse(withoutMaxAttempts).success).toBe(false);
  });

  it('names the baseline file when its YAML is invalid', () => {
    const path = join(dir, 'baseline.yaml');
    writeFileSync(path, '{ not: valid: yaml: [');

    expect(() => loadBaselineConfig(path)).toThrow(path);
  });

  it('global round-trip: updateGlobal/replaceGlobal persist, and a fresh store on the same dir reflects them', async () => {
    const store = await SettingsStore.create(dir);
    await store.updateGlobal({ maxAttempts: 7 });
    expect(store.getGlobal().maxAttempts).toBe(7);

    const reopened1 = await SettingsStore.create(dir);
    expect(reopened1.getGlobal().maxAttempts).toBe(7);

    const replaced = { ...baselineConfig(), maxAttempts: 3 };
    await store.replaceGlobal(replaced);
    expect(store.getGlobal().maxAttempts).toBe(3);

    const reopened2 = await SettingsStore.create(dir);
    expect(reopened2.getGlobal().maxAttempts).toBe(3);
  });

  it('revertGlobal clears the sparse global patch back to the distributed baseline', async () => {
    const store = await SettingsStore.create(dir);
    await store.updateGlobal({ maxAttempts: 7 });

    await store.revertGlobal();

    expect(store.getGlobal()).toEqual(baselineConfig());
    expect(parse(readFileSync(join(dir, 'settings.yaml'), 'utf8'))).toEqual({ global: {}, workspaces: {} });
  });

  it('override round-trip and three-state semantics: value sets, null clears (and removes from the file), omitted/{} keeps', async () => {
    const store = await SettingsStore.create(dir);
    const wsId = 1;

    expect(store.getOverrides(wsId).harness).toBeNull();

    await store.setOverrides(wsId, { harness: 'codex', priority: 'high' });
    expect(store.getOverrides(wsId)).toMatchObject({ harness: 'codex', priority: 'high' });

    await store.setOverrides(wsId, {});
    expect(store.getOverrides(wsId)).toMatchObject({ harness: 'codex', priority: 'high' });

    await store.setOverrides(wsId, { harness: null });
    expect(store.getOverrides(wsId).harness).toBeNull();
    expect(store.getOverrides(wsId).priority).toBe('high');

    await store.setOverrides(wsId, { priority: null });
    const raw = parse(readFileSync(join(dir, 'settings.yaml'), 'utf8'));
    expect(raw.workspaces).toEqual({});

    await store.setOverrides(wsId, { harness: 'claude' });
    await store.deleteOverrides(wsId);
    expect(store.getOverrides(wsId).harness).toBeNull();
    const raw2 = parse(readFileSync(join(dir, 'settings.yaml'), 'utf8'));
    expect(raw2.workspaces).toEqual({});
  });

  it('guardrailBudget persists as native YAML (not a JSON string) and round-trips through getOverrides', async () => {
    const store = await SettingsStore.create(dir);
    const wsId = 2;
    const budget = budgetGuardrailSchema.parse({ wallClockMinutes: 120 });

    await store.setOverrides(wsId, { guardrailBudget: budget });

    const raw = readFileSync(join(dir, 'settings.yaml'), 'utf8');
    const parsed = parse(raw);
    const stored = parsed.workspaces[String(wsId)];
    expect(typeof stored.guardrailBudget).toBe('object');
    expect(typeof stored.guardrailBudget).not.toBe('string');

    const overrides = store.getOverrides(wsId);
    expect(overrides.guardrailBudget).toMatchObject(budget);

    const reopened = await SettingsStore.create(dir);
    expect(reopened.getOverrides(wsId).guardrailBudget).toMatchObject(budget);
  });

  it('fails loud, naming the file, on invalid YAML', async () => {
    const path = join(dir, 'settings.yaml');
    writeFileSync(path, '{ not: valid: yaml: [');

    await expect(SettingsStore.create(dir)).rejects.toThrow(path);
  });

  it('fails loud, never silently defaulting, on a schema-invalid stored global value', async () => {
    const path = join(dir, 'settings.yaml');
    const bad = { ...baselineConfig(), defaults: { ...baselineConfig().defaults, isolationMode: 'not-a-real-mode' } };
    writeFileSync(path, stringify({ global: bad, workspaces: {} }));

    await expect(SettingsStore.create(dir)).rejects.toThrow(path);
  });

  it('reloads on an external change to settings.yaml once the throttle window passes', async () => {
    let now = 1_000_000;
    const store = await SettingsStore.create(dir, undefined, () => now);
    expect(store.getGlobal().maxAttempts).toBe(baselineConfig().maxAttempts);

    const path = join(dir, 'settings.yaml');
    const parsed = parse(readFileSync(path, 'utf8'));
    parsed.global.maxAttempts = 9;
    writeFileSync(path, stringify(parsed));
    // Force the file's mtime past the store's loaded mtime so the reload keys
    // off the edit, not on filesystem timestamp resolution (two writes can land
    // in the same millisecond now that there is no wall-clock wait between them).
    const bumped = new Date(statSync(path).mtimeMs + 5_000);
    utimesSync(path, bumped, bumped);

    now += 500;
    expect(store.getGlobal().maxAttempts).toBe(baselineConfig().maxAttempts);

    now += 600;
    expect(store.getGlobal().maxAttempts).toBe(9);
  });

  describe('pre-workflow execution keys (ADR-0055)', () => {
    const command = { id: 'cmd-test', command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
    const critic = { id: 'critic-a', name: 'A', harness: 'claude', model: 'claude-sonnet-5-5', issuePrompt: 'i', noIssuePrompt: 'n', timeoutSeconds: 300 };
    const oldFile = () => ({
      global: {
        maxAttempts: 4,
        drive: { prompt: 'Resolve {ref}.', mergeFate: 'open-PR', continueAttempts: 3 },
        verify: {
          task: { preMerge: { commands: [command], critics: [critic] }, postMerge: { commands: [command], critics: [] } },
          epic: { preMerge: { commands: [{ ...command, id: 'cmd-epic' }] } },
        },
      },
      workspaces: {
        1: {
          priority: 'high',
          driveMergeFate: 'artifact',
          driveContinueAttempts: 0,
          taskPreMergeCommands: [{ kind: 'local', enabled: true, command }],
          taskPreMergeCritics: [{ kind: 'global', ref: 'critic-a', enabled: false }],
          taskPostMergeCommands: [],
          taskPostMergeCritics: null,
        },
        2: { driveMergeFate: 'auto-merge' },
      },
    });
    const path = () => join(dir, 'settings.yaml');
    const onDisk = () => parse(readFileSync(path(), 'utf8'));

    it('loads a file carrying the old keys and ignores them', async () => {
      writeFileSync(path(), stringify(oldFile()));

      const store = await SettingsStore.create(dir);
      const global = store.getGlobal() as Record<string, any>;

      expect(global.maxAttempts).toBe(4);
      expect(global.drive.prompt).toBe('Resolve {ref}.');
      expect(global.drive).not.toHaveProperty('mergeFate');
      expect(global.drive).not.toHaveProperty('continueAttempts');
      expect(global.verify).not.toHaveProperty('task');
      expect(global.verify.epic.preMerge.commands.map((c: { id: string }) => c.id)).toEqual(['cmd-epic']);
      const overrides = store.getOverrides(1) as Record<string, unknown>;
      expect(overrides.priority).toBe('high');
      for (const key of ['driveMergeFate', 'driveContinueAttempts', 'taskPreMergeCommands', 'taskPreMergeCritics', 'taskPostMergeCommands', 'taskPostMergeCritics']) {
        expect(overrides).not.toHaveProperty(key);
      }
    });

    it('leaves the file byte-identical when booting changes nothing', async () => {
      writeFileSync(path(), stringify(oldFile()));
      const before = readFileSync(path(), 'utf8');

      await SettingsStore.create(dir);

      expect(readFileSync(path(), 'utf8')).toBe(before);
    });

    it('keeps the old keys, global and per-Workspace, on disk through every kind of write', async () => {
      const original = oldFile();
      writeFileSync(path(), stringify(original));
      const store = await SettingsStore.create(dir);

      await store.updateGlobal({ maxAttempts: 5, drive: { prompt: 'Changed.' } });
      await store.setOverrides(1, { priority: 'low' });
      await store.setOverrides(3, { priority: 'high' });
      await store.setDefaultWorkflow('implement');
      await store.replaceGlobal({ ...store.getGlobal(), maxAttempts: 6 });

      const written = onDisk();
      expect(written.global.maxAttempts).toBe(6);
      expect(written.global.drive).toEqual({ prompt: 'Changed.', mergeFate: 'open-PR', continueAttempts: 3 });
      expect(written.global.verify.task).toEqual(original.global.verify.task);
      expect(written.global.verify.epic).toEqual(original.global.verify.epic);
      expect(written.workspaces['1']).toEqual({ ...original.workspaces[1], priority: 'low' });
      expect(written.workspaces['2']).toEqual(original.workspaces[2]);
      expect(written.workspaces['3']).toEqual({ priority: 'high' });

      const reopened = await SettingsStore.create(dir);
      expect(reopened.getOverrides(1).priority).toBe('low');
      expect(onDisk()).toEqual(written);
    });

    it('keeps a Workspace entry that holds only old keys when its new overrides are cleared, and drops it when the Workspace is deleted', async () => {
      writeFileSync(path(), stringify(oldFile()));
      const store = await SettingsStore.create(dir);

      await store.setOverrides(1, { priority: null });
      expect(onDisk().workspaces['1']).not.toHaveProperty('priority');
      expect(onDisk().workspaces['1'].driveMergeFate).toBe('artifact');
      await store.setOverrides(2, { priority: 'low' });
      expect(onDisk().workspaces['2']).toEqual({ driveMergeFate: 'auto-merge', priority: 'low' });

      await store.deleteOverrides(1);
      expect(onDisk().workspaces).not.toHaveProperty('1');
      expect(onDisk().workspaces['2'].driveMergeFate).toBe('auto-merge');
    });

    it('exposes the stored old keys, resolved over their old defaults, to the first-boot migration only', async () => {
      writeFileSync(path(), stringify(oldFile()));

      const legacy = (await SettingsStore.create(dir)).getLegacySettings();

      expect(legacy.global).toMatchObject({ continueAttempts: 3, mergeFate: 'open-PR' });
      expect(legacy.global.preMerge.commands.map((c) => c.id)).toEqual(['cmd-test']);
      expect(legacy.workspaces.get(1)).toMatchObject({ driveMergeFate: 'artifact', driveContinueAttempts: 0 });
      expect(legacy.workspaces.get(2)).toMatchObject({ driveMergeFate: 'auto-merge' });
      expect((await SettingsStore.create(join(dir, 'fresh'))).getLegacySettings().global).toMatchObject({ continueAttempts: 10, mergeFate: 'auto-merge' });
    });
  });

  describe('verifier id backfill and array-to-overlay migration (ADR-0037)', () => {
    it('backfills a missing id onto a stored global verifier and persists it stably across restarts', async () => {
      const path = join(dir, 'settings.yaml');
      writeFileSync(path, stringify({
        global: { verify: { epic: { preMerge: { commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }], critics: [] } } } },
        workspaces: {},
      }));

      const store = await SettingsStore.create(dir);
      const [command] = store.getGlobal().verify.epic.preMerge.commands;
      expect(command!.id).toBeTruthy();

      const persisted = parse(readFileSync(path, 'utf8'));
      expect(persisted.global.verify.epic.preMerge.commands[0].id).toBe(command!.id);

      const reopened = await SettingsStore.create(dir);
      expect(reopened.getGlobal().verify.epic.preMerge.commands[0]!.id).toBe(command!.id);
    });

    it('converts a pre-ADR-0037 whole-array Workspace override to an overlay of local entries, id-backfilled', async () => {
      const path = join(dir, 'settings.yaml');
      writeFileSync(path, stringify({
        global: {},
        workspaces: {
          1: { epicPreMergeCommands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }] },
        },
      }));

      const store = await SettingsStore.create(dir);
      const [entry] = store.getLegacySettings().workspaces.get(1)!.epicPreMergeCommands!;
      expect(entry).toMatchObject({ kind: 'local', enabled: true, command: { command: 'npm', args: ['test'] } });
      expect((entry as { command: { id: string } }).command.id).toBeTruthy();

      expect(parse(readFileSync(path, 'utf8')).workspaces['1'].epicPreMergeCommands).toEqual([{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }]);
    });

    it('leaves the stored Workspace epic overlay untouched across loads', async () => {
      const path = join(dir, 'settings.yaml');
      writeFileSync(path, stringify({
        global: { verify: { epic: { preMerge: { commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }], critics: [] } } } },
        workspaces: {
          1: { epicPreMergeCommands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }] },
        },
      }));

      const first = await SettingsStore.create(dir);
      const globalCommandId = first.getGlobal().verify.epic.preMerge.commands[0]!.id;
      const stored = parse(readFileSync(path, 'utf8')).workspaces['1'];

      const second = await SettingsStore.create(dir);
      expect(second.getGlobal().verify.epic.preMerge.commands[0]!.id).toBe(globalCommandId);
      expect(second.getLegacySettings().workspaces.get(1)!.epicPreMergeCommands).toMatchObject([{ kind: 'local', enabled: true, command: { command: 'npm' } }]);
      expect(parse(readFileSync(path, 'utf8')).workspaces['1']).toEqual(stored);
    });
  });
});
