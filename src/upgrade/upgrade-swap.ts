export type UpgradeSwapAction = 'install' | 'verify' | 'relaunch' | 'release-lock' | 'exit' | 'abort';

export interface UpgradeSwapLogEvent {
  action: UpgradeSwapAction;
  outcome: 'started' | 'succeeded' | 'failed';
  version: string;
  error?: Error;
}

export interface UpgradeSwapDependencies {
  install(version: string): Promise<void>;
  installedVersion(): Promise<string>;
  spawnRelauncher(): Promise<void>;
  releaseLock(): Promise<void>;
  exit(): void;
  /** Records the failure before the caller restores the armed-update state. */
  abort(error: Error): Promise<void>;
  operation<T>(input: { type: `upgrade.${UpgradeSwapAction}`; version: string }, work: () => Promise<T>): Promise<T>;
  log(event: UpgradeSwapLogEvent): void;
}

export type UpgradeSwapResult =
  | { kind: 'swapped' }
  | { kind: 'aborted'; error: Error };

/** Performs the irreversible handoff only after the pinned package is verified. */
export class UpgradeSwap {
  constructor(private readonly dependencies: UpgradeSwapDependencies) {}

  async execute({ version }: { version: string }): Promise<UpgradeSwapResult> {
    try {
      await this.step({ action: 'install', version, work: () => this.dependencies.install(version) });
      await this.step({
        action: 'verify',
        version,
        work: async () => {
          const installed = await this.dependencies.installedVersion();
          if (installed !== version) throw new Error(`installed version ${installed} does not match pinned version ${version}`);
        },
      });
    } catch (error) {
      const failure = toError(error);
      await this.step({ action: 'abort', version, work: () => this.dependencies.abort(failure) });
      return { kind: 'aborted', error: failure };
    }

    await this.step({ action: 'relaunch', version, work: () => this.dependencies.spawnRelauncher() });
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
