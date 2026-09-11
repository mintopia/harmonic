import { describe, expect, it } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { baselineConfig, type AppConfig } from '../src/config.js';
import type { OperationSnapshot } from '../src/telemetry/operations.js';
import { UpgradeCoordinator } from '../src/upgrade/upgrade-coordinator.js';
import type { UpdateArmingStore, UpdateAvailabilityState } from '../src/upgrade/update-check.js';

class MemoryStore implements UpdateArmingStore {
  constructor(private value: UpdateAvailabilityState) {}

  async get(): Promise<string | null> { return this.value.version; }
  async set(version: string | null): Promise<void> { this.value = { ...this.value, version }; }
  async getState(): Promise<UpdateAvailabilityState> { return this.value; }
  async setState(state: UpdateAvailabilityState): Promise<void> { this.value = state; }
}

function coordinator(input: {
  version?: string | null;
  autoRunnerEnabled?: boolean;
  runningAttempts?: number;
  conversationMidTurn?: boolean;
  operations?: OperationSnapshot[];
  onIdle?: (version: string) => void;
} = {}) {
  let config: AppConfig = { ...baselineConfig(), autoRunner: { ...baselineConfig().autoRunner, enabled: input.autoRunnerEnabled ?? true } };
  const store = new MemoryStore({ version: input.version ?? '2.6.0', armedVersion: null, autoRunnerWasEnabled: null, dismissedVersion: null });
  let runningAttempts = input.runningAttempts ?? 0;
  let conversationMidTurn = input.conversationMidTurn ?? false;
  let operations = input.operations ?? [];
  const upgrade = new UpgradeCoordinator({
    store,
    settings: {
      getGlobal: () => config,
      updateGlobal: async (patch) => {
        config = { ...config, autoRunner: { ...config.autoRunner, ...patch.autoRunner } };
        return config;
      },
    },
    attempts: { countRunning: async () => runningAttempts },
    operations: () => operations,
    conversations: { hasInFlightTurn: () => conversationMidTurn },
    onIdle: input.onIdle,
  });
  return {
    upgrade,
    config: () => config,
    setRunningAttempts: (count: number) => { runningAttempts = count; },
    setConversationMidTurn: (value: boolean) => { conversationMidTurn = value; },
    setOperations: (value: OperationSnapshot[]) => { operations = value; },
  };
}

describe('UpgradeCoordinator', () => {
  it('dismisses only the current offered version without changing the master switch', async () => {
    const subject = coordinator();

    await expect(subject.upgrade.dismiss()).resolves.toMatchObject({ dismissedVersion: '2.6.0' });
    expect(subject.config().autoRunner.enabled).toBe(true);
  });

  it('pins the offered version, turns off the master switch, and restores its prior value on cancel', async () => {
    const subject = coordinator();

    await expect(subject.upgrade.arm()).resolves.toMatchObject({ armedVersion: '2.6.0', autoRunnerWasEnabled: true });
    expect(subject.config().autoRunner.enabled).toBe(false);

    await expect(subject.upgrade.cancel()).resolves.toMatchObject({ armedVersion: null, autoRunnerWasEnabled: null });
    expect(subject.config().autoRunner.enabled).toBe(true);
  });

  it('does not turn on an Auto-Runner that was already disabled', async () => {
    const subject = coordinator({ autoRunnerEnabled: false });

    await subject.upgrade.arm();
    await subject.upgrade.cancel();

    expect(subject.config().autoRunner.enabled).toBe(false);
  });

  it('keeps the original master-switch value when arm requests overlap', async () => {
    const subject = coordinator();

    await Promise.all([subject.upgrade.arm(), subject.upgrade.arm()]);
    await subject.upgrade.cancel();

    expect(subject.config().autoRunner.enabled).toBe(true);
  });

  it('reconciles only after every attempt, merge/integrate operation, and conversation turn has drained', async () => {
    const ready: string[] = [];
    const merge: OperationSnapshot = {
      type: 'merge', name: 'harmonic.merge', spanContext: { traceId: 'trace', spanId: 'span', traceFlags: 0 }, parentSpanContext: undefined, attributes: {}, startedAt: 0, status: { code: SpanStatusCode.UNSET },
    };
    const subject = coordinator({ runningAttempts: 1, conversationMidTurn: true, operations: [merge], onIdle: (version) => { ready.push(version); } });
    await subject.upgrade.arm();

    expect(ready).toEqual([]);
    subject.setRunningAttempts(0);
    subject.setConversationMidTurn(false);
    expect(await subject.upgrade.reconcile()).toBe(false);
    subject.setOperations([]);
    expect(await subject.upgrade.reconcile()).toBe(true);
    expect(ready).toEqual(['2.6.0']);
    await subject.upgrade.reconcile();
    expect(ready).toEqual(['2.6.0']);
  });

  it('unarms and restores the master switch when the idle handoff fails', async () => {
    const subject = coordinator({ onIdle: () => { throw new Error('install failed'); } });

    await subject.upgrade.arm();

    await expect(subject.upgrade.state()).resolves.toEqual({
      version: '2.6.0',
      armedVersion: null,
      autoRunnerWasEnabled: null,
    });
    expect(subject.config().autoRunner.enabled).toBe(true);
  });
});
