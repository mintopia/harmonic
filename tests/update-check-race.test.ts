import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { UpgradeCoordinator } from '../src/upgrade/upgrade-coordinator.js';
import { SettingsUpdateAvailabilityStore, UpdateCheck } from '../src/upgrade/update-check.js';

describe('UpdateCheck.run interleaved with an arm', () => {
  let dir: string;
  let h: AsyncDbHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-update-check-race-'));
    h = await openAsyncDb(dir);
  });

  afterEach(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not clobber a concurrent arm with the stale state it read before the arm landed', async () => {
    // The coordinator and the hourly update-check each get their own store
    // instance over the same DB, exactly as `buildApp` wires them.
    const updateCheckStore = new SettingsUpdateAvailabilityStore(h);
    const coordinatorStore = new SettingsUpdateAvailabilityStore(h);

    let config: AppConfig = baselineConfig();
    const coordinator = new UpgradeCoordinator({
      version: '2.0.0',
      store: coordinatorStore,
      settings: {
        getGlobal: () => config,
        updateGlobal: async (patch) => {
          config = { ...config, autoRunner: { ...config.autoRunner, ...patch.autoRunner } };
          return config;
        },
      },
      attempts: { countRunning: async () => 0 },
      operations: () => [],
      conversations: { hasInFlightTurn: () => false },
    });

    await updateCheckStore.set('2.6.0');

    // Interleave a real `arm()` right as `set()`'s write reaches the DB's
    // single-writer queue — an update-check write landing around a concurrent arm.
    const realWrite = h.write.bind(h);
    let interleaved = false;
    vi.spyOn(h, 'write').mockImplementation(async (fn, opts) => {
      if (!interleaved) {
        interleaved = true;
        await coordinator.arm();
      }
      return realWrite(fn, opts);
    });

    const updateCheck = new UpdateCheck({ version: '2.0.0', latest: async () => '2.7.0', store: updateCheckStore });
    await updateCheck.run();

    const finalState = await coordinator.state();
    expect(finalState.phase.kind).toBe('armed');
    expect(finalState.version).toBe('2.7.0');
    expect(config.autoRunner.enabled).toBe(false);
  });
});
