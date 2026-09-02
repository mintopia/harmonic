import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { workspaceOverridesSchema, OVERRIDE_KEYS } from '../domain/workspaces.js';
import type { WorkspaceOverrides, ResolvedOverrides, WorkspaceSettingsStore } from '../domain/workspaces.js';
import {
  appConfigSchema,
  defaultConfig,
  mergeConfig,
  type AppConfig,
  type DeepPartial,
} from '../config.js';

export type { WorkspaceOverrides };

function blankOverrides(): ResolvedOverrides {
  const out = {} as ResolvedOverrides;
  for (const key of OVERRIDE_KEYS) out[key] = null;
  return out;
}

interface SettingsFile {
  global: AppConfig;
  /** Sparse per-Workspace override entries keyed by Workspace id (string) —
   * only non-null (i.e. actually overridden) keys are present. */
  workspaces: Record<string, WorkspaceOverrides>;
}

interface RawSettingsFile {
  global?: unknown;
  workspaces?: Record<string, unknown>;
}

function loadFromDisk(path: string): SettingsFile {
  let raw: RawSettingsFile;
  try {
    raw = parse(readFileSync(path, 'utf8')) as RawSettingsFile;
  } catch (err) {
    throw new Error(`Invalid Harmonic settings file at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const global = appConfigSchema.parse(
      mergeConfig(defaultConfig(), (raw.global ?? {}) as DeepPartial<AppConfig>),
    );
    const workspaces: Record<string, WorkspaceOverrides> = {};
    for (const [id, entry] of Object.entries(raw.workspaces ?? {})) {
      workspaces[id] = workspaceOverridesSchema.parse(entry);
    }
    return { global, workspaces };
  } catch (err) {
    throw new Error(`Invalid Harmonic settings file at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The YAML-backed settings store: owns the global `AppConfig` and per-Workspace overrides. In-memory state
 * is authoritative for writes; reads reload when the file changed on disk (throttled to one `stat`/s).
 * A malformed existing file fails loud rather than falling back to defaults.
 */
export class SettingsStore implements WorkspaceSettingsStore {
  private global: AppConfig;
  private workspaces: Record<string, WorkspaceOverrides>;
  private loadedMtimeMs = 0;
  private lastCheckMs = 0;

  private constructor(
    private readonly path: string,
    file: SettingsFile,
    private readonly clock: () => number,
  ) {
    this.global = file.global;
    this.workspaces = file.workspaces;
  }

  static async create(
    dataDir: string,
    overrides?: DeepPartial<AppConfig>,
    clock: () => number = Date.now,
  ): Promise<SettingsStore> {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, 'settings.yaml');
    let file: SettingsFile;
    try {
      statSync(path);
      file = loadFromDisk(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        file = { global: mergeConfig(defaultConfig()), workspaces: {} };
      } else {
        throw err;
      }
    }
    const store = new SettingsStore(path, file, clock);
    store.global = mergeConfig(store.global, overrides);
    store.persist();
    return store;
  }

  getGlobal(): AppConfig {
    this.reloadIfChanged();
    return this.global;
  }

  async updateGlobal(patch: DeepPartial<AppConfig>): Promise<AppConfig> {
    this.reloadIfChanged();
    this.global = mergeConfig(this.global, patch);
    this.persist();
    return this.global;
  }

  async replaceGlobal(config: AppConfig): Promise<AppConfig> {
    this.reloadIfChanged();
    this.global = appConfigSchema.parse(config);
    this.persist();
    return this.global;
  }

  getOverrides(workspaceId: number): ResolvedOverrides {
    this.reloadIfChanged();
    const stored = this.workspaces[String(workspaceId)];
    const merged = blankOverrides();
    if (stored) {
      for (const key of OVERRIDE_KEYS) {
        const value = stored[key];
        if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
      }
    }
    return merged;
  }

  async setOverrides(workspaceId: number, patch: WorkspaceOverrides): Promise<void> {
    this.reloadIfChanged();
    const key = String(workspaceId);
    const current = this.workspaces[key] ?? {};
    const merged: Record<string, unknown> = { ...current };
    for (const field of OVERRIDE_KEYS) {
      const next = patch[field];
      if (next === undefined) continue;
      if (next === null) {
        delete merged[field];
      } else {
        merged[field] = next;
      }
    }
    if (Object.keys(merged).length === 0) {
      delete this.workspaces[key];
    } else {
      this.workspaces[key] = merged as WorkspaceOverrides;
    }
    this.persist();
  }

  async deleteOverrides(workspaceId: number): Promise<void> {
    this.reloadIfChanged();
    delete this.workspaces[String(workspaceId)];
    this.persist();
  }

  private reloadIfChanged(): void {
    const now = this.clock();
    if (now - this.lastCheckMs < 1000) return;
    this.lastCheckMs = now;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(this.path);
    } catch {
      return;
    }
    if (stat.mtimeMs === this.loadedMtimeMs) return;
    const file = loadFromDisk(this.path);
    this.global = file.global;
    this.workspaces = file.workspaces;
    this.loadedMtimeMs = stat.mtimeMs;
  }

  private persist(): void {
    const workspaces: Record<string, WorkspaceOverrides> = {};
    for (const [id, entry] of Object.entries(this.workspaces)) {
      if (Object.keys(entry).length > 0) workspaces[id] = entry;
    }
    writeFileSync(this.path, stringify({ global: this.global, workspaces }));
    this.loadedMtimeMs = statSync(this.path).mtimeMs;
  }
}
