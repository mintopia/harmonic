import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { UpgradeCoordinator } from '../src/upgrade/upgrade-coordinator.js';
import { SettingsUpdateAvailabilityStore } from '../src/upgrade/update-check.js';
import { clearRollback, readRollback } from '../src/upgrade/boot-state.js';

describe('UpgradeCoordinator.settleOnBoot (real SettingsUpdateAvailabilityStore)', () => {
  let dir: string;
  let h: AsyncDbHandle;
  let store: SettingsUpdateAvailabilityStore;
  let config: AppConfig;
  let onIdleCalls: string[];
  let readRollback: () => { reason: string } | undefined;
  let clearRollbackCalls: number;

  function coordinator(runningVersion: string) {
    return new UpgradeCoordinator({
      version: runningVersion,
      store,
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
      onIdle: (version) => { onIdleCalls.push(version); },
      readRollback: () => readRollback(),
      clearRollback: () => { clearRollbackCalls += 1; },
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-settle-boot-'));
    h = await openAsyncDb(dir);
    store = new SettingsUpdateAvailabilityStore(h);
    config = { ...baselineConfig(), autoRunner: { ...baselineConfig().autoRunner, enabled: false } };
    onIdleCalls = [];
    clearRollbackCalls = 0;
    readRollback = () => undefined;
  });

  afterEach(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records failed with the rollback reason, restores the Auto-Runner, and never re-triggers the swap', async () => {
    await store.setState({
      version: '2.0.0',
      dismissedVersion: null,
      phase: { kind: 'upgrading', targetVersion: '2.0.0', autoRunnerWasEnabled: true },
    });
    readRollback = () => ({ reason: 'boot guard: exceeded 3 restarts within the window' });

    const upgrade = coordinator('1.0.0');
    const settled = await upgrade.settleOnBoot();

    expect(settled.phase).toMatchObject({
      kind: 'failed',
      targetVersion: '2.0.0',
      reason: 'boot guard: exceeded 3 restarts within the window',
    });
    expect((settled.phase as { at: string }).at).toEqual(expect.any(String));
    expect(config.autoRunner.enabled).toBe(true);
    expect(clearRollbackCalls).toBe(1);

    // reconcile() must never call onIdle for a failed phase.
    await expect(upgrade.reconcile()).resolves.toBe(false);
    expect(onIdleCalls).toEqual([]);

    // Manual launch is allowed again once failed.
    await expect(upgrade.assertManualLaunchAllowed()).resolves.toBeUndefined();

    // A second settle is a no-op.
    const resettled = await upgrade.settleOnBoot();
    expect(resettled).toEqual(settled);
    expect(clearRollbackCalls).toBe(1);
  });

  it('falls back to a generic reason when the boot guard left no rollback record', async () => {
    await store.setState({
      version: '2.0.0',
      dismissedVersion: null,
      phase: { kind: 'upgrading', targetVersion: '2.0.0', autoRunnerWasEnabled: true },
    });

    const upgrade = coordinator('1.0.0');
    const settled = await upgrade.settleOnBoot();

    expect(settled.phase).toMatchObject({ kind: 'failed', targetVersion: '2.0.0' });
    expect((settled.phase as { reason: string }).reason).toContain('2.0.0');
  });

  it('allows arming again from a failed phase', async () => {
    await store.setState({
      version: '2.0.0',
      dismissedVersion: null,
      phase: { kind: 'failed', targetVersion: '2.0.0', reason: 'boot guard rolled back', at: new Date(0).toISOString() },
    });

    const upgrade = coordinator('1.0.0');
    const armed = await upgrade.arm();

    expect(armed.phase).toMatchObject({ kind: 'armed', targetVersion: '2.0.0' });
  });

  it('settles cleanly and clears rollback when the boot landed on the armed target', async () => {
    await store.setState({
      version: '2.0.0',
      dismissedVersion: null,
      phase: { kind: 'upgrading', targetVersion: '2.0.0', autoRunnerWasEnabled: true },
    });

    const upgrade = coordinator('2.0.0');
    const settled = await upgrade.settleOnBoot();

    expect(settled.phase).toMatchObject({ kind: 'unarmed' });
    expect(config.autoRunner.enabled).toBe(true);
    expect(onIdleCalls).toEqual([]);
  });

  it('leaves an armed (not-yet-upgrading) phase untouched', async () => {
    await store.setState({
      version: '2.0.0',
      dismissedVersion: null,
      phase: { kind: 'armed', targetVersion: '2.0.0', autoRunnerWasEnabled: true },
    });

    const upgrade = coordinator('1.0.0');
    const settled = await upgrade.settleOnBoot();

    expect(settled.phase).toMatchObject({ kind: 'armed', targetVersion: '2.0.0' });
  });

  it('is a no-op when already unarmed', async () => {
    const upgrade = coordinator('1.0.0');
    const settled = await upgrade.settleOnBoot();

    expect(settled.phase).toMatchObject({ kind: 'unarmed' });
    expect(config.autoRunner.enabled).toBe(false);
  });
});

describe('UpgradeCoordinator.settleOnBoot wired to the real boot-state readRollback/clearRollback', () => {
  let dir: string;
  let h: AsyncDbHandle;
  let store: SettingsUpdateAvailabilityStore;
  let config: AppConfig;
  let appDir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-settle-boot-real-rollback-'));
    h = await openAsyncDb(dir);
    store = new SettingsUpdateAvailabilityStore(h);
    config = { ...baselineConfig(), autoRunner: { ...baselineConfig().autoRunner, enabled: false } };
    appDir = join(dir, 'app');
    mkdirSync(appDir, { recursive: true });
  });

  afterEach(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the rollback.json reason as failed and removes rollback.json, when upgrading v2 while running v1', async () => {
    const record = { fromVersion: '1.0.0', toVersion: '2.0.0', at: new Date().toISOString(), reason: 'boot guard: exceeded 3 restarts within the window', databaseRestored: true };
    writeFileSync(join(appDir, 'rollback.json'), JSON.stringify(record));
    await store.setState({
      version: '2.0.0',
      dismissedVersion: null,
      phase: { kind: 'upgrading', targetVersion: '2.0.0', autoRunnerWasEnabled: true },
    });

    const upgrade = new UpgradeCoordinator({
      version: '1.0.0',
      store,
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
      readRollback: () => readRollback({ appDir }) ?? undefined,
      clearRollback: () => { clearRollback({ appDir }); },
    });

    const settled = await upgrade.settleOnBoot();

    expect(settled.phase).toMatchObject({ kind: 'failed', targetVersion: '2.0.0', reason: record.reason });
    expect(config.autoRunner.enabled).toBe(true);
    expect(existsSync(join(appDir, 'rollback.json'))).toBe(false);
  });
});
