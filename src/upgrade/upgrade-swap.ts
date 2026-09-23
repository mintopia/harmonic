export type UpgradeSwapAction = 'install' | 'verify' | 'await-idle' | 'commit' | 'relaunch' | 'release-lock' | 'exit' | 'abort';

export interface UpgradeSwapLogEvent {
  action: UpgradeSwapAction;
  outcome: 'started' | 'succeeded' | 'failed';
  version: string;
  error?: Error;
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
   * irreversible commit/relaunch/release-lock; never rejects. Absent ⇒ skipped. */
  waitForIdle?(): Promise<void>;
  releaseLock(): Promise<void>;
  exit(): void;
  /** Records the failure before the caller restores the armed-update state. */
  abort(error: Error): Promise<void>;
  operation<T>(input: { type: `upgrade.${UpgradeSwapAction}`; version: string }, work: () => Promise<T>): Promise<T>;
  log(event: UpgradeSwapLogEvent): void;
}

export type UpgradeSwapResult =
  | { kind: 'swapped' }
  | { kind: 'migration-required' }
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

    if (this.dependencies.waitForIdle) {
      await this.step({ action: 'await-idle', version, work: () => this.dependencies.waitForIdle!() });
    }

    try {
      // Everything up to here left `current` untouched; a failure here must too, which is why the
      // DB snapshot happens before `pending.json` is written and the flip happens last (ADR-0042).
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
