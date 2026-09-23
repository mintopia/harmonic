import { DomainError } from '../domain/errors.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { SettingsStore } from '../server/settings-store.js';
import type { OperationSnapshot } from '../telemetry/operations.js';
import type { ConversationDriver } from '../execution/conversation-driver.js';
import { reportFailure } from '../error-handling.js';
import { singleFlight } from '../reliability/single-flight.js';
import type { UpdateArmingStore, UpdateAvailabilityState } from './update-check.js';

export interface UpgradeIdleState {
  runningAttempts: number;
  mergingOrIntegrating: boolean;
  conversationMidTurn: boolean;
}

export interface UpgradeCoordinatorOptions {
  /** The version this process is running; an armed upgrade to it has taken effect. */
  version: string;
  store: UpdateArmingStore;
  settings: Pick<SettingsStore, 'getGlobal' | 'updateGlobal'>;
  attempts: Pick<AttemptStore, 'countRunning'>;
  operations: () => readonly OperationSnapshot[];
  conversations: Pick<ConversationDriver, 'hasInFlightTurn'>;
  onIdle?: (version: string) => Promise<void> | void;
  migrationRequired?: boolean;
}

export const SYSTEMD_MIGRATION_NOTICE = 'Auto-upgrade is disabled until you re-run sudo harmonic install; your data is untouched.';

/** Durable arming state for an offered in-place upgrade. */
export class UpgradeCoordinator {
  private transitions: Promise<void> = Promise.resolve();
  private readonly reconcileIdle = singleFlight(() => this.reconcileOnce());

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
    const current = await this.options.store.getState();
    if (current.phase.kind !== 'unarmed') return current;
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

  private async cancelOnce(): Promise<UpdateAvailabilityState> {
    const current = await this.options.store.getState();
    if (current.phase.kind === 'unarmed') return current;
    const restored = current.phase.autoRunnerWasEnabled;
    const cancelled: UpdateAvailabilityState = {
      version: current.version,
      dismissedVersion: current.dismissedVersion,
      phase: { kind: 'unarmed' },
    };
    await this.options.store.setState(cancelled);
    try {
      await this.options.settings.updateGlobal({ autoRunner: { enabled: restored } });
      return cancelled;
    } catch (error) {
      await this.options.store.setState(current);
      throw error;
    }
  }

  complete(): Promise<UpdateAvailabilityState> {
    return this.exclusively(() => this.completeOnce());
  }

  /** A relaunch onto the armed version settles the upgrade: clear the arming so
   * reconcile stops re-triggering the swap, and restore the Auto-Runner switch. */
  private async completeOnce(): Promise<UpdateAvailabilityState> {
    const current = await this.options.store.getState();
    if (current.phase.kind === 'unarmed' || current.phase.targetVersion !== this.options.version) return current;
    const restored = current.phase.autoRunnerWasEnabled;
    const completed: UpdateAvailabilityState = {
      version: current.version,
      dismissedVersion: current.dismissedVersion,
      phase: { kind: 'unarmed' },
    };
    await this.options.store.setState(completed);
    try {
      await this.options.settings.updateGlobal({ autoRunner: { enabled: restored } });
      return completed;
    } catch (error) {
      await this.options.store.setState(current);
      throw error;
    }
  }

  async idleState(): Promise<UpgradeIdleState> {
    const runningAttempts = await this.options.attempts.countRunning();
    const mergingOrIntegrating = this.options.operations().some((operation) => operation.type === 'merge' || operation.type === 'integrate');
    return { runningAttempts, mergingOrIntegrating, conversationMidTurn: this.options.conversations.hasInFlightTurn() };
  }

  private static isIdle(state: UpgradeIdleState): boolean {
    return state.runningAttempts === 0 && !state.mergingOrIntegrating && !state.conversationMidTurn;
  }

  /** Best-effort bounded, yielding wait for in-flight work to drain, so the
   * swap's irreversible release-lock/exit doesn't kill work that started
   * during install/verify (issue #9); never throws, and gives up (returns)
   * once `timeoutMs` elapses even if still busy. */
  async waitForIdle({
    timeoutMs = 10 * 60_000,
    pollMs = 1_000,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }),
  }: { timeoutMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
    const deadline = now() + timeoutMs;
    for (;;) {
      const idle = await this.idleState();
      if (UpgradeCoordinator.isIdle(idle)) return;
      if (now() >= deadline) return;
      await sleep(pollMs);
    }
  }

  reconcile(): Promise<boolean> {
    return this.exclusively(() => this.reconcileIdle());
  }

  /** Transitions `armed` -> `upgrading` and kicks off the handoff, all under the
   * lock; the handoff itself (the real install/verify/relaunch/release-lock swap,
   * which can run for minutes and ends the process) runs after this returns, so
   * the lock never blocks a request for the swap's duration (issue #3). An
   * already-`upgrading` phase is a no-op: the persisted phase itself is the
   * re-entry guard, replacing the old in-memory `onIdleStartedFor` flag. */
  private async reconcileOnce(): Promise<boolean> {
    const armed = await this.options.store.getState();
    if (armed.phase.kind === 'unarmed') return false;
    if (this.options.migrationRequired) {
      await this.cancelOnce();
      return false;
    }
    if (armed.phase.kind === 'upgrading') return true;
    const targetVersion = armed.phase.targetVersion;
    const idle = await this.idleState();
    if (idle.runningAttempts !== 0 || idle.mergingOrIntegrating || idle.conversationMidTurn) return false;
    await this.options.store.setState({ ...armed, phase: { ...armed.phase, kind: 'upgrading' } });
    setImmediate(() => this.runIdleHandoff(targetVersion));
    return true;
  }

  /** Runs `onIdle` (the real swap) outside the `exclusively` lock, in a fresh
   * task so a synchronous throw from `onIdle` can never re-enter the lock from
   * within the same call stack that's still holding it. */
  private runIdleHandoff(targetVersion: string): void {
    void (async () => {
      try {
        await this.options.onIdle?.(targetVersion);
      } catch (error) {
        reportFailure(error, {
          op: 'upgradeCoordinator.onIdle',
          level: 'error',
          context: { armedVersion: targetVersion },
        });
        await this.cancel().catch((cancelError: unknown) => {
          reportFailure(cancelError, {
            op: 'upgradeCoordinator.cancelAfterOnIdleFailure',
            level: 'error',
            context: { armedVersion: targetVersion },
          });
        });
      }
    })();
  }

  async assertManualLaunchAllowed(): Promise<void> {
    if ((await this.options.store.getState()).phase.kind !== 'unarmed') {
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
