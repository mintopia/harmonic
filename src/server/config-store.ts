import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import {
  appConfigSchema,
  defaultConfig,
  mergeConfig,
  type AppConfig,
  type DeepPartial,
} from '../config.js';

const CONFIG_KEY = 'config';

/**
 * Configuration lives in the database (the runtime truth, per the PRD);
 * built-in defaults seed it on first boot. Boot-time overrides are merged
 * on top of whatever is stored — they are for tests and CLI flags.
 */
export class ConfigStore {
  private current: AppConfig;

  constructor(
    private readonly db: Db,
    overrides?: DeepPartial<AppConfig>,
  ) {
    const stored = this.db.select().from(settings).where(eq(settings.key, CONFIG_KEY)).get();
    // Overlay stored config on the current defaults rather than parse it bare:
    // a config saved before a field existed (e.g. `drive`) is missing it, and
    // a bare parse would throw on boot. Merging fills new fields from defaults.
    const base = stored
      ? mergeConfig(defaultConfig(), JSON.parse(stored.value) as DeepPartial<AppConfig>)
      : defaultConfig();
    this.current = mergeConfig(base, overrides);
    this.persist();
  }

  get(): AppConfig {
    return this.current;
  }

  update(patch: DeepPartial<AppConfig>): AppConfig {
    this.current = mergeConfig(this.current, patch);
    this.persist();
    return this.current;
  }

  replace(config: AppConfig): AppConfig {
    this.current = appConfigSchema.parse(config);
    this.persist();
    return this.current;
  }

  private persist(): void {
    const value = JSON.stringify(this.current);
    this.db
      .insert(settings)
      .values({ key: CONFIG_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }
}
