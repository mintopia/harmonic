import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'yaml';
import { workspaceOverridesSchema, OVERRIDE_KEYS } from '../domain/workspaces.js';
import type { WorkspaceOverrides, ResolvedOverrides, WorkspaceSettingsStore } from '../domain/workspaces.js';
import {
  appConfigSchema,
  baselineConfig,
  criticModelIssues,
  mergeConfig,
  type AppConfig,
  type DeepPartial,
} from '../config.js';
import { DomainError } from '../domain/errors.js';
import {
  parseLegacyGlobal,
  parseLegacyWorkspace,
  pickLegacyGlobal,
  pickLegacyWorkspace,
  withLegacyGlobal,
  type LegacyGlobalRaw,
  type LegacySettings,
} from '../domain/legacy-execution-settings.js';
import { RETIRED_GLOBAL_KEY, RETIRED_WORKSPACE_KEYS, NO_RETIRED, type RetiredSettings } from '../domain/retired-settings.js';
import { logger } from '../logger.js';
import { isMaskedWorkspaceSecret, restoreConfigSecrets } from '../archive/export-secrets.js';

export type { WorkspaceOverrides };
export { fillCriticHarness, migrateGlobalCriticHarnesses, migrateWorkspaceCriticHarnesses, harnessCatalog };

function blankOverrides(): ResolvedOverrides {
  const out = {} as ResolvedOverrides;
  for (const key of OVERRIDE_KEYS) out[key] = null;
  return out;
}

interface SettingsFile {
  globalPatch: unknown;
  global: AppConfig;
  /** Sparse per-Workspace override entries keyed by Workspace id (string) —
   * only non-null (i.e. actually overridden) keys are present. */
  workspaces: Record<string, WorkspaceOverrides>;
  legacy: { preserved: StoredLegacy; view: StoredLegacy };
  retired: RetiredSettings;
}

interface StoredLegacy {
  global: LegacyGlobalRaw;
  workspaces: Record<string, Record<string, unknown>>;
}

const NO_STORED_LEGACY = (): StoredLegacy => ({ global: {}, workspaces: {} });

interface RawSettingsFile {
  global?: unknown;
  workspaces?: Record<string, unknown>;
}

/**
 * Diff `value` against `base` into a sparse patch. With `tombstones` on (the
 * default, for operator edits) a model field or whole model that `base` has but
 * `value` drops is recorded as an explicit `null` clear. With it off (legacy
 * flattened-config conversion) a dropped field is treated as inherited, not
 * cleared — so a field the baseline has since gained isn't retroactively
 * tombstoned across a config that simply predates it.
 */
function deepDiff(base: unknown, value: unknown, path: readonly string[] = [], tombstones = true): unknown {
  if (isDeepStrictEqual(base, value)) return undefined;
  if (isModelCatalogPath(path) && Array.isArray(base) && Array.isArray(value)) {
    return modelCatalogDiff(base, value, tombstones);
  }
  if (Array.isArray(base) || Array.isArray(value) || !isRecord(base) || !isRecord(value)) return value;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const difference = deepDiff(base[key], value[key], [...path, key], tombstones);
    if (difference !== undefined) patch[key] = difference;
  }
  return Object.keys(patch).length === 0 ? undefined : patch;
}

function isModelCatalogPath(path: readonly string[]): boolean {
  return path[0] === 'harnesses' && path[2] === 'models';
}

function modelCatalogDiff(base: unknown[], value: unknown[], tombstones = true): Record<string, unknown> | undefined {
  const baseline = new Map(base.flatMap((model) => isRecord(model) && typeof model.id === 'string' ? [[model.id, model] as const] : []));
  const resolved = new Map(value.flatMap((model) => isRecord(model) && typeof model.id === 'string' ? [[model.id, model] as const] : []));
  const patch: Record<string, unknown> = {};
  for (const [id, model] of baseline) {
    const next = resolved.get(id);
    if (next === undefined) {
      if (tombstones) patch[id] = null;
      continue;
    }
    const difference = deepDiff(model, next, [], tombstones);
    const entryPatch = isRecord(difference) ? difference : {};
    {
      delete entryPatch.id;
      if (tombstones) {
        for (const key of Object.keys(model)) {
          if (key !== 'id' && !(key in next)) entryPatch[key] = null;
        }
      }
      if (Object.keys(entryPatch).length > 0) patch[id] = entryPatch;
    }
  }
  for (const [id, model] of resolved) if (!baseline.has(id)) patch[id] = model;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFlattenedGlobal(global: unknown): boolean {
  return appConfigSchema.safeParse(global).success;
}

/** Backfill a missing `id` (pre-ADR-0037 stored data); a present id is left untouched — idempotent. */
function ensureId(item: unknown, prefix: string): unknown {
  if (!isRecord(item) || typeof item.id === 'string') return item;
  return { ...item, id: `${prefix}-${randomUUID()}` };
}

const VERIFIER_PHASES = ['preMerge', 'postMerge'] as const;

/**
 * Backfill ids onto every command/critic in the global verify lists of a
 * stored (possibly sparse) global patch, in place on a clone. {@link ensureId}
 */
function migrateGlobalVerifierIds(global: unknown): unknown {
  if (!isRecord(global) || !isRecord(global.verify)) return global;
  const verify = structuredClone(global.verify) as Record<string, unknown>;
  for (const stageKey of ['task', 'epic']) {
    const stage = verify[stageKey];
    if (!isRecord(stage)) continue;
    for (const phaseKey of VERIFIER_PHASES) {
      const phase = stage[phaseKey];
      if (!isRecord(phase)) continue;
      if (Array.isArray(phase.commands)) phase.commands = phase.commands.map((c) => ensureId(c, 'cmd'));
      if (Array.isArray(phase.critics)) phase.critics = phase.critics.map((c) => ensureId(c, 'critic'));
    }
  }
  return { ...global, verify };
}

const COMMAND_OVERLAY_KEYS = ['taskPreMergeCommands', 'taskPostMergeCommands', 'epicPreMergeCommands'] as const;
const CRITIC_OVERLAY_KEYS = ['taskPreMergeCritics', 'taskPostMergeCritics', 'epicPreMergeCritics'] as const;

/**
 * Convert one stored Workspace verifier list to the ADR-0037 overlay shape.
 * A pre-ADR-0037 whole-array replace (each entry has no `kind`) becomes an
 * overlay of all-`local` entries, id-backfilled — preserving that Workspace's
 * exact resolved behaviour. An already-overlay array only gets its local
 * entries' ids backfilled. Idempotent either way; `null`/non-array values
 * (inherit) pass through untouched.
 */
function migrateWorkspaceOverlayList(value: unknown, itemKey: 'command' | 'critic', idPrefix: string): unknown {
  if (!Array.isArray(value) || value.length === 0) return value;
  const alreadyOverlay = value.every((entry) => isRecord(entry) && (entry.kind === 'global' || entry.kind === 'local'));
  if (alreadyOverlay) {
    return value.map((entry) => {
      if (!isRecord(entry) || entry.kind !== 'local') return entry;
      return { ...entry, [itemKey]: ensureId(entry[itemKey], idPrefix) };
    });
  }
  return value.map((item) => ({ kind: 'local', enabled: true, [itemKey]: ensureId(item, idPrefix) }));
}

/** {@link migrateWorkspaceOverlayList} applied across one stored Workspace override entry's six verifier lists. */
function migrateWorkspaceOverlays(entry: unknown, globalModelOptionIds: readonly string[] = []): unknown {
  if (!isRecord(entry)) return entry;
  const migrated: Record<string, unknown> = { ...entry };
  if (Array.isArray(migrated.modelOptions) && migrated.modelOptions.every((o) => isRecord(o) && !('kind' in o))) {
    migrated.modelOptions = [
      ...globalModelOptionIds.map((ref) => ({ kind: 'global', ref, enabled: true })),
      ...migrated.modelOptions.map((modelOption) => ({ kind: 'local', enabled: true, modelOption })),
    ];
  }
  for (const key of COMMAND_OVERLAY_KEYS) {
    if (key in migrated) migrated[key] = migrateWorkspaceOverlayList(migrated[key], 'command', 'cmd');
  }
  for (const key of CRITIC_OVERLAY_KEYS) {
    if (key in migrated) migrated[key] = migrateWorkspaceOverlayList(migrated[key], 'critic', 'critic');
  }
  return migrated;
}

type HarnessCatalog = Record<string, string[]>;

function modelIdsOf(models: unknown, base: string[]): string[] {
  if (Array.isArray(models)) return models.flatMap((m) => typeof m === 'string' ? [m] : isRecord(m) && typeof m.id === 'string' ? [m.id] : []);
  if (!isRecord(models)) return base;
  const ids = new Set(base);
  for (const [id, change] of Object.entries(models)) {
    if (change === null) ids.delete(id);
    else ids.add(id);
  }
  return [...ids];
}

function harnessCatalog(baseline: AppConfig, global: unknown): HarnessCatalog {
  const patch = isRecord(global) && isRecord(global.harnesses) ? global.harnesses : {};
  return Object.fromEntries(Object.entries(baseline.harnesses).map(([id, harness]) => {
    const override = patch[id];
    return [id, modelIdsOf(isRecord(override) ? override.models : undefined, harness.models.map((m) => m.id))];
  }));
}

function fillCriticHarness(critic: unknown, catalog: HarnessCatalog, defaultHarness: string): unknown {
  if (!isRecord(critic) || typeof critic.harness === 'string') return critic;
  const matches = Object.keys(catalog).filter((id) => catalog[id]?.includes(String(critic.model)));
  const harness = matches.length === 1 ? matches[0]! : defaultHarness;
  if (matches.length !== 1) {
    logger.warn(`critic "${String(critic.name ?? critic.id ?? '')}" model '${String(critic.model)}' matches ${matches.length} harnesses; assigned the default harness '${defaultHarness}'`);
  }
  return { ...critic, harness };
}

function migrateGlobalCriticHarnesses(global: unknown, baseline: AppConfig): unknown {
  if (!isRecord(global) || !isRecord(global.verify)) return global;
  const catalog = harnessCatalog(baseline, global);
  const defaults = isRecord(global.defaults) ? global.defaults : {};
  const defaultHarness = typeof defaults.harness === 'string' ? defaults.harness : baseline.defaults.harness;
  const verify = structuredClone(global.verify) as Record<string, unknown>;
  for (const stageKey of ['task', 'epic']) {
    const stage = verify[stageKey];
    if (!isRecord(stage)) continue;
    for (const phaseKey of VERIFIER_PHASES) {
      const phase = stage[phaseKey];
      if (isRecord(phase) && Array.isArray(phase.critics)) phase.critics = phase.critics.map((c) => fillCriticHarness(c, catalog, defaultHarness));
    }
  }
  return { ...global, verify };
}

function migrateWorkspaceCriticHarnesses(entry: unknown, catalog: HarnessCatalog, defaultHarness: string): unknown {
  if (!isRecord(entry)) return entry;
  const migrated: Record<string, unknown> = { ...entry };
  for (const key of CRITIC_OVERLAY_KEYS) {
    const list = migrated[key];
    if (!Array.isArray(list)) continue;
    migrated[key] = list.map((item) => isRecord(item) && item.kind === 'local'
      ? { ...item, critic: fillCriticHarness(item.critic, catalog, defaultHarness) }
      : item);
  }
  return migrated;
}

/** Save-time check (not a load-time one, so a migrated Critic with an unmatched Model never blocks boot). */
function assertCriticModels(config: AppConfig): AppConfig {
  const [first] = criticModelIssues(config.verify, config.harnesses);
  if (first) throw new DomainError('validation', `${first.path.join('.')}: ${first.message}`);
  return config;
}

/** Lifts the retired prompt keys out of a raw file so the schemas never see them; they are written back untouched. */
function splitRetired(raw: RawSettingsFile): { global: unknown; workspaces: Record<string, unknown>; retired: RetiredSettings } {
  let global = raw.global ?? {};
  let retiredGlobal: Record<string, unknown> = {};
  if (isRecord(global) && RETIRED_GLOBAL_KEY in global) {
    const { [RETIRED_GLOBAL_KEY]: lifted, ...rest } = global;
    global = rest;
    if (isRecord(lifted)) retiredGlobal = lifted;
  }
  const workspaces: Record<string, unknown> = {};
  const retiredWorkspaces: Record<string, Record<string, unknown>> = {};
  for (const [id, entry] of Object.entries(raw.workspaces ?? {})) {
    if (!isRecord(entry)) {
      workspaces[id] = entry;
      continue;
    }
    const kept: Record<string, unknown> = {};
    const lifted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) (RETIRED_WORKSPACE_KEYS.includes(key) ? lifted : kept)[key] = value;
    workspaces[id] = kept;
    if (Object.keys(lifted).length > 0) retiredWorkspaces[id] = lifted;
  }
  return { global, workspaces, retired: { global: retiredGlobal, workspaces: retiredWorkspaces } };
}

function loadFromDisk(path: string, baseline: AppConfig): SettingsFile {
  let raw: RawSettingsFile;
  try {
    raw = parse(readFileSync(path, 'utf8')) as RawSettingsFile;
  } catch (err) {
    throw new Error(`Invalid Harmonic settings file at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const split = splitRetired(raw);
    const migratedGlobal = migrateGlobalCriticHarnesses(migrateGlobalVerifierIds(split.global), baseline);
    const storedGlobal = (migratedGlobal ?? {}) as DeepPartial<AppConfig>;
    // A flattened (whole-config) global is converted to a sparse patch in
    // inherit mode: a field it doesn't carry is treated as inherited from the
    // baseline, never as a clear, so a baseline addition the file predates
    // (e.g. model prices) isn't frozen into a catalog-wide tombstone. `global`
    // is then resolved from that patch so it and the patch agree.
    const flattened = isFlattenedGlobal(migratedGlobal);
    const globalPatch = flattened
      ? ((deepDiff(baseline, mergeConfig(baseline, storedGlobal), [], false) ?? {}) as DeepPartial<AppConfig>)
      : storedGlobal;
    const global = mergeConfig(baseline, globalPatch);
    const workspaces: Record<string, WorkspaceOverrides> = {};
    const preserved: StoredLegacy = { global: pickLegacyGlobal(raw.global), workspaces: {} };
    const view: StoredLegacy = { global: pickLegacyGlobal(migratedGlobal), workspaces: {} };
    const catalog = harnessCatalog(baseline, migratedGlobal);
    for (const [id, entry] of Object.entries(split.workspaces)) {
      const migrated = migrateWorkspaceCriticHarnesses(migrateWorkspaceOverlays(entry, global.modelOptions.map((o) => o.id)), catalog, global.defaults.harness);
      workspaces[id] = workspaceOverridesSchema.parse(migrated);
      const stored = pickLegacyWorkspace(entry);
      if (Object.keys(stored).length > 0) {
        preserved.workspaces[id] = stored;
        view.workspaces[id] = pickLegacyWorkspace(migrated);
      }
    }
    return { globalPatch, global, workspaces, legacy: { preserved, view }, retired: split.retired };
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
  private globalPatch: unknown;
  private workspaces: Record<string, WorkspaceOverrides>;
  private legacy: SettingsFile['legacy'];
  private retired: RetiredSettings;
  private loadedMtimeMs = 0;
  private lastCheckMs = 0;

  private constructor(
    private readonly path: string,
    file: SettingsFile,
    private readonly clock: () => number,
  ) {
    this.global = file.global;
    this.globalPatch = file.globalPatch;
    this.workspaces = file.workspaces;
    this.legacy = file.legacy;
    this.retired = file.retired;
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
      file = loadFromDisk(path, baselineConfig());
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        file = { globalPatch: {}, global: baselineConfig(), workspaces: {}, legacy: { preserved: NO_STORED_LEGACY(), view: NO_STORED_LEGACY() }, retired: NO_RETIRED };
      } else {
        throw err;
      }
    }
    const store = new SettingsStore(path, file, clock);
    store.global = mergeConfig(store.global, overrides);
    store.globalPatch = deepDiff(baselineConfig(), store.global) ?? {};
    store.persistUnlessCurrent();
    return store;
  }

  getGlobal(): AppConfig {
    this.reloadIfChanged();
    return this.global;
  }

  getLegacySettings(): LegacySettings {
    this.reloadIfChanged();
    const { view } = this.legacy;
    return {
      global: parseLegacyGlobal(view.global),
      workspaces: new Map(Object.entries(view.workspaces).map(([id, entry]) => [Number(id), parseLegacyWorkspace(entry)])),
    };
  }

  /** The retired prompt keys as stored, for the unreleased ADR-0055 migration to read. */
  getRetired(): RetiredSettings {
    this.reloadIfChanged();
    return this.retired;
  }

  getBaseline(): AppConfig {
    return baselineConfig();
  }

  async updateGlobal(patch: DeepPartial<AppConfig>): Promise<AppConfig> {
    this.reloadIfChanged();
    this.global = assertCriticModels(mergeConfig(this.global, restoreConfigSecrets(patch, this.global)));
    this.globalPatch = deepDiff(baselineConfig(), this.global) ?? {};
    this.persist();
    return this.global;
  }

  /** Sets the global default workflow without the save-time Critic Model check, which must never block a boot. */
  async setDefaultWorkflow(name: string): Promise<void> {
    this.reloadIfChanged();
    this.global = mergeConfig(this.global, { defaults: { workflow: name } });
    this.globalPatch = deepDiff(baselineConfig(), this.global) ?? {};
    this.persist();
  }

  async setDefaultEpicWorkflow(name: string): Promise<void> {
    this.reloadIfChanged();
    this.global = mergeConfig(this.global, { defaults: { epicWorkflow: name } });
    this.globalPatch = deepDiff(baselineConfig(), this.global) ?? {};
    this.persist();
  }

  async replaceGlobal(config: AppConfig): Promise<AppConfig> {
    this.reloadIfChanged();
    this.global = assertCriticModels(appConfigSchema.parse(restoreConfigSecrets(config, this.global)));
    this.globalPatch = deepDiff(baselineConfig(), this.global) ?? {};
    this.persist();
    return this.global;
  }

  async revertGlobal(): Promise<AppConfig> {
    return this.replaceGlobal(baselineConfig());
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
      if (next === undefined || isMaskedWorkspaceSecret(field, next)) continue;
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
    delete this.legacy.preserved.workspaces[String(workspaceId)];
    delete this.legacy.view.workspaces[String(workspaceId)];
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
    const file = loadFromDisk(this.path, baselineConfig());
    this.global = file.global;
    this.globalPatch = file.globalPatch;
    this.workspaces = file.workspaces;
    this.legacy = file.legacy;
    this.retired = file.retired;
    this.loadedMtimeMs = stat.mtimeMs;
  }

  private snapshot(): { global: unknown; workspaces: Record<string, unknown> } {
    const { preserved } = this.legacy;
    const workspaces: Record<string, unknown> = {};
    for (const id of new Set([...Object.keys(this.workspaces), ...Object.keys(preserved.workspaces), ...Object.keys(this.retired.workspaces)])) {
      const entry = { ...this.workspaces[id], ...preserved.workspaces[id], ...this.retired.workspaces[id] };
      if (Object.keys(entry).length > 0) workspaces[id] = entry;
    }
    const withLegacy = withLegacyGlobal(this.globalPatch, preserved.global);
    const global = Object.keys(this.retired.global).length > 0 ? { ...withLegacy, [RETIRED_GLOBAL_KEY]: this.retired.global } : withLegacy;
    return { global, workspaces };
  }

  private persist(): void {
    writeFileSync(this.path, stringify(this.snapshot()));
    this.loadedMtimeMs = statSync(this.path).mtimeMs;
  }

  /** A boot that changed nothing leaves the file's bytes alone, so the keys an ADR-0042 rollback reads are never reformatted. */
  private persistUnlessCurrent(): void {
    try {
      const onDisk = parse(readFileSync(this.path, 'utf8')) as RawSettingsFile | null;
      const current = { global: onDisk?.global ?? {}, workspaces: onDisk?.workspaces ?? {} };
      if (isDeepStrictEqual(current, parse(stringify(this.snapshot())))) {
        this.loadedMtimeMs = statSync(this.path).mtimeMs;
        return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
    this.persist();
  }
}
