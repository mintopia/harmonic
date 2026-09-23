import { DomainError } from '../domain/errors.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { SettingsStore } from '../server/settings-store.js';
import type { OperationSnapshot } from '../telemetry/operations.js';
import type { ConversationDriver } from '../execution/conversation-driver.js';
import { reportFailure } from '../error-handling.js';
import { logger } from '../logger.js';
import { singleFlight } from '../reliability/single-flight.js';
import type { UpdateArmingStore, UpdateAvailabilityState, UpdatePhase } from './update-check.js';

export interface UpgradeIdleState {
  runningAttempts: number;
  mergingOrIntegrating: boolean;
  conversationMidTurn: boolean;
}

/** Reported by `onIdle` when the swap stopped short of commit instead of
 * completing: `cancelled` unarms outright; `idle-timeout` (waitForIdle's
 * bound elapsed with work still running, ADR-0042) re-arms so the next idle
 * window retries instead of losing the offer. `undefined`/no return means the
 * swap ran to completion (in production this exits the process). */
export type UpgradeIdleHandoffOutcome = 'cancelled' | 'idle-timeout';

export interface UpgradeCoordinatorOptions {
  /** The version this process is running; an armed upgrade to it has taken effect. */
  version: string;
  store: UpdateArmingStore;
  settings: Pick<SettingsStore, 'getGlobal' | 'updateGlobal'>;
  attempts: Pick<AttemptStore, 'countRunning'>;
  operations: () => readonly OperationSnapshot[];
  conversations: Pick<ConversationDriver, 'hasInFlightTurn'>;
  onIdle?: (version: string, cancellation: UpgradeCancellation) => Promise<UpgradeIdleHandoffOutcome | void> | UpgradeIdleHandoffOutcome | void;
  migrationRequired?: boolean;
  /** Set when this install mode can never self-upgrade (npx, npm-global, unknown); arming is refused. */
  externalInstall?: boolean;
  /** Reads `app/rollback.json` written by the boot guard, if the last boot rolled back or was
   * blocked from doing so. `rolledBack: false` means the guard left the failed release running
   * because it couldn't restore the database (ADR-0042). */
  readRollback?: () => { reason: string; rolledBack?: boolean } | null | undefined;
  clearRollback?: () => void;
}

export const SYSTEMD_MIGRATION_NOTICE =
  "Upgrading from the app is off until you re-run sudo harmonic install, which reuses this service's existing port, host, data directory, and password.";

export const EXTERNAL_INSTALL_NOTICE = "This install can't upgrade itself; run the command in the update banner.";

export const UPGRADE_ALREADY_SWITCHING_NOTICE = 'upgrade is already switching versions';

/** Coordinates a Cancel request against the in-flight swap's step boundaries
 * (install/verify/await-idle/commit, ADR-0042). Created fresh for each
 * `upgrading` phase; the swap consults it before await-idle, after
 * await-idle, and immediately before commit. */
export class UpgradeCancellation {
  private phase: 'pending' | 'cancelled' | 'committing' = 'pending';

  /** Checked by the swap before and after await-idle: false means a cancel
   * got in first and the swap must stop instead of continuing toward commit. */
  shouldContinue(): boolean {
    return this.phase !== 'cancelled';
  }

  /** Checked by the swap immediately before commit. Returning true latches
   * out any later cancellation — commit is irreversible once entered.
   * Returning false means a cancel already won; the swap must stop instead. */
  enterCommit(): boolean {
    if (this.phase === 'cancelled') return false;
    this.phase = 'committing';
    return true;
  }

  /** Called by cancel(): true once accepted (the swap will stop before commit,
   * eventually — never block on that here), false once commit already
   * started, meaning the caller must reject instead. Idempotent once cancelled. */
  requestCancel(): boolean {
    if (this.phase === 'committing') return false;
    this.phase = 'cancelled';
    return true;
  }

  /** True once cancellation won the race against commit. */
  wasCancelled(): boolean {
    return this.phase === 'cancelled';
  }
}

/** Durable arming state for an offered in-place upgrade. */
export class UpgradeCoordinator {
  private transitions: Promise<void> = Promise.resolve();
  private readonly reconcileIdle = singleFlight(() => this.reconcileOnce());
  /** The in-flight swap's cancellation token, set for the duration of `upgrading`. */
  private activeCancellation: UpgradeCancellation | null = null;

  constructor(private readonly options: UpgradeCoordinatorOptions) {}

  state(): Promise<UpdateAvailabilityState> {
    return this.options.store.getState();
  }

  arm(): Promise<UpdateAvailabilityState> {
    return this.exclusively(() => this.armOnce());
  }

  async migrationRequired(): Promise<boolean> {
    return this.options.migrationRequired === true;
  }

  dismiss(): Promise<UpdateAvailabilityState> {
    return this.exclusively(() => this.dismissOnce());
  }

  private async dismissOnce(): Promise<UpdateAvailabilityState> {
    const current = await this.options.store.getState();
    if (current.version === null || current.phase.kind !== 'unarmed') return current;
    const dismissed = { ...current, dismissedVersion: current.version };
    await this.options.store.setState(dismissed);
    return dismissed;
  }

  private async armOnce(): Promise<UpdateAvailabilityState> {
    if (this.options.migrationRequired) throw new DomainError('invalid_state', SYSTEMD_MIGRATION_NOTICE);
    if (this.options.externalInstall) throw new DomainError('invalid_state', EXTERNAL_INSTALL_NOTICE);
    const current = await this.options.store.getState();
    if (current.phase.kind === 'upgrading') throw new DomainError('conflict', UPGRADE_ALREADY_SWITCHING_NOTICE);
    if (current.phase.kind !== 'unarmed' && current.phase.kind !== 'failed') return current;
    if (current.version === null) throw new DomainError('invalid_state', 'there is no available update to arm');

    const targetVersion = current.version;
    const autoRunnerWasEnabled = this.options.settings.getGlobal().autoRunner.enabled;
    await this.options.settings.updateGlobal({ autoRunner: { enabled: false } });
    try {
      const armed: UpdateAvailabilityState = {
        version: current.version,
        dismissedVersion: current.dismissedVersion,
        phase: { kind: 'armed', targetVersion, autoRunnerWasEnabled },
      };
      await this.options.store.setState(armed);
      setImmediate(() => this.reconcileAfterArming(targetVersion));
      return armed;
    } catch (error) {
      await this.options.settings.updateGlobal({ autoRunner: { enabled: autoRunnerWasEnabled } });
      throw error;
    }
  }

  cancel(): Promise<UpdateAvailabilityState> {
    return this.exclusively(() => this.cancelOnce());
  }

  /** `armed`: unarms immediately. `upgrading`: only requests cancellation on the in-flight
   * swap's token without blocking for it to stop (ADR-0042); the swap unarms itself once it
   * notices. Once commit has started this rejects with 409. */
  private async cancelOnce(): Promise<UpdateAvailabilityState> {
    const current = await this.options.store.getState();
    if (current.phase.kind === 'unarmed' || current.phase.kind === 'failed') return current;
    if (current.phase.kind === 'upgrading') {
      if (this.activeCancellation === null || !this.activeCancellation.requestCancel()) {
        throw new DomainError('conflict', UPGRADE_ALREADY_SWITCHING_NOTICE);
      }
      return current;
    }
    return this.finishUnarm(current, current.phase.autoRunnerWasEnabled);
  }

  private async finishUnarm(current: UpdateAvailabilityState, autoRunnerWasEnabled: boolean): Promise<UpdateAvailabilityState> {
    const cancelled: UpdateAvailabilityState = {
      version: current.version,
      dismissedVersion: current.dismissedVersion,
      phase: { kind: 'unarmed' },
    };
    await this.options.store.setState(cancelled);
    try {
      await this.options.settings.updateGlobal({ autoRunner: { enabled: autoRunnerWasEnabled } });
      return cancelled;
    } catch (error) {
      await this.options.store.setState(current);
      throw error;
    }
  }

  /** Force-unarms an `upgrading` phase once the swap has stopped short of commit (cancelled or
   * threw). A no-op if something else already resolved the phase. */
  private async unarmUpgradingOnce(): Promise<void> {
    const current = await this.options.store.getState();
    if (current.phase.kind !== 'upgrading') return;
    await this.finishUnarm(current, current.phase.autoRunnerWasEnabled);
  }

  private unarmUpgrading(): Promise<void> {
    return this.exclusively(() => this.unarmUpgradingOnce());
  }

  /** Runs when `waitForIdle` timed out with work still running: reverts `upgrading` back to
   * `armed` so a later `reconcile` retries the same target. */
  private async settleIdleTimeoutOnce(): Promise<void> {
    const current = await this.options.store.getState();
    if (current.phase.kind !== 'upgrading') return;
    const armed: UpdateAvailabilityState = {
      version: current.version,
      dismissedVersion: current.dismissedVersion,
      phase: { kind: 'armed', targetVersion: current.phase.targetVersion, autoRunnerWasEnabled: current.phase.autoRunnerWasEnabled },
    };
    await this.options.store.setState(armed);
  }

  private settleIdleTimeout(): Promise<void> {
    return this.exclusively(() => this.settleIdleTimeoutOnce());
  }

  settleOnBoot(): Promise<UpdateAvailabilityState> {
    return this.exclusively(() => this.settleOnBootOnce());
  }

  /** Runs once at boot: dispatches to `settleUpgraded` or `settleFailed` depending on whether
   * the running version matches the armed target. */
  private async settleOnBootOnce(): Promise<UpdateAvailabilityState> {
    const current = await this.options.store.getState();
    const phase = current.phase;
    if (phase.kind !== 'upgrading') return current;
    if (phase.targetVersion === this.options.version) return this.settleUpgraded(current, phase);
    return this.settleFailed(current, phase);
  }

  private async settleUpgraded(current: UpdateAvailabilityState, phase: Extract<UpdatePhase, { kind: 'upgrading' }>): Promise<UpdateAvailabilityState> {
    const rollback = this.options.readRollback?.();
    if (rollback !== null && rollback !== undefined && rollback.rolledBack === false) {
      return this.settleBlockedRollbackOnMatchingVersion(current, phase, rollback);
    }
    const settled: UpdateAvailabilityState = { version: current.version, dismissedVersion: current.dismissedVersion, phase: { kind: 'unarmed' } };
    await this.options.store.setState(settled);
    try {
      await this.options.settings.updateGlobal({ autoRunner: { enabled: phase.autoRunnerWasEnabled } });
      return settled;
    } catch (error) {
      await this.options.store.setState(current);
      throw error;
    }
  }

  /** Running version matches the armed target, but the last rollback attempt was blocked;
   * reports via the `failed` phase and clears `rollback.json` so it's reported once. */
  private async settleBlockedRollbackOnMatchingVersion(
    current: UpdateAvailabilityState,
    phase: Extract<UpdatePhase, { kind: 'upgrading' }>,
    rollback: { reason: string },
  ): Promise<UpdateAvailabilityState> {
    const reason = `the upgrade to ${phase.targetVersion} completed after a blocked rollback attempt; the database was not restored (${rollback.reason})`;
    logger.warn(reason);
    const failed: UpdateAvailabilityState = {
      version: current.version,
      dismissedVersion: current.dismissedVersion,
      phase: { kind: 'failed', targetVersion: phase.targetVersion, reason, at: new Date().toISOString() },
    };
    await this.options.store.setState(failed);
    try {
      await this.options.settings.updateGlobal({ autoRunner: { enabled: phase.autoRunnerWasEnabled } });
    } catch (error) {
      reportFailure(error, {
        op: 'upgradeCoordinator.settleOnBoot.restoreAutoRunner',
        level: 'error',
        context: { targetVersion: phase.targetVersion },
      });
    }
    this.options.clearRollback?.();
    return failed;
  }

  private async settleFailed(current: UpdateAvailabilityState, phase: Extract<UpdatePhase, { kind: 'upgrading' }>): Promise<UpdateAvailabilityState> {
    const rollback = this.options.readRollback?.();
    const failed: UpdateAvailabilityState = {
      version: current.version,
      dismissedVersion: current.dismissedVersion,
      phase: {
        kind: 'failed',
        targetVersion: phase.targetVersion,
        reason: rollback?.reason ?? `expected to be running ${phase.targetVersion} after the upgrade, still running ${this.options.version}`,
        at: new Date().toISOString(),
      },
    };
    await this.options.store.setState(failed);
    try {
      await this.options.settings.updateGlobal({ autoRunner: { enabled: phase.autoRunnerWasEnabled } });
    } catch (error) {
      reportFailure(error, {
        op: 'upgradeCoordinator.settleOnBoot.restoreAutoRunner',
        level: 'error',
        context: { targetVersion: phase.targetVersion },
      });
    }
    this.options.clearRollback?.();
    return failed;
  }

  async idleState(): Promise<UpgradeIdleState> {
    const runningAttempts = await this.options.attempts.countRunning();
    // Whole-Epic work is namespaced `epic.*`, not the bare `merge`/`integrate`; both count as busy.
    const mergingOrIntegrating = this.options.operations().some(
      (operation) => operation.type === 'merge' || operation.type === 'integrate' || operation.type.startsWith('epic.'),
    );
    return { runningAttempts, mergingOrIntegrating, conversationMidTurn: this.options.conversations.hasInFlightTurn() };
  }

  private static isIdle(state: UpgradeIdleState): boolean {
    return state.runningAttempts === 0 && !state.mergingOrIntegrating && !state.conversationMidTurn;
  }

  /** Bounded, yielding wait for in-flight work to drain. Never throws; returns whether idle was
   * actually reached — `false` means the swap must abort before commit. */
  async waitForIdle({
    timeoutMs = 10 * 60_000,
    pollMs = 1_000,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }),
  }: { timeoutMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
    const deadline = now() + timeoutMs;
    for (;;) {
      const idle = await this.idleState();
      if (UpgradeCoordinator.isIdle(idle)) return true;
      if (now() >= deadline) return false;
      await sleep(pollMs);
    }
  }

  reconcile(): Promise<boolean> {
    return this.exclusively(() => this.reconcileIdle());
  }

  /** Transitions `armed` -> `upgrading` and kicks off the handoff under the lock; the handoff
   * itself runs after this returns, so the lock never blocks a request for the swap's duration.
   * An already-`upgrading` phase is a no-op. */
  private async reconcileOnce(): Promise<boolean> {
    const armed = await this.options.store.getState();
    if (armed.phase.kind === 'unarmed' || armed.phase.kind === 'failed') return false;
    if (this.options.migrationRequired) {
      await this.cancelOnce();
      return false;
    }
    if (armed.phase.kind === 'upgrading') return true;
    const targetVersion = armed.phase.targetVersion;
    const idle = await this.idleState();
    if (idle.runningAttempts !== 0 || idle.mergingOrIntegrating || idle.conversationMidTurn) return false;
    await this.options.store.setState({ ...armed, phase: { ...armed.phase, kind: 'upgrading' } });
    const cancellation = new UpgradeCancellation();
    this.activeCancellation = cancellation;
    setImmediate(() => this.runIdleHandoff(targetVersion, cancellation));
    return true;
  }

  /** Runs `onIdle` (the real swap) outside the `exclusively` lock, in a fresh task. A
   * `cancelled` or `idle-timeout` return settles the phase the swap stopped short of finishing. */
  private runIdleHandoff(targetVersion: string, cancellation: UpgradeCancellation): void {
    void (async () => {
      try {
        const outcome = await this.options.onIdle?.(targetVersion, cancellation);
        if (outcome === 'cancelled') await this.unarmUpgrading();
        else if (outcome === 'idle-timeout') await this.settleIdleTimeout();
      } catch (error) {
        reportFailure(error, {
          op: 'upgradeCoordinator.onIdle',
          level: 'error',
          context: { armedVersion: targetVersion },
        });
        await this.unarmUpgrading().catch((cancelError: unknown) => {
          reportFailure(cancelError, {
            op: 'upgradeCoordinator.cancelAfterOnIdleFailure',
            level: 'error',
            context: { armedVersion: targetVersion },
          });
        });
      } finally {
        if (this.activeCancellation === cancellation) this.activeCancellation = null;
      }
    })();
  }

  /** False once an update is armed, mid idle-handoff, or upgrading — the gate every
   * work-start path must check. A `failed` rollback is not itself blocking. */
  async workStartAllowed(): Promise<boolean> {
    const kind = (await this.options.store.getState()).phase.kind;
    return kind === 'unarmed' || kind === 'failed';
  }

  async assertManualLaunchAllowed(): Promise<void> {
    if (!(await this.workStartAllowed())) {
      throw new DomainError('invalid_state', 'the instance is waiting to upgrade; cancel the upgrade before starting new work');
    }
  }

  private async exclusively<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.transitions;
    let release: (() => void) | undefined;
    this.transitions = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await run();
    } finally {
      release?.();
    }
  }

  private reconcileAfterArming(targetVersion: string): void {
    void this.reconcile().catch((error: unknown) => {
      reportFailure(error, {
        op: 'upgradeCoordinator.reconcile',
        level: 'error',
        context: { armedVersion: targetVersion },
      });
      void this.cancel().catch((cancelError: unknown) => {
        reportFailure(cancelError, {
          op: 'upgradeCoordinator.cancelAfterReconcileFailure',
          level: 'error',
          context: { armedVersion: targetVersion },
        });
      });
    });
  }
}
