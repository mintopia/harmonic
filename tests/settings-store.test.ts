import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { SettingsStore } from '../src/server/settings-store.js';
import { baselineConfig, loadBaselineConfig, verificationCommandSchema, budgetGuardrailSchema } from '../src/config.js';

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

  it('writes changed arrays as whole sparse-patch values', async () => {
    const store = await SettingsStore.create(dir);
    await store.updateGlobal({ verify: { commands: [{ command: 'npm', args: ['test'] }] } });

    expect(parse(readFileSync(join(dir, 'settings.yaml'), 'utf8')).global).toEqual({
      verify: { commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }] },
    });
  });

  it('names the baseline file when it is incomplete', () => {
    const path = join(dir, 'baseline.yaml');
    writeFileSync(path, 'maxAttempts: 3\n');

    expect(() => loadBaselineConfig(path)).toThrow(path);
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

  it('verificationCommand/guardrailBudget persist as native YAML (not JSON strings) and round-trip through getOverrides', async () => {
    const store = await SettingsStore.create(dir);
    const wsId = 2;
    const command = [verificationCommandSchema.parse({ command: 'npm', args: ['test'] })];
    const budget = budgetGuardrailSchema.parse({ wallClockMinutes: 120 });

    await store.setOverrides(wsId, { verificationCommand: command, guardrailBudget: budget });

    const raw = readFileSync(join(dir, 'settings.yaml'), 'utf8');
    const parsed = parse(raw);
    const stored = parsed.workspaces[String(wsId)];
    expect(Array.isArray(stored.verificationCommand)).toBe(true);
    expect(typeof stored.verificationCommand).not.toBe('string');
    expect(typeof stored.guardrailBudget).toBe('object');
    expect(typeof stored.guardrailBudget).not.toBe('string');

    const overrides = store.getOverrides(wsId);
    expect(overrides.verificationCommand).toMatchObject(command);
    expect(overrides.guardrailBudget).toMatchObject(budget);

    const reopened = await SettingsStore.create(dir);
    expect(reopened.getOverrides(wsId).verificationCommand).toMatchObject(command);
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
});
