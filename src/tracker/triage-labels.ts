import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseStoredJson } from './stored-json.js';

import { DEFAULT_TRIAGE_LABELS, triageLabelsOverrideSchema, type TriageLabels, type TriageLabelsOverride } from './triage-defaults.js';

export { DEFAULT_TRIAGE_LABELS, triageLabelsSchema, triageLabelsOverrideSchema, type TriageLabels, type TriageLabelsOverride } from './triage-defaults.js';

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

interface CachedDoc {
  mtimeMs: number;
  size: number;
  text: string;
}
const docCache = new Map<string, CachedDoc>();

/** The repo's `docs/agents/triage-labels.md`, re-read only when its mtime or size changes; null when absent. */
async function readTriageLabelsDoc(repoRoot: string): Promise<string | null> {
  const path = join(repoRoot, 'docs/agents/triage-labels.md');
  try {
    const { mtimeMs, size } = await stat(path);
    const cached = docCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.text;
    const text = await readFile(path, 'utf8');
    docCache.set(path, { mtimeMs, size, text });
    return text;
  } catch {
    docCache.delete(path);
    return null;
  }
}

/** A Workspace row's stored Triage Labels override, or null when unset or unreadable. */
export const storedTriageLabels = (text: string | null | undefined): TriageLabelsOverride | null =>
  parseStoredJson(triageLabelsOverrideSchema, text, 'Triage Labels setting');

/** The Triage Labels in force for a Workspace: its override, else the repo's role table, else the defaults. */
export async function loadTriageLabels(repoRoot: string, override: TriageLabelsOverride | null | undefined): Promise<TriageLabels> {
  return resolveTriageLabels(override, await readTriageLabelsDoc(repoRoot)).labels;
}
