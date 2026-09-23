import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { settings } from '../db/schema.js';

const stableVersion = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const prereleaseVersion = /^(?:v)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const npmPackage = z.object({
  'dist-tags': z.object({ latest: z.string() }),
});

type StableVersion = readonly [string, string, string];

function parseStableVersion(version: string): StableVersion | null {
  const match = stableVersion.exec(version);
  if (match === null) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return [major, minor, patch];
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

/** Returns null unless both inputs name stable semantic versions. */
export function compareStableVersions(left: string, right: string): number | null {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  if (leftParts === null || rightParts === null) return null;

  const [leftMajor, leftMinor, leftPatch] = leftParts;
  const [rightMajor, rightMinor, rightPatch] = rightParts;
  for (const difference of [
    compareNumericIdentifiers(leftMajor, rightMajor),
    compareNumericIdentifiers(leftMinor, rightMinor),
    compareNumericIdentifiers(leftPatch, rightPatch),
  ]) {
    if (difference !== 0) return difference;
  }
  return 0;
}

export interface UpdateCheckOptions {
  version: string;
  latest: () => Promise<string>;
  store: UpdateAvailabilityStore;
}

export interface UpdateAvailabilityStore {
  get(): Promise<string | null>;
  set(version: string | null): Promise<void>;
}

const UPDATE_AVAILABILITY_KEY = 'update-availability';
const persistedAvailability = z.object({
  version: z.string().nullable(),
  armedVersion: z.string().nullable().optional(),
  upgradingVersion: z.string().nullable().optional(),
  autoRunnerWasEnabled: z.boolean().nullable().optional(),
  dismissedVersion: z.string().nullable().optional(),
  failedReason: z.string().nullable().optional(),
  failedAt: z.string().nullable().optional(),
});

export type UpdatePhase =
  | { kind: 'unarmed' }
  | { kind: 'armed'; targetVersion: string; autoRunnerWasEnabled: boolean }
  | { kind: 'upgrading'; targetVersion: string; autoRunnerWasEnabled: boolean }
  /** A boot found the running version didn't match the armed target: the swap never completed. */
  | { kind: 'failed'; targetVersion: string; reason: string; at: string };

export type UpdateAvailabilityState = {
  version: string | null;
  dismissedVersion: string | null;
  phase: UpdatePhase;
};

export interface UpdateArmingStore extends UpdateAvailabilityStore {
  getState(): Promise<UpdateAvailabilityState>;
  setState(state: UpdateAvailabilityState): Promise<void>;
}

function parsePersisted(row: { value: string } | undefined): UpdateAvailabilityState {
  if (row === undefined) return { version: null, dismissedVersion: null, phase: { kind: 'unarmed' } };
  try {
    const parsed = persistedAvailability.safeParse(JSON.parse(row.value));
    if (!parsed.success) return { version: null, dismissedVersion: null, phase: { kind: 'unarmed' } };
    const state = {
      version: parsed.data.version,
      dismissedVersion: parsed.data.dismissedVersion ?? null,
    };
    const armedVersion = parsed.data.armedVersion ?? null;
    if (armedVersion === null) return { ...state, phase: { kind: 'unarmed' } };
    const failedReason = parsed.data.failedReason ?? null;
    if (failedReason !== null) {
      const at = parsed.data.failedAt ?? new Date(0).toISOString();
      return { ...state, phase: { kind: 'failed', targetVersion: armedVersion, reason: failedReason, at } };
    }
    const autoRunnerWasEnabled = parsed.data.autoRunnerWasEnabled ?? false;
    const upgradingVersion = parsed.data.upgradingVersion;
    if (upgradingVersion === armedVersion) return { ...state, phase: { kind: 'upgrading', targetVersion: armedVersion, autoRunnerWasEnabled } };
    return { ...state, phase: { kind: 'armed', targetVersion: armedVersion, autoRunnerWasEnabled } };
  } catch {
    // Corrupt/legacy stored JSON degrades to "no known update" rather than crashing the update check.
    return { version: null, dismissedVersion: null, phase: { kind: 'unarmed' } };
  }
}

function serialize(state: UpdateAvailabilityState): string {
  const phase = state.phase;
  return JSON.stringify({
    version: state.version,
    dismissedVersion: state.dismissedVersion,
    armedVersion: phase.kind === 'unarmed' ? null : phase.targetVersion,
    upgradingVersion: phase.kind === 'upgrading' ? phase.targetVersion : null,
    autoRunnerWasEnabled: phase.kind === 'armed' || phase.kind === 'upgrading' ? phase.autoRunnerWasEnabled : null,
    failedReason: phase.kind === 'failed' ? phase.reason : null,
    failedAt: phase.kind === 'failed' ? phase.at : null,
  } satisfies z.infer<typeof persistedAvailability>);
}

export class SettingsUpdateAvailabilityStore implements UpdateArmingStore {
  constructor(private readonly db: AsyncDbHandle) {}

  async get(): Promise<string | null> {
    return (await this.getState()).version;
  }

  async getState(): Promise<UpdateAvailabilityState> {
    const row = await this.db.read((db) =>
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, UPDATE_AVAILABILITY_KEY)).get(),
    );
    return parsePersisted(row);
  }

  /** Updates only `version`, reading the current row inside the same
   * serialised write so it can't race a concurrent `setState` (e.g. an arm)
   * landing between a separate read and write and clobbering it with a stale
   * merge (issue #8). */
  async set(version: string | null): Promise<void> {
    await this.db.write(async (db) => {
      const row = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, UPDATE_AVAILABILITY_KEY)).get();
      const value = serialize({ ...parsePersisted(row), version });
      await db
        .insert(settings)
        .values({ key: UPDATE_AVAILABILITY_KEY, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
    });
  }

  async setState(state: UpdateAvailabilityState): Promise<void> {
    const value = serialize(state);
    await this.db.write((db) =>
      db
        .insert(settings)
        .values({ key: UPDATE_AVAILABILITY_KEY, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run(),
    );
  }
}

export class UpdateCheck {
  constructor(private readonly options: UpdateCheckOptions) {}

  getAvailableVersion(): Promise<string | null> {
    return this.options.store.get();
  }

  async run(): Promise<void> {
    const latest = await this.options.latest();
    if (prereleaseVersion.test(latest) || prereleaseVersion.test(this.options.version)) return;
    const comparison = compareStableVersions(latest, this.options.version);
    if (comparison === null) throw new Error(`npm registry returned an invalid latest version: ${latest}`);
    await this.options.store.set(comparison > 0 ? latest : null);
  }
}

export async function fetchLatestVersion(): Promise<string> {
  const response = await fetch('https://registry.npmjs.org/@mintopia%2Fharmonic');
  if (!response.ok) throw new Error(`npm registry request failed: ${response.status} ${response.statusText}`.trim());
  const parsed = npmPackage.safeParse(await response.json());
  if (!parsed.success) throw new Error('npm registry response has no latest dist-tag');
  return parsed.data['dist-tags'].latest;
}
