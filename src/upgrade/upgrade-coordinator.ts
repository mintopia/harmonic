import { DomainError } from '../domain/errors.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { SettingsStore } from '../server/settings-store.js';
import type { OperationSnapshot } from '../telemetry/operations.js';
import type { ConversationDriver } from '../execution/conversation-driver.js';
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
}

/** Durable arming state for an offered in-place upgrade. */
export class UpgradeCoordinator {
  private transitions: Promise<void> = Promise.resolve();
  private onIdleStartedFor: string | null = null;
  private readonly reconcileIdle = singleFlight(() => this.reconcileOnce());

  constructor(private readonly options: UpgradeCoordinatorOptions) {}

  state(): Promise<UpdateAvailabilityState> {
    return this.options.store.getState();
  }

  arm(): Promise<UpdateAvailabilityState> {
    return this.exclusively(() => this.armOnce());
  }

  dismiss(): Promise<UpdateAvailabilityState> {
    return this.exclusively(() => this.dismissOnce());
  }

  private async dismissOnce(): Promise<UpdateAvailabilityState> {
    const current = await this.options.store.getState();
    if (current.version === null || current.armedVersion !== null) return current;
    const dismissed = { ...current, dismissedVersion: current.version };
    await this.options.store.setState(dismissed);
    return dismissed;
  }

  private async armOnce(): Promise<UpdateAvailabilityState> {
    const current = await this.options.store.getState();
    if (current.armedVersion !== null) return current;
    if (current.version === null) throw new DomainError('invalid_state', 'there is no available update to arm');

    const autoRunnerWasEnabled = this.options.settings.getGlobal().autoRunner.enabled;
    await this.options.settings.updateGlobal({ autoRunner: { enabled: false } });
    try {
      const armed = { ...current, armedVersion: current.version, autoRunnerWasEnabled };
      await this.options.store.setState(armed);
      await this.reconcile();
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
    if (current.armedVersion === null) return current;
    const restored = current.autoRunnerWasEnabled ?? false;
    const cancelled = { ...current, armedVersion: null, autoRunnerWasEnabled: null };
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
    if (current.armedVersion === null || current.armedVersion !== this.options.version) return current;
    const restored = current.autoRunnerWasEnabled ?? false;
    const completed = { ...current, armedVersion: null, autoRunnerWasEnabled: null };
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

  reconcile(): Promise<boolean> {
    return this.reconcileIdle();
  }

  private async reconcileOnce(): Promise<boolean> {
    const armed = await this.options.store.getState();
    if (armed.armedVersion === null) return false;
    const idle = await this.idleState();
    if (idle.runningAttempts !== 0 || idle.mergingOrIntegrating || idle.conversationMidTurn) return false;
    if (this.onIdleStartedFor === armed.armedVersion) return true;
    this.onIdleStartedFor = armed.armedVersion;
    try {
      await this.options.onIdle?.(armed.armedVersion);
    } catch (_error) {
      this.onIdleStartedFor = null;
      await this.cancelOnce();
      return false;
    }
    return true;
  }

  async assertManualLaunchAllowed(): Promise<void> {
    if ((await this.options.store.getState()).armedVersion !== null) {
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
}
