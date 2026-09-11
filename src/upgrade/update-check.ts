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
  autoRunnerWasEnabled: z.boolean().nullable().optional(),
});

export interface UpdateAvailabilityState {
  version: string | null;
  armedVersion: string | null;
  autoRunnerWasEnabled: boolean | null;
}

export interface UpdateArmingStore extends UpdateAvailabilityStore {
  getState(): Promise<UpdateAvailabilityState>;
  setState(state: UpdateAvailabilityState): Promise<void>;
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
    if (row === undefined) return { version: null, armedVersion: null, autoRunnerWasEnabled: null };
    try {
      const parsed = persistedAvailability.safeParse(JSON.parse(row.value));
      if (!parsed.success) return { version: null, armedVersion: null, autoRunnerWasEnabled: null };
      return {
        version: parsed.data.version,
        armedVersion: parsed.data.armedVersion ?? null,
        autoRunnerWasEnabled: parsed.data.autoRunnerWasEnabled ?? null,
      };
    } catch {
      return { version: null, armedVersion: null, autoRunnerWasEnabled: null };
    }
  }

  async set(version: string | null): Promise<void> {
    const state = await this.getState();
    await this.setState({ ...state, version });
  }

  async setState(state: UpdateAvailabilityState): Promise<void> {
    const value = JSON.stringify(state satisfies z.infer<typeof persistedAvailability>);
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
