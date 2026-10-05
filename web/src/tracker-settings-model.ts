import type { TrackerResolveFailureCode } from '../../src/tracker/adapter.js';
import type { CodeRepositoryKind, Workspace } from './types';

export type ConfiguredTracker = NonNullable<Workspace['configuredTracker']>;
export type TriageLabelsSetting = Workspace['triageLabels'];

export const RESOLVE_FAILURE_LABEL: Record<TrackerResolveFailureCode, string> = {
  'no-declaration': 'No Tracker declared',
  unsupported: 'Unsupported Tracker',
  misconfigured: 'Tracker misconfigured',
};

export const REPOSITORY_LABEL: Record<CodeRepositoryKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  forgejo: 'Forgejo',
  git: 'Plain git',
};

export const REPOSITORY_KINDS: readonly CodeRepositoryKind[] = Object.keys(REPOSITORY_LABEL).filter(isCodeRepositoryKind);

export function isCodeRepositoryKind(value: string): value is CodeRepositoryKind {
  return Object.hasOwn(REPOSITORY_LABEL, value);
}

export function parseCodeRepositoryOverride(raw: string): CodeRepositoryKind | null {
  return isCodeRepositoryKind(raw) ? raw : null;
}

export function applyTrackerSetting(
  kindId: string,
  current: Record<string, unknown> | undefined,
  key: string,
  next: unknown,
): ConfiguredTracker {
  const merged = { ...current };
  if (next === undefined) delete merged[key];
  else merged[key] = next;
  return { kind: kindId, ...(Object.keys(merged).length > 0 ? { settings: merged } : {}) };
}

export function applyTriageLabel(labels: TriageLabelsSetting, role: keyof NonNullable<TriageLabelsSetting>, raw: string): TriageLabelsSetting {
  const next = { ...labels, [role]: raw };
  for (const key of Object.keys(next) as (keyof typeof next)[]) if (!next[key]) delete next[key];
  return Object.keys(next).length > 0 ? next : null;
}
