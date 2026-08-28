import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { ConfigStore } from '../src/server/config-store.js';
import { SettingsStore } from '../src/server/settings-store.js';
import { defaultConfig, verificationCommandSchema } from '../src/config.js';

describe('ConfigStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed `<dir>/settings.yaml` with a raw (pre-validation) global config, the
   * same shape `SettingsStore.create` boots off disk — the YAML-era stand-in
   * for the old "insert a settings row" seeding (issue #391). */
  function seedGlobal(global: unknown): void {
    writeFileSync(join(dir, 'settings.yaml'), stringify({ global, workspaces: {} }));
  }

  it('boots a config saved before a field existed, filling it from defaults', async () => {
    // A config persisted by an older build — no `drive` key at all.
    const legacy: any = { ...defaultConfig() };
    delete legacy.drive;
    seedGlobal(legacy);

    // A bare parse would throw here; the overlay-on-defaults boot must not.
    const store = new ConfigStore(await SettingsStore.create(dir));
    expect(store.get().drive).toEqual(defaultConfig().drive);
  });

  it('boots a stored config that still contains a legacy tracker block, dropping it (ADR-0014)', async () => {
    const withTracker: any = { ...defaultConfig(), tracker: { enabled: true, pollIntervalSeconds: 30 } };
    seedGlobal(withTracker);

    const store = new ConfigStore(await SettingsStore.create(dir));
    expect(store.get()).not.toHaveProperty('tracker');
  });

  it('boots an existing config saved before verification existed, defaulting to no verifiers (issue #132)', async () => {
    // An install that predates #312: the stored config has no `verify` key.
    const legacy: any = { ...defaultConfig() };
    delete legacy.verify;
    seedGlobal(legacy);

    const store = new ConfigStore(await SettingsStore.create(dir));
    // Default resolution yields "no verifiers" — an existing Run's outcome is unchanged.
    expect(store.get().verify).toEqual({ commands: [], review: { enabled: false } });
  });

  it('clears a configured verifier back to null via PATCH without crashing on the null override (issue #132)', async () => {
    // A null override deep-merged onto a configured object used to hit
    // `Object.keys(null)` in mergeConfig; the fix short-circuits a null b.
    const store = new ConfigStore(await SettingsStore.create(dir));
    const set = await store.update({
      verify: { commands: [verificationCommandSchema.parse({ command: 'npm', args: ['test'] })] },
    });
    expect(set.verify.commands[0]).toMatchObject({ command: 'npm', args: ['test'] });

    const cleared = await store.update({ verify: { commands: [] } });
    expect(cleared.verify.commands).toEqual([]);
    expect(cleared.verify.review).toEqual({ enabled: false });
  });

  it('boots an existing config saved before guardrails existed, filling it from defaults (issue #126)', async () => {
    // An install that predates #126: the stored config has no `guardrails` key.
    const legacy: any = { ...defaultConfig() };
    delete legacy.guardrails;
    seedGlobal(legacy);

    const store = new ConfigStore(await SettingsStore.create(dir));
    expect(store.get().guardrails).toEqual(defaultConfig().guardrails);
  });

  it('persists an update to settings.yaml and a freshly-reopened store on the same dir reflects it', async () => {
    const store = new ConfigStore(await SettingsStore.create(dir));
    await store.update({ verify: { commands: [verificationCommandSchema.parse({ command: 'npm', args: ['test'] })] } });

    const reopened = new ConfigStore(await SettingsStore.create(dir));
    expect(reopened.get().verify.commands[0]).toMatchObject({ command: 'npm', args: ['test'] });
  });
});
