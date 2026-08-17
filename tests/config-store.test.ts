import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { settings } from '../src/db/schema.js';
import { ConfigStore } from '../src/server/config-store.js';
import { defaultConfig, verificationCommandSchema } from '../src/config.js';

describe('ConfigStore', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-config-'));
    db = openDb(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('boots a config saved before a field existed, filling it from defaults', () => {
    // A config persisted by an older build — no `drive` key at all.
    const legacy: any = { ...defaultConfig() };
    delete legacy.drive;
    db.insert(settings).values({ key: 'config', value: JSON.stringify(legacy) }).run();

    // A bare parse would throw here; the overlay-on-defaults boot must not.
    const store = new ConfigStore(db);
    expect(store.get().drive).toEqual(defaultConfig().drive);
  });

  it('boots a stored config that still contains a legacy tracker block, dropping it (ADR-0014)', () => {
    const withTracker: any = { ...defaultConfig(), tracker: { enabled: true, pollIntervalSeconds: 30 } };
    db.insert(settings).values({ key: 'config', value: JSON.stringify(withTracker) }).run();

    const store = new ConfigStore(db);
    expect(store.get()).not.toHaveProperty('tracker');
  });

  it('boots an existing config saved before verification existed, defaulting to no verifiers (issue #132)', () => {
    // An install that predates #132: the stored config has no `verification` key.
    const legacy: any = { ...defaultConfig() };
    delete legacy.verification;
    db.insert(settings).values({ key: 'config', value: JSON.stringify(legacy) }).run();

    const store = new ConfigStore(db);
    // Default resolution yields "no verifiers" — an existing Run's outcome is unchanged.
    expect(store.get().verification).toEqual({ command: null, critic: null });
  });

  it('clears a configured verifier back to null via PATCH without crashing on the null override (issue #132)', () => {
    // A null override deep-merged onto a configured object used to hit
    // `Object.keys(null)` in mergeConfig; the fix short-circuits a null b.
    const store = new ConfigStore(db);
    const set = store.update({ verification: { command: verificationCommandSchema.parse({ command: 'npm', args: ['test'] }) } });
    expect(set.verification.command).toMatchObject({ command: 'npm', args: ['test'] });

    const cleared = store.update({ verification: { command: null } });
    expect(cleared.verification.command).toBeNull();
    expect(cleared.verification.critic).toBeNull(); // untouched, still its default
  });

  it('boots an existing config saved before guardrails existed, filling it from defaults (issue #126)', () => {
    // An install that predates #126: the stored config has no `guardrails` key.
    const legacy: any = { ...defaultConfig() };
    delete legacy.guardrails;
    db.insert(settings).values({ key: 'config', value: JSON.stringify(legacy) }).run();

    const store = new ConfigStore(db);
    expect(store.get().guardrails).toEqual(defaultConfig().guardrails);
  });
});
