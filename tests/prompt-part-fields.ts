import { fragmentKey, partLabel, templateKey, type PartKey } from '../src/domain/prompt-anatomy.js';
import { PROMPT_FRAGMENT_NAMES } from '../src/domain/prompt-fragments.js';
import { PROMPT_TEMPLATE_IDS } from '../src/domain/prompt-templates.js';
import { errorKey, fieldId, type EditableRef } from '../web/src/components/prompts/prompts-tab-model.js';

export interface PromptPartFieldInfo {
  key: PartKey;
  label: string;
  globalId: string;
  workspaceId: string | null;
}

function fieldInfo(key: PartKey, ref: EditableRef): PromptPartFieldInfo {
  return {
    key,
    label: partLabel(key),
    globalId: fieldId(ref, 'global'),
    workspaceId: errorKey(ref, 'workspace') === null ? null : fieldId(ref, 'workspace'),
  };
}

export const PROMPT_PART_FIELDS: readonly PromptPartFieldInfo[] = [
  ...PROMPT_TEMPLATE_IDS.map((id) => fieldInfo(templateKey(id), { kind: 'template', id })),
  ...PROMPT_FRAGMENT_NAMES.map((name) => fieldInfo(fragmentKey(name), { kind: 'fragment', name })),
];
