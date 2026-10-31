import type { AppConfig } from '../types.js';

export type HarnessChoice = { models: string[]; defaultModel: string };

export type HarnessChoices = { defaultHarness: string; byId: Record<string, HarnessChoice> };

/** The Harness new routes and Critics start on: the configured default when it exists, else the first configured one. */
export function defaultHarnessId(config: Pick<AppConfig, 'defaults' | 'harnesses'>): string {
  return config.defaults.harness in config.harnesses ? config.defaults.harness : (Object.keys(config.harnesses)[0] ?? '');
}

export function harnessChoices(config: Pick<AppConfig, 'defaults' | 'harnesses'>): HarnessChoices {
  return {
    defaultHarness: defaultHarnessId(config),
    byId: Object.fromEntries(
      Object.entries(config.harnesses).map(([id, harness]): [string, HarnessChoice] => [
        id,
        { models: harness.models.map((m) => m.id), defaultModel: harness.defaultModel },
      ]),
    ),
  };
}

type GlobalOverlayEntry = { kind: 'global'; ref: string; enabled: boolean };

/**
 * Appends any global id not already referenced in the overlay, enabled, at
 * the end — mirrors the runtime merge (ADR-0037: "any global not named in the
 * overlay is appended, enabled") so the editor always displays what will
 * actually run, including a global added after the Workspace was last saved.
 * `overlay: null` (inherit everything) renders as all globals, in order.
 */
export function withMissingGlobals<O extends GlobalOverlayEntry | { kind: 'local' }>(
  overlay: readonly O[] | null,
  globalIds: readonly string[],
): O[] {
  const base = overlay ? [...overlay] : [];
  const seen = new Set(
    base.filter((entry): entry is Extract<O, GlobalOverlayEntry> => entry.kind === 'global').map((entry) => entry.ref),
  );
  const missing = globalIds
    .filter((id) => !seen.has(id))
    .map((ref) => ({ kind: 'global', ref, enabled: true }) as O);
  return [...base, ...missing];
}
