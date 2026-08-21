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

/**
 * Configuration lives in the database (the runtime truth, per the PRD);
 * built-in defaults seed it on first boot. Boot-time overrides are merged
 * on top of whatever is stored — they are for tests and CLI flags.
 *
 * Constructed via the async {@link ConfigStore.create} factory (ADR-0029): the
 * boot load + seed both touch the async Db, which a JS constructor can't await.
 * `get()` stays synchronous — it returns the in-memory cache the factory primed;
 * only the write path (`update`/`replace`/`persist`) awaits the write queue.
 */
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

  async update(patch: DeepPartial<AppConfig>): Promise<AppConfig> {
    this.current = mergeConfig(this.current, migrateLegacyConfig(patch as LegacyConfig));
    await this.persist();
    return this.current;
  }

  async replace(config: AppConfig): Promise<AppConfig> {
    // No `migrateLegacyConfig` here: `PUT /config` validates the body against
    // `appConfigSchema` (routes/config.ts), which no longer declares the retired
    // `agentReview` flag (#140) and strips unknown keys — so a full-replace never
    // carries the legacy flag to migrate. The fold lives where it can still be
    // observed: the boot load (existing stored config) and the PATCH passthrough.
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
