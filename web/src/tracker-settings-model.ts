import type { TrackerResolveFailureCode } from '../../src/tracker/adapter.js';
import type { ResolutionRule } from './components/ResolutionStrip';
import type { CodeRepositoryKind, ResolvedTracker, TrackerSource, Workspace } from './types';

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

export type TriageRole = keyof NonNullable<TriageLabelsSetting>;
export type TriageLabelSource = 'configured' | 'repo-doc' | 'default';

export const TRIAGE_SOURCE_LABEL: Record<TriageLabelSource, string> = {
  configured: 'Configured',
  'repo-doc': 'Repo doc',
  default: 'Default',
};

export function triageLabelSource(
  role: TriageRole,
  configured: TriageLabelsSetting,
  repoDoc: NonNullable<TriageLabelsSetting> | null | undefined,
): TriageLabelSource {
  if (configured?.[role]) return 'configured';
  return repoDoc?.[role] ? 'repo-doc' : 'default';
}

const ORDINAL = ['1st', '2nd', '3rd'];

const TRACKER_RUNGS: { source: TrackerSource; name: string; note: string }[] = [
  { source: 'configured', name: 'Configured tracker', note: 'Set below' },
  { source: 'detected', name: 'Repo doc', note: 'docs/agents/issue-tracker.md' },
  { source: 'code-repository', name: 'Code Repository', note: 'The forge from step 1' },
];

export function trackerStripRules(resolved: ResolvedTracker | null | undefined): ResolutionRule[] {
  const used = resolved?.ok ? resolved.source : null;
  return TRACKER_RUNGS.map((rung, index) => {
    const inUse = rung.source === used;
    return {
      caption: `${ORDINAL[index]}${inUse ? ' · in use' : ''}`,
      name: rung.name,
      note: inUse && resolved?.ok ? resolved.label : rung.note,
      ...(inUse ? { always: true } : {}),
    };
  });
}
