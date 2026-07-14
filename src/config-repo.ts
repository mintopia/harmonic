import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './db/index.js';
import { settings } from './db/schema.js';
import { appConfigSchema, defaultConfig, mergeConfig, type DeepPartial, type AppConfig } from './config.js';
import type { ConfigStore } from './server/config-store.js';
import { AuthService } from './server/auth.js';
import { ChannelService, createChannelSchema } from './notifications/channels.js';
import { Git } from './execution/git.js';
import { DomainError } from './domain/errors.js';

export const CONFIG_FILE = 'harmonic.json';
const REPO_SETTING = 'configRepo';

/**
 * The committable file format. Everything is optional: the repo seeds
 * whatever it declares and leaves the rest alone.
 */
const configFileSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  channels: z.array(createChannelSchema).optional(),
  auth: z.object({ salt: z.string(), hash: z.string() }).optional(),
  apiKeys: z.array(z.object({ name: z.string(), tokenHash: z.string(), prefix: z.string() })).optional(),
});
export type ConfigFile = z.infer<typeof configFileSchema>;

export interface ConfigRepoDeps {
  db: Db;
  dataDir: string;
  configStore: ConfigStore;
  auth: AuthService;
  channels: ChannelService;
}

/**
 * Dotfiles-style portability (the PRD's Config Repo): a git repo holding
 * `harmonic.json` is imported on init and on explicit pull; export
 * writes live config back to the clone as a committable file. The
 * database stays runtime truth — there is no background sync.
 */
export class ConfigRepoService {
  constructor(private readonly deps: ConfigRepoDeps) {}

  private get cloneDir(): string {
    return join(this.deps.dataDir, 'config-repo');
  }

  repoUrl(): string | null {
    const row = this.deps.db.select().from(settings).where(eq(settings.key, REPO_SETTING)).get();
    return row ? (JSON.parse(row.value) as string) : null;
  }

  status(): { repo: string | null; clonePresent: boolean } {
    return { repo: this.repoUrl(), clonePresent: existsSync(join(this.cloneDir, '.git')) };
  }

  /** Clone the repo and import its config into this (fresh) instance. */
  async init(repo: string): Promise<ConfigFile> {
    if (!existsSync(join(this.cloneDir, '.git'))) {
      await Git.clone(repo, this.cloneDir);
    }
    const value = JSON.stringify(repo);
    this.deps.db
      .insert(settings)
      .values({ key: REPO_SETTING, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
    return this.importFromClone();
  }

  /** Explicit re-import: git pull, then apply the file. Nothing else syncs. */
  async pull(): Promise<ConfigFile> {
    if (!existsSync(join(this.cloneDir, '.git'))) {
      throw new DomainError('conflict', 'no config repo configured; run `harmonic init --repo <url>` first');
    }
    await Git.pull(this.cloneDir);
    return this.importFromClone();
  }

  /** Write current live config to the clone as a committable file. */
  export(): { path: string; file: ConfigFile } {
    const file: ConfigFile = {
      config: this.deps.configStore.get() as unknown as Record<string, unknown>,
      channels: this.deps.channels.list().map(({ name, type, config, events }) => ({
        name,
        type,
        config,
        events,
      })),
      ...(this.deps.auth.exportAuth() ? { auth: this.deps.auth.exportAuth()! } : {}),
      apiKeys: this.deps.auth.exportKeys(),
    };
    const dir = existsSync(join(this.cloneDir, '.git')) ? this.cloneDir : this.deps.dataDir;
    const path = join(dir, CONFIG_FILE);
    writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
    return { path, file };
  }

  private importFromClone(): ConfigFile {
    const path = join(this.cloneDir, CONFIG_FILE);
    if (!existsSync(path)) {
      throw new DomainError('validation', `config repo has no ${CONFIG_FILE}`);
    }
    const file = configFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

    if (file.config) {
      // The repo seeds what it declares and leaves the rest alone:
      // partial files merge over the live config, not built-in defaults.
      const merged = mergeConfig(this.deps.configStore.get(), file.config as DeepPartial<AppConfig>);
      this.deps.configStore.replace(appConfigSchema.parse(merged));
    }
    if (file.channels) {
      // Upsert by name: repo-declared channels win; others are untouched.
      const existing = this.deps.channels.list();
      for (const channel of file.channels) {
        const match = existing.find((c) => c.name === channel.name);
        if (match) this.deps.channels.delete(match.id);
        this.deps.channels.create(channel);
      }
    }
    if (file.auth) this.deps.auth.importAuth(file.auth);
    if (file.apiKeys) this.deps.auth.importKeys(file.apiKeys);
    return file;
  }
}
