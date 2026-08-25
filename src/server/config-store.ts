import { eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { settings } from '../db/schema.js';
import {
  appConfigSchema,
  defaultConfig,
  mergeConfig,
  migrateLegacyConfig,
  type AppConfig,
  type DeepPartial,
  type LegacyConfig,
} from '../config.js';

const CONFIG_KEY = 'config';

export class ConfigStore {
  private current: AppConfig;

  private constructor(
    private readonly db: AsyncDbHandle,
    current: AppConfig,
  ) {
    this.current = current;
  }

  static async create(db: AsyncDbHandle, overrides?: DeepPartial<AppConfig>): Promise<ConfigStore> {
    const stored = await db.read((d) => d.select().from(settings).where(eq(settings.key, CONFIG_KEY)).get());
    // Overlay stored config on the current defaults rather than parse it bare:
    // a config saved before a field existed (e.g. `drive`) is missing it, and
    // a bare parse would throw on boot. Merging fills new fields from defaults.
    // The stored value may still carry the retired `agentReview` flag (#140,
    // ADR-0021) — migrate it before merging so it never lingers.
    const base = stored
      ? mergeConfig(defaultConfig(), migrateLegacyConfig(JSON.parse(stored.value) as LegacyConfig))
      : defaultConfig();
    const store = new ConfigStore(db, mergeConfig(base, overrides));
    await store.persist();
    return store;
  }

  get(): AppConfig {
    return this.current;
  }

  async update(patch: LegacyConfig): Promise<AppConfig> {
    this.current = mergeConfig(this.current, migrateLegacyConfig(patch));
    await this.persist();
    return this.current;
  }

  async replace(config: AppConfig): Promise<AppConfig> {
    this.current = appConfigSchema.parse(config);
    await this.persist();
    return this.current;
  }

  private async persist(): Promise<void> {
    const value = JSON.stringify(this.current);
    await this.db.write((d) =>
      d
        .insert(settings)
        .values({ key: CONFIG_KEY, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run(),
    );
  }
}
