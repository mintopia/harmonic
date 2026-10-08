import type { AnatomyId, PartKey, PromptAnatomy } from '../../../../src/domain/prompt-anatomy.js';
import { topLevelOrder } from '../../../../src/domain/prompt-anatomy.js';
import { resolvePromptFragments } from '../../../../src/domain/setting-override.js';
import type { PromptFragments } from '../../../../src/domain/prompt-fragments.js';
import type { PromptTemplateId } from '../../../../src/domain/prompt-templates.js';
import {
  COMMIT_NUDGE_PLACEHOLDERS,
  DRIVE_PLACEHOLDERS,
  EPIC_REFRESH_PLACEHOLDERS,
  EPIC_RESOLVE_PLACEHOLDERS,
  EPIC_RESOLVE_SUFFIX_PLACEHOLDERS,
  MERGE_CONFLICT_PLACEHOLDERS,
  TASK_ID_PLACEHOLDER,
  TASK_PLACEHOLDERS,
  type Placeholder,
} from '../../prompt-preview-model';
import type { AppConfig, Workspace } from '../../types';
import { anatomyById, templateText } from './prompts-tab-model';
import { partRef } from './prompts-tab-model';

export const TEMPLATE_PLACEHOLDERS: Record<PromptTemplateId, Placeholder[]> = {
  taskPrompt: TASK_PLACEHOLDERS,
  drivePrompt: DRIVE_PLACEHOLDERS,
  unattendedReminder: TASK_ID_PLACEHOLDER,
  continuePrompt: TASK_ID_PLACEHOLDER,
  commitNudge: COMMIT_NUDGE_PLACEHOLDERS,
  pauseMessage: [],
  mergeConflictPrompt: MERGE_CONFLICT_PLACEHOLDERS,
  epicConflictPrompt: MERGE_CONFLICT_PLACEHOLDERS,
  epicRefreshPrompt: EPIC_REFRESH_PLACEHOLDERS,
  epicResolvePrompt: EPIC_RESOLVE_PLACEHOLDERS,
  epicResolveSuffix: EPIC_RESOLVE_SUFFIX_PLACEHOLDERS,
};

export interface PromptSettingsView {
  template: (id: PromptTemplateId) => string;
  fragments: PromptFragments;
  criticPrompt: { issue: string; noIssue: string } | null;
}

export function promptSettingsView(ctx: { config: AppConfig; workspace?: Workspace | null }): PromptSettingsView {
  const workspace = ctx.workspace ?? null;
  return {
    template: (id) => templateText(id, ctx.config, workspace),
    fragments: resolvePromptFragments(workspace, ctx.config),
    criticPrompt: null,
  };
}

export interface SampleConditions {
  flags: Record<string, boolean>;
  choices: Record<string, string>;
}

export function defaultConditions(a: PromptAnatomy): SampleConditions {
  return { flags: Object.fromEntries(a.flags.map((f) => [f.id, f.sample])), choices: { ...a.selectorDefaults } };
}

export interface PreviewSegment {
  key: PartKey | null;
  children: (string | PreviewSegment)[];
}

export function assemblePreview(id: AnatomyId, view: PromptSettingsView, c: SampleConditions): PreviewSegment[] {
  return topLevelOrder(anatomyById(id), c.choices).map((key) => {
    const ref = partRef(key);
    const text = ref.kind === 'template' ? view.template(ref.id) : ref.kind === 'fragment' ? view.fragments[ref.name] : '';
    return { key, children: [text] };
  });
}
