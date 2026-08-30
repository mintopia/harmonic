import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { SettingsStore } from '../src/server/settings-store.js';
import { defaultConfig, verificationCommandSchema, budgetGuardrailSchema } from '../src/config.js';

/**
 * The YAML-backed settings store (ADR-0009, issue #391): owns the global
 * `AppConfig` and every per-Workspace override, previously split across the
 * `settings.config` row and nullable `workspaces` columns.
 */
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
    expect(store.getGlobal()).toEqual(defaultConfig());

    const path = join(dir, 'settings.yaml');
    const raw = parse(readFileSync(path, 'utf8'));
    expect(raw.global).toBeDefined();
    expect(raw.workspaces).toEqual({});
  });

  it('global round-trip: updateGlobal/replaceGlobal persist, and a fresh store on the same dir reflects them', async () => {
    const store = await SettingsStore.create(dir);
    await store.updateGlobal({ maxAttempts: 7 });
    expect(store.getGlobal().maxAttempts).toBe(7);

    const reopened1 = await SettingsStore.create(dir);
    expect(reopened1.getGlobal().maxAttempts).toBe(7);

    const replaced = { ...defaultConfig(), maxAttempts: 3 };
    await store.replaceGlobal(replaced);
    expect(store.getGlobal().maxAttempts).toBe(3);

    const reopened2 = await SettingsStore.create(dir);
    expect(reopened2.getGlobal().maxAttempts).toBe(3);
  });

  it('override round-trip and three-state semantics: value sets, null clears (and removes from the file), omitted/{} keeps', async () => {
    const store = await SettingsStore.create(dir);
    const wsId = 1;

    expect(store.getOverrides(wsId).harness).toBeNull(); // fresh: inherit

    await store.setOverrides(wsId, { harness: 'codex', priority: 'high' });
    expect(store.getOverrides(wsId)).toMatchObject({ harness: 'codex', priority: 'high' });

    // undefined/omitted keeps the existing value untouched.
    await store.setOverrides(wsId, {});
    expect(store.getOverrides(wsId)).toMatchObject({ harness: 'codex', priority: 'high' });

    // null clears one field back to inherit, leaving the other set.
    await store.setOverrides(wsId, { harness: null });
    expect(store.getOverrides(wsId).harness).toBeNull();
    expect(store.getOverrides(wsId).priority).toBe('high');

    // Clearing the last set field removes the workspace's entry from the file
    // entirely (sparse) rather than leaving a residual all-null block.
    await store.setOverrides(wsId, { priority: null });
    const raw = parse(readFileSync(join(dir, 'settings.yaml'), 'utf8'));
    expect(raw.workspaces).toEqual({});

    // deleteOverrides removes any set entry outright.
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

    // On disk: a native YAML array/object, not a JSON-encoded string scalar.
    const raw = readFileSync(join(dir, 'settings.yaml'), 'utf8');
    const parsed = parse(raw);
    const stored = parsed.workspaces[String(wsId)];
    expect(Array.isArray(stored.verificationCommand)).toBe(true);
    expect(typeof stored.verificationCommand).not.toBe('string');
    expect(typeof stored.guardrailBudget).toBe('object');
    expect(typeof stored.guardrailBudget).not.toBe('string');

    // Round-trips through getOverrides as the same structured value.
    const overrides = store.getOverrides(wsId);
    expect(overrides.verificationCommand).toMatchObject(command);
    expect(overrides.guardrailBudget).toMatchObject(budget);

    // And survives a fresh store re-parsing the file off disk.
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
    // `defaults.isolationMode` must be an ISOLATION_MODES enum member — an
    // arbitrary string fails `appConfigSchema`.
    const bad = { ...defaultConfig(), defaults: { ...defaultConfig().defaults, isolationMode: 'not-a-real-mode' } };
    writeFileSync(path, stringify({ global: bad, workspaces: {} }));

    await expect(SettingsStore.create(dir)).rejects.toThrow(path);
  });

  it('reloads on an external change to settings.yaml once the throttle window passes', async () => {
    // Drive the throttle off an injected clock, not wall time: a real
    // `setTimeout` wait races the scheduler and flakes under concurrent load
    // (issue #392). `now` is advanced by hand so the throttle boundary is
    // deterministic.
    let now = 1_000_000;
    const store = await SettingsStore.create(dir, undefined, () => now);
    expect(store.getGlobal().maxAttempts).toBe(defaultConfig().maxAttempts);

    // Externally rewrite the file (an operator hand-editing it) — bypassing the
    // store's own write path entirely.
    const path = join(dir, 'settings.yaml');
    const parsed = parse(readFileSync(path, 'utf8'));
    parsed.global.maxAttempts = 9;
    writeFileSync(path, stringify(parsed));
    // Force the file's mtime past the store's loaded mtime so the reload keys
    // off the edit, not on filesystem timestamp resolution (two writes can land
    // in the same millisecond now that there is no wall-clock wait between them).
    const bumped = new Date(statSync(path).mtimeMs + 5_000);
    utimesSync(path, bumped, bumped);

    // Within the throttle window (<1s since the last check): still the old value.
    now += 500;
    expect(store.getGlobal().maxAttempts).toBe(defaultConfig().maxAttempts);

    // Past the throttle window: the next getter reloads and reflects the edit.
    now += 600;
    expect(store.getGlobal().maxAttempts).toBe(9);
  });
});
