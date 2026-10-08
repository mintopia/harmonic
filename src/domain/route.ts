import type { HarnessConfig } from '../config.js';
import type { EscalationCause } from './task-routing.js';

interface HarnessRegistry {
  harnesses: Readonly<Partial<Record<string, HarnessConfig>>>;
}

export function harnessConfig(config: HarnessRegistry, id: string): HarnessConfig | undefined {
  return Object.entries(config.harnesses).find(([key]) => key === id)?.[1];
}

/** The Harness + Model a turn runs on, or why it cannot: the routed Harness is not configured. */
export type ResolvedRoute =
  | { ok: true; harness: string; model: string; label: string | null; config: HarnessConfig }
  | { ok: false; harness: string; label: string | null; reason: string; cause: EscalationCause };

export function unconfiguredHarnessReason(harness: string, label: string | null): string {
  return label
    ? `Routing Label '${label}' needs Harness '${harness}', which is not configured.`
    : `Harness '${harness}' is not configured.`;
}

export function resolveRoute(config: HarnessRegistry, harness: string, model: string, label: string | null): ResolvedRoute {
  const found = harnessConfig(config, harness);
  if (found) return { ok: true, harness, model, label, config: found };
  return {
    ok: false,
    harness,
    label,
    reason: unconfiguredHarnessReason(harness, label),
    cause: { kind: 'harness_unconfigured', harness, label },
  };
}
