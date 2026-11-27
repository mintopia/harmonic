import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { settings } from '../db/schema.js';
import { compareStableVersions, isStableVersion, newestStableInMajor } from '../domain/stable-version.js';

const execFileAsync = promisify(execFile);

const npmVersionList = z.array(z.string()).nonempty();
// npm 12 made `npm view --json` always wrap its result in an array; npm 10 prints a lone version as a bare string.
const npmVersions = z.union([
  z.string().transform((version) => [version]),
  npmVersionList,
  z.tuple([npmVersionList]).transform(([versions]) => versions),
]);

export interface UpdateCheckOptions {
  version: string;
  /** Every version published to npm, prereleases included. */
  published: () => Promise<readonly string[]>;
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

  /** Updates only `version`, reading the current row inside the same serialised write. */
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

  /** Never offers a later major: moving to one is a deliberate manual install. */
  async run(): Promise<void> {
    const published = await this.options.published();
    if (!isStableVersion(this.options.version)) return;
    const newest = newestStableInMajor(published, this.options.version);
    const newer = newest !== null && (compareStableVersions(newest, this.options.version) ?? 0) > 0;
    await this.options.store.set(newer ? newest : null);
  }
}

/** Goes through `npm view`, not a direct registry fetch, so it resolves the same
 * registry/auth config as the actual install in `version-install.ts`. */
export async function fetchPublishedVersions(): Promise<readonly string[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('npm', ['view', '@mintopia/harmonic', 'versions', '--json'], { timeout: 15_000 }));
  } catch (error) {
    throw new Error(`npm registry request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsePublishedVersions(stdout);
}

export function parsePublishedVersions(stdout: string): readonly string[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error('npm registry response was not valid JSON');
  }
  const parsed = npmVersions.safeParse(json);
  if (!parsed.success) throw new Error('npm registry response has no version list');
  return parsed.data;
}
