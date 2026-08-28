import type { AppConfig, LegacyConfig } from '../config.js';
import type { SettingsStore } from './settings-store.js';

/**
 * A thin adapter over the global-config slice of `SettingsStore` (ADR-0009,
 * issue #391). `SettingsStore` owns the actual YAML-backed state (and the
 * per-Workspace overrides alongside it); this keeps the `configStore.get()/
 * update()/replace()` call surface unchanged for every existing consumer.
 */
export class ConfigStore {
  constructor(private readonly store: SettingsStore) {}

  get(): AppConfig {
    return this.store.getGlobal();
  }

  async update(patch: LegacyConfig): Promise<AppConfig> {
    return this.store.updateGlobal(patch);
  }

  async replace(config: AppConfig): Promise<AppConfig> {
    return this.store.replaceGlobal(config);
  }
}
