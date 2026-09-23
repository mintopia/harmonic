export type UpgradeSwapAction = 'install' | 'verify' | 'await-idle' | 'commit' | 'relaunch' | 'release-lock' | 'exit' | 'abort';

export interface UpgradeSwapLogEvent {
  action: UpgradeSwapAction;
  outcome: 'started' | 'succeeded' | 'failed';
  version: string;
  error?: Error;
}

/** Consulted at each step boundary up to commit; see `UpgradeCancellation` in `upgrade-coordinator.ts`. */
export interface UpgradeSwapCancellation {
  /** Checked before and after await-idle: false means stop instead of
   * continuing toward commit. */
  shouldContinue(): boolean;
  /** Checked immediately before commit; false means a cancel already won and
   * the swap must stop instead of committing. True latches out any later
   * cancellation. */
  enterCommit(): boolean;
}

export interface UpgradeSwapDependencies {
  install(version: string): Promise<void>;
  /** Checks the staged install at `versions/<version>` before anything commits to it. */
  verify(version: string): Promise<void>;
  managedBy?: string;
  migrationRequired?: boolean;
  /** The irreversible step: snapshot the DB, record the pending upgrade, then flip `current`. Must be idempotent — a retry after a partial failure re-runs it. */
  commit(version: string): Promise<void>;
  spawnRelauncher(): Promise<void>;
  /** Best-effort bounded wait for in-flight work to drain before the
   * irreversible commit/relaunch/release-lock; never rejects, resolves to
   * whether idle was actually reached. Absent ⇒ skipped. */
  waitForIdle?(): Promise<boolean>;
  releaseLock(): Promise<void>;
  exit(): void;
  /** Records the failure before the caller restores the armed-update state. */
  abort(error: Error): Promise<void>;
  operation<T>(input: { type: `upgrade.${UpgradeSwapAction}`; version: string }, work: () => Promise<T>): Promise<T>;
  log(event: UpgradeSwapLogEvent): void;
  /** Absent ⇒ never cancellable. */
  cancellation?: UpgradeSwapCancellation;
}

export type UpgradeSwapResult =
  | { kind: 'swapped' }
  | { kind: 'migration-required' }
  /** A cancellation was requested and honoured before commit; `current` is untouched. */
  | { kind: 'cancelled' }
  /** `waitForIdle` timed out with work still running; `current` is untouched. */
  | { kind: 'idle-timeout' }
  | { kind: 'aborted'; error: Error };

/** Performs the irreversible handoff only after the pinned package is verified. */
export class UpgradeSwap {
  constructor(private readonly dependencies: UpgradeSwapDependencies) {}

  async execute({ version }: { version: string }): Promise<UpgradeSwapResult> {
    if (this.dependencies.managedBy === 'systemd' && this.dependencies.migrationRequired) {
      return { kind: 'migration-required' };
    }
    try {
      await this.step({ action: 'install', version, work: () => this.dependencies.install(version) });
      await this.step({ action: 'verify', version, work: () => this.dependencies.verify(version) });
    } catch (error) {
      const failure = toError(error);
      await this.step({ action: 'abort', version, work: () => this.dependencies.abort(failure) });
      return { kind: 'aborted', error: failure };
    }

    if (!this.shouldContinue()) return { kind: 'cancelled' };

    if (this.dependencies.waitForIdle) {
      const idle = await this.step({ action: 'await-idle', version, work: () => this.dependencies.waitForIdle!() });
      if (!idle) {
        await this.step({
          action: 'abort',
          version,
          work: () => this.dependencies.abort(new Error('timed out waiting for in-flight work to drain before commit')),
        });
        // A cancellation requested during the wait wins over the timeout (ADR-0042).
        return this.shouldContinue() ? { kind: 'idle-timeout' } : { kind: 'cancelled' };
      }
    }

    if (!this.shouldContinue()) return { kind: 'cancelled' };
    if (!this.enterCommit()) return { kind: 'cancelled' };

    try {
      // Everything up to here leaves `current` untouched on failure.
      await this.step({ action: 'commit', version, work: () => this.dependencies.commit(version) });
    } catch (error) {
      const failure = toError(error);
      await this.step({ action: 'abort', version, work: () => this.dependencies.abort(failure) });
      return { kind: 'aborted', error: failure };
    }

    if (this.dependencies.managedBy !== 'systemd') {
      await this.step({ action: 'relaunch', version, work: () => this.dependencies.spawnRelauncher() });
    }
    await this.step({ action: 'release-lock', version, work: () => this.dependencies.releaseLock() });
    await this.step({ action: 'exit', version, work: async () => { this.dependencies.exit(); } });
    return { kind: 'swapped' };
  }

  private shouldContinue(): boolean {
    return this.dependencies.cancellation?.shouldContinue() ?? true;
  }

  private enterCommit(): boolean {
    return this.dependencies.cancellation?.enterCommit() ?? true;
  }

  private async step<T>({
    action,
    version,
    work,
  }: {
    action: UpgradeSwapAction;
    version: string;
    work: () => Promise<T>;
  }): Promise<T> {
    this.dependencies.log({ action, outcome: 'started', version });
    try {
      const result = await this.dependencies.operation({ type: `upgrade.${action}`, version }, work);
      this.dependencies.log({ action, outcome: 'succeeded', version });
      return result;
    } catch (error) {
      const failure = toError(error);
      this.dependencies.log({ action, outcome: 'failed', version, error: failure });
      throw failure;
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
