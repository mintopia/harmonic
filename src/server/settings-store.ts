import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { workspaceOverridesSchema, type WorkspaceOverrides } from '../domain/workspaces.js';
import {
  appConfigSchema,
  defaultConfig,
  mergeConfig,
  migrateLegacyConfig,
  type AppConfig,
  type DeepPartial,
  type LegacyConfig,
} from '../config.js';

export type { WorkspaceOverrides };

/** Every per-Workspace setting override key (ADR-0009) — the full set that
 * moved off `workspaces` columns and into the YAML settings file's sparse
 * per-Workspace entries. */
export const OVERRIDE_KEYS = [
  'harness',
  'model',
  'chatHarness',
  'chatModel',
  'isolationMode',
  'priority',
  'conflictResolveTurns',
  'maxConcurrentAttempts',
  'autoRunnerEnabled',
  'maxAttempts',
  'contextReuseTokenLimit',
  'verificationCommand',
  'reviewEnabled',
  'reviewPrompt',
  'reviewModel',
  'reviewHarness',
  'guardrailBudget',
  'guardrailProgress',
  'toolTimeoutMinutes',
  'drivePrompt',
  'driveUnattendedReminder',
  'driveContinuePrompt',
  'driveMergeFate',
  'driveContinueAttempts',
  'taskPrompt',
] as const;

/** A fully-populated overrides object: every key present, `null` meaning
 * *inherit* the global default — what `SettingsStore.getOverrides` returns. */
export type ResolvedOverrides = { [K in (typeof OVERRIDE_KEYS)[number]]: NonNullable<WorkspaceOverrides[K]> | null };

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

/** The raw shape read back off disk before validation — everything is
 * `unknown` until `appConfigSchema`/`workspaceOverridesSchema` parse it. */
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
    // A settings file saved before a global field existed is missing it, and a
    // bare parse would throw on boot; merging onto `defaultConfig()` fills new
    // fields, and `migrateLegacyConfig` folds any still-lingering retired keys
    // (mirrors the old boot-time config overlay).
    const global = appConfigSchema.parse(
      mergeConfig(defaultConfig(), migrateLegacyConfig((raw.global ?? {}) as LegacyConfig)),
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
 * The YAML-backed settings store (ADR-0009, issue #391): owns the global
 * `AppConfig` and every per-Workspace setting override, both previously
 * persisted in SQLite (the `settings.config` row and nullable `workspaces`
 * columns respectively). In-memory state is authoritative for writes; reads
 * reload from disk when the file changed underneath us (an operator hand-
 * editing `settings.yaml`), throttled to at most one `stat` per second so the
 * hot resolve path (`getGlobal`/`getOverrides`, called per-Run/per-Task) never
 * pays a syscall per call.
 *
 * A malformed *existing* file (bad YAML, or a value that fails
 * `appConfigSchema`/`workspaceOverridesSchema`) fails loud at load time — it is
 * never silently discarded for defaults, since that would quietly drop an
 * operator's configured settings.
 */
export class SettingsStore {
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

  async updateGlobal(patch: LegacyConfig): Promise<AppConfig> {
    this.reloadIfChanged();
    this.global = mergeConfig(this.global, migrateLegacyConfig(patch));
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
      // `stored` only ever holds keys `setOverrides` didn't strip as null, so
      // every present value here is a real override, never null — the cast is
      // just working around the generic key/value pairing TS can't track
      // through a runtime loop over a mapped type.
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
      if (next === undefined) continue; // omitted: keep the current value
      if (next === null) {
        delete merged[field]; // null = inherit = absent
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

  /**
   * Reload policy: the in-memory state is authoritative for our own writes,
   * but an operator can hand-edit `settings.yaml` on disk, so every getter
   * checks whether it changed first. Throttled to at most one `stat` per
   * second — the hot resolve path (per-Run/per-Task) must not pay a syscall
   * on every call.
   */
  private reloadIfChanged(): void {
    const now = this.clock();
    if (now - this.lastCheckMs < 1000) return;
    this.lastCheckMs = now;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(this.path);
    } catch {
      return; // file missing (e.g. deleted underneath us): keep the in-memory state
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
    // Refresh the loaded mtime off our own write so the next getter's
    // `reloadIfChanged` doesn't re-parse the file we just wrote.
    this.loadedMtimeMs = statSync(this.path).mtimeMs;
  }
}
