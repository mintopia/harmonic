import { z } from 'zod';

/** The label strings a Resolved Tracker uses for the roles Harmonic acts on. */
export const triageLabelsSchema = z.object({
  readyForAgent: z.string().min(1),
  readyForHuman: z.string().min(1),
  epic: z.string().min(1),
  wayfinderMap: z.string().min(1),
});
export type TriageLabels = z.infer<typeof triageLabelsSchema>;

/** A Workspace's explicit Triage Labels setting: any subset of the roles. */
export const triageLabelsOverrideSchema = triageLabelsSchema.partial().strict();
export type TriageLabelsOverride = z.infer<typeof triageLabelsOverrideSchema>;

export const DEFAULT_TRIAGE_LABELS: TriageLabels = {
  readyForAgent: 'ready-for-agent',
  readyForHuman: 'ready-for-human',
  epic: 'epic',
  wayfinderMap: 'wayfinder:map',
};

const ROLE_BY_CANONICAL_LABEL: Readonly<Record<string, keyof TriageLabels>> = {
  'ready-for-agent': 'readyForAgent',
  'ready-for-human': 'readyForHuman',
  epic: 'epic',
  'wayfinder:map': 'wayfinderMap',
};

const stripCode = (cell: string): string => cell.trim().replace(/^`+|`+$/g, '').trim();

/** The roles named by the role table of a `docs/agents/triage-labels.md`: canonical label in column one, this tracker's label in column two. */
export function parseTriageLabelsDoc(markdown: string): TriageLabelsOverride {
  const out: TriageLabelsOverride = {};
  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|');
    const role = ROLE_BY_CANONICAL_LABEL[stripCode(cells[0] ?? '')];
    const label = stripCode(cells[1] ?? '');
    if (role && label) out[role] = label;
  }
  return out;
}

/** Which layer supplied each role's label. */
export type TriageLabelSource = 'workspace' | 'repo' | 'default';

export interface ResolvedTriageLabels {
  labels: TriageLabels;
  sources: Record<keyof TriageLabels, TriageLabelSource>;
}

/** Resolve Triage Labels per role: the Workspace setting, else the repo's role table, else the instance defaults. */
export function resolveTriageLabels(
  workspace: TriageLabelsOverride | null | undefined,
  repoDoc: string | null | undefined,
): ResolvedTriageLabels {
  const repo = repoDoc ? parseTriageLabelsDoc(repoDoc) : {};
  const labels = { ...DEFAULT_TRIAGE_LABELS };
  const sources = { readyForAgent: 'default', readyForHuman: 'default', epic: 'default', wayfinderMap: 'default' } as Record<keyof TriageLabels, TriageLabelSource>;
  for (const role of Object.keys(labels) as (keyof TriageLabels)[]) {
    const fromWorkspace = workspace?.[role];
    const fromRepo = repo[role];
    if (fromWorkspace) { labels[role] = fromWorkspace; sources[role] = 'workspace'; }
    else if (fromRepo) { labels[role] = fromRepo; sources[role] = 'repo'; }
  }
  return { labels, sources };
}
