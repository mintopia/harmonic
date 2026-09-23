import { describe, expect, it } from 'vitest';

/** The idle handoff now runs outside `exclusively`, kicked off via
 * `setImmediate` after `reconcile()`/`arm()` resolves; wait a tick for it (and
 * any failure-recovery cancel chained off it) to settle before asserting. */
function flushHandoff(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
import { SpanStatusCode } from '@opentelemetry/api';
import { baselineConfig, type AppConfig } from '../src/config.js';
import type { OperationSnapshot } from '../src/telemetry/operations.js';
import { UpgradeCoordinator, type UpgradeCancellation, type UpgradeIdleHandoffOutcome } from '../src/upgrade/upgrade-coordinator.js';
import { UpgradeSwap } from '../src/upgrade/upgrade-swap.js';
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
  runningVersion?: string;
  autoRunnerEnabled?: boolean;
  runningAttempts?: number;
  conversationMidTurn?: boolean;
  operations?: OperationSnapshot[];
  onIdle?: (version: string, cancellation: UpgradeCancellation) => Promise<UpgradeIdleHandoffOutcome | void> | UpgradeIdleHandoffOutcome | void;
  migrationRequired?: boolean;
  armedVersion?: string | null;
} = {}) {
  let config: AppConfig = { ...baselineConfig(), autoRunner: { ...baselineConfig().autoRunner, enabled: input.autoRunnerEnabled ?? true } };
  const phase: UpdateAvailabilityState['phase'] = input.armedVersion == null
    ? { kind: 'unarmed' }
    : { kind: 'armed', targetVersion: input.armedVersion, autoRunnerWasEnabled: true };
  const store = new MemoryStore({ version: input.version ?? '2.6.0', dismissedVersion: null, phase });
  let runningAttempts = input.runningAttempts ?? 0;
  let conversationMidTurn = input.conversationMidTurn ?? false;
  let operations = input.operations ?? [];
  const upgrade = new UpgradeCoordinator({
    version: input.runningVersion ?? '2.0.0',
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
    migrationRequired: input.migrationRequired,
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
  it('refuses to arm an upgrade until a legacy systemd install is migrated', async () => {
    const subject = coordinator({ migrationRequired: true });

    await expect(subject.upgrade.arm()).rejects.toThrow(
      "Upgrading from the app is off until you re-run sudo harmonic install, which reuses this service's existing port, host, data directory, and password.",
    );
    await expect(subject.upgrade.migrationRequired()).resolves.toBe(true);
    expect(subject.config().autoRunner.enabled).toBe(true);
  });

  it('cancels an upgrade armed before a legacy systemd layout was detected', async () => {
    const subject = coordinator({ migrationRequired: true, armedVersion: '2.6.0' });

    await expect(subject.upgrade.reconcile()).resolves.toBe(false);
    await expect(subject.upgrade.state()).resolves.toMatchObject({ phase: { kind: 'unarmed' } });
    expect(subject.config().autoRunner.enabled).toBe(true);
  });

  it('dismisses only the current offered version without changing the master switch', async () => {
    const subject = coordinator();

    await expect(subject.upgrade.dismiss()).resolves.toMatchObject({ dismissedVersion: '2.6.0' });
    expect(subject.config().autoRunner.enabled).toBe(true);
  });

  it('pins the offered version, turns off the master switch, and restores its prior value on cancel', async () => {
    const subject = coordinator();

    await expect(subject.upgrade.arm()).resolves.toMatchObject({ phase: { kind: 'armed', targetVersion: '2.6.0', autoRunnerWasEnabled: true } });
    expect(subject.config().autoRunner.enabled).toBe(false);

    await expect(subject.upgrade.cancel()).resolves.toMatchObject({ phase: { kind: 'unarmed' } });
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
    await flushHandoff();
    expect(ready).toEqual(['2.6.0']);
    await subject.upgrade.reconcile();
    expect(ready).toEqual(['2.6.0']);
  });

  it('treats a namespaced epic.* operation (integrate, merge, verify, ...) as busy, not just the bare merge/integrate types', async () => {
    const epicIntegrate: OperationSnapshot = {
      type: 'epic.integrate', name: 'harmonic.epic.integrate', spanContext: { traceId: 'trace', spanId: 'span', traceFlags: 0 }, parentSpanContext: undefined, attributes: {}, startedAt: 0, status: { code: SpanStatusCode.UNSET },
    };
    const subject = coordinator({ operations: [epicIntegrate] });

    await expect(subject.upgrade.idleState()).resolves.toMatchObject({ mergingOrIntegrating: true });
  });

  it('records the real upgrade-in-progress state before handing the swap to the service manager', async () => {
    let release: (() => void) | undefined;
    const handoff = new Promise<void>((resolve) => { release = resolve; });
    let entered: (() => void) | undefined;
    const enteredHandoff = new Promise<void>((resolve) => { entered = resolve; });
    const subject = coordinator({ onIdle: async () => { entered?.(); return handoff; } });

    const arm = subject.upgrade.arm();
    await expect(arm).resolves.toMatchObject({ phase: { kind: 'armed', targetVersion: '2.6.0' } });
    await enteredHandoff;
    await expect(subject.upgrade.state()).resolves.toMatchObject({ phase: { kind: 'upgrading', targetVersion: '2.6.0' } });

    release?.();
  });

  it('unarms and restores the master switch when the idle handoff fails', async () => {
    const subject = coordinator({ onIdle: () => { throw new Error('install failed'); } });

    await subject.upgrade.arm();
    await subject.upgrade.reconcile();
    await flushHandoff();

    await expect(subject.upgrade.state()).resolves.toEqual({
      version: '2.6.0',
      dismissedVersion: null,
      phase: { kind: 'unarmed' },
    });
    expect(subject.config().autoRunner.enabled).toBe(true);
  });

  it('does not hand off an upgrade after cancellation wins the arm race', async () => {
    const handoffs: string[] = [];
    const subject = coordinator({ onIdle: (version) => { handoffs.push(version); } });

    await subject.upgrade.arm();
    await subject.upgrade.cancel();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(handoffs).toEqual([]);
    await expect(subject.upgrade.state()).resolves.toMatchObject({ phase: { kind: 'unarmed' } });
  });

  it('leaves an armed-but-not-yet-upgrading offer untouched on boot', async () => {
    const subject = coordinator({ runningVersion: '2.0.0' });
    await subject.upgrade.arm();

    await expect(subject.upgrade.settleOnBoot()).resolves.toMatchObject({ phase: { kind: 'armed', targetVersion: '2.6.0' } });
    expect(subject.config().autoRunner.enabled).toBe(false);
  });
});

describe('UpgradeCoordinator.waitForIdle', () => {
  it('polls until in-flight work drains instead of proceeding immediately', async () => {
    const subject = coordinator({ runningAttempts: 1 });
    let sleeps = 0;
    const sleep = async (): Promise<void> => {
      sleeps += 1;
      if (sleeps === 3) subject.setRunningAttempts(0);
    };

    await expect(subject.upgrade.waitForIdle({ sleep, timeoutMs: 60_000 })).resolves.toBe(true);

    expect(sleeps).toBe(3);
    await expect(subject.upgrade.idleState()).resolves.toMatchObject({ runningAttempts: 0 });
  });

  it('gives up once the bound elapses instead of waiting forever for work that never drains', async () => {
    const subject = coordinator({ runningAttempts: 1 });
    let now = 0;
    const sleep = async (ms: number): Promise<void> => { now += ms; };

    // Returns false — not just "returns" — a running Attempt at the deadline must
    // signal the swap to abort before commit rather than let it proceed silently.
    await expect(subject.upgrade.waitForIdle({ sleep, now: () => now, timeoutMs: 5_000, pollMs: 1_000 })).resolves.toBe(false);

    await expect(subject.upgrade.idleState()).resolves.toMatchObject({ runningAttempts: 1 });
  });
});

/** Wires a real `UpgradeSwap` through the coordinator's `onIdle`, matching
 * cli-serve.ts's production wiring, so cancellation/idle-timeout tests exercise
 * the real step boundaries instead of a coordinator-only fake. */
function realSwapOnIdle(
  calls: string[],
  hooks: { install?: () => Promise<void>; commit?: () => Promise<void>; waitForIdle?: () => Promise<boolean> },
) {
  return async (version: string, cancellation: UpgradeCancellation): Promise<UpgradeIdleHandoffOutcome | void> => {
    const swap = new UpgradeSwap({
      cancellation,
      install: async () => { calls.push('install'); await hooks.install?.(); },
      verify: async () => { calls.push('verify'); },
      commit: async () => { calls.push('commit'); await hooks.commit?.(); },
      spawnRelauncher: async () => { calls.push('relauncher'); },
      releaseLock: async () => { calls.push('release-lock'); },
      exit: () => { calls.push('exit'); },
      abort: async () => { calls.push('abort'); },
      operation: async (_input, work) => work(),
      log: () => {},
      ...(hooks.waitForIdle ? { waitForIdle: hooks.waitForIdle } : {}),
    });
    const outcome = await swap.execute({ version });
    if (outcome.kind === 'aborted') throw outcome.error;
    if (outcome.kind === 'cancelled' || outcome.kind === 'idle-timeout') return outcome.kind;
  };
}

describe('UpgradeCoordinator cancellation (ADR-0042 Cancel vs commit)', () => {
  it('rejects a second arm with 409 while a swap is upgrading, before any cancel', async () => {
    const calls: string[] = [];
    let releaseInstall: (() => void) | undefined;
    const installPaused = new Promise<void>((resolve) => { releaseInstall = resolve; });
    const subject = coordinator({ onIdle: realSwapOnIdle(calls, { install: () => installPaused }) });

    await subject.upgrade.arm();
    await subject.upgrade.reconcile();
    await flushHandoff();
    expect(calls).toEqual(['install']);

    await expect(subject.upgrade.arm()).rejects.toThrow('upgrade is already switching versions');

    releaseInstall?.();
  });

  it('stops the swap before commit when cancelled during install, restoring unarmed state without ever committing', async () => {
    const calls: string[] = [];
    let releaseInstall: (() => void) | undefined;
    const installPaused = new Promise<void>((resolve) => { releaseInstall = resolve; });
    const subject = coordinator({ onIdle: realSwapOnIdle(calls, { install: () => installPaused }) });

    await subject.upgrade.arm();
    await subject.upgrade.reconcile();
    await flushHandoff();
    expect(calls).toEqual(['install']);

    await expect(subject.upgrade.cancel()).resolves.toMatchObject({ phase: { kind: 'upgrading' } });

    releaseInstall?.();
    await flushHandoff();
    await flushHandoff();

    expect(calls).toEqual(['install', 'verify']);
    expect(calls).not.toContain('commit');
    await expect(subject.upgrade.state()).resolves.toMatchObject({ phase: { kind: 'unarmed' } });
    expect(subject.config().autoRunner.enabled).toBe(true);
  });

  it('rejects cancel with 409 once commit has already started, and does not stop the commit', async () => {
    const calls: string[] = [];
    let releaseCommit: (() => void) | undefined;
    const commitPaused = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const subject = coordinator({ onIdle: realSwapOnIdle(calls, { commit: () => commitPaused }) });

    await subject.upgrade.arm();
    await subject.upgrade.reconcile();
    await flushHandoff();
    expect(calls).toEqual(['install', 'verify', 'commit']);

    await expect(subject.upgrade.cancel()).rejects.toThrow('upgrade is already switching versions');

    releaseCommit?.();
    await flushHandoff();
    expect(calls).toContain('release-lock');
  });
});

describe('UpgradeCoordinator idle-timeout (ADR-0042 Cancel vs commit, waitForIdle bound)', () => {
  it('reverts upgrading to armed — not unarmed — and never commits when waitForIdle times out on work that never drains', async () => {
    const calls: string[] = [];
    // Idle when arm()/reconcile() start the swap (so it isn't blocked before even
    // starting); a new running Attempt starts during install, simulating work
    // beginning right as the swap kicks off, so it's still running once the swap
    // reaches its bounded await-idle wait.
    let firstAttempt = true;
    const subject = coordinator({
      onIdle: (version, cancellation) =>
        realSwapOnIdle(calls, {
          install: async () => { if (firstAttempt) { firstAttempt = false; subject.setRunningAttempts(1); } },
          waitForIdle: () => subject.upgrade.waitForIdle({ timeoutMs: 30, pollMs: 5 }),
        })(version, cancellation),
    });

    await subject.upgrade.arm();
    await subject.upgrade.reconcile();
    await flushHandoff();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(calls).toEqual(['install', 'verify', 'abort']);
    expect(calls).not.toContain('commit');
    await expect(subject.upgrade.state()).resolves.toMatchObject({ phase: { kind: 'armed', targetVersion: '2.6.0' } });
    // Still excluded: armed keeps the Auto-Runner off until the retry succeeds.
    expect(subject.config().autoRunner.enabled).toBe(false);

    subject.setRunningAttempts(0);
    calls.length = 0;
    await expect(subject.upgrade.reconcile()).resolves.toBe(true);
    await flushHandoff();
    expect(calls).toEqual(['install', 'verify', 'commit', 'relauncher', 'release-lock', 'exit']);
  });
});
