import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { settings } from '../src/db/schema.js';
import { ConfigStore } from '../src/server/config-store.js';
import { defaultConfig } from '../src/config.js';

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
});
