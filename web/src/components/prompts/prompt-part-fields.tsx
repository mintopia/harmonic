import type { ReactNode } from 'react';
import { PROMPT_FRAGMENTS, PROMPT_FRAGMENT_NAMES } from '../../../../src/domain/prompt-fragments.js';
import { partHelp, partLabel, templateKey, type PartKey } from '../../../../src/domain/prompt-anatomy.js';
import { PROMPT_TEMPLATE_IDS } from '../../../../src/domain/prompt-templates.js';
import { field } from '../../ui';
import { fragmentPlaceholders, type Placeholder } from '../../prompt-preview-model';
import { LayerField } from '../LayerField';
import { PromptField } from '../SettingsSection';
import type { RenderCtx } from '../settings-schema';
import { errorKey, fieldId, partRef, partState, writePart, type EditableRef } from './prompts-tab-model';
import { TEMPLATE_PLACEHOLDERS } from '../../prompt-preview-model';

export interface PromptPartFieldInfo {
  key: PartKey;
  label: string;
  globalId: string;
  workspaceId: string | null;
  globalErrorKey: string;
  workspaceErrorKey: string | null;
}

function fieldInfo(key: PartKey, ref: EditableRef): PromptPartFieldInfo {
  const workspaceErrorKey = errorKey(ref, 'workspace');
  return {
    key,
    label: partLabel(key),
    globalId: fieldId(ref, 'global'),
    workspaceId: workspaceErrorKey === null ? null : fieldId(ref, 'workspace'),
    globalErrorKey: errorKey(ref, 'global') ?? '',
    workspaceErrorKey,
  };
}

export const PROMPT_PART_FIELDS: readonly PromptPartFieldInfo[] = [
  ...PROMPT_TEMPLATE_IDS.map((id) => fieldInfo(templateKey(id), { kind: 'template', id })),
  ...PROMPT_FRAGMENT_NAMES.map((name) => fieldInfo(`fragment:${name}`, { kind: 'fragment', name })),
];

function placeholdersFor(ref: EditableRef): Placeholder[] {
  return ref.kind === 'template' ? TEMPLATE_PLACEHOLDERS[ref.id] : fragmentPlaceholders(ref.name);
}

function descriptionFor(key: PartKey, ref: EditableRef): string {
  if (ref.kind === 'template') return partHelp(key);
  const required = PROMPT_FRAGMENTS[ref.name].required.map((token) => `{${token}}`).join(' ');
  return `${partHelp(key)}${required ? ` Must keep ${required}.` : ''}`;
}

const textareaClass = `${field} font-data min-h-36`;

function PromptPartField({ partKey, target, ctx }: { partKey: PartKey; target: EditableRef; ctx: RenderCtx }) {
  const state = partState(partKey, ctx);
  if (!state) return null;
  const id = fieldId(target, ctx.surface);
  if (!state.editable) {
    return (
      <figure className="m-0">
        <figcaption className="mb-1.5 text-small text-muted">Global only — not overridable per Workspace</figcaption>
        <pre id={id} className="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-raised p-2.5 font-data text-small text-ink">
          {state.value}
        </pre>
      </figure>
    );
  }
  return (
    <LayerField<string>
      label={partLabel(partKey)}
      htmlFor={id}
      value={state.value}
      inheritedValue={state.inheritedValue}
      inherited={!state.modified}
      dim={ctx.surface === 'workspace'}
      hideLabel
      onChange={(next) => writePart(partKey, ctx, next)}
      onRevert={() => writePart(partKey, ctx, null)}
    >
      {({ id: inputId, value, onChange }) => (
        <PromptField
          id={inputId ?? id}
          description={descriptionFor(partKey, target)}
          value={value}
          onChange={onChange}
          placeholders={placeholdersFor(target)}
          error={state.error}
          textareaClass={textareaClass}
        />
      )}
    </LayerField>
  );
}

export function renderPromptPart(key: PartKey, ctx: RenderCtx): ReactNode {
  const target = partRef(key);
  if (target.kind === 'critic') return null;
  return <PromptPartField partKey={key} target={target} ctx={ctx} />;
}
