import type { ReactNode } from 'react';
import { PROMPT_FRAGMENTS } from '../../../../src/domain/prompt-fragments.js';
import { partHelp, partLabel, type PartKey } from '../../../../src/domain/prompt-anatomy.js';
import { field } from '../../ui';
import { LayerField } from '../LayerField';
import { PromptField } from '../SettingsSection';
import type { RenderCtx } from '../settings-schema';
import { editableState, fieldId, partRef, placeholdersForKey, writePart, type EditableRef } from './prompts-tab-model';

function descriptionFor(key: PartKey, ref: EditableRef): string {
  if (ref.kind === 'template') return partHelp(key);
  const required = PROMPT_FRAGMENTS[ref.name].required.map((token) => `{${token}}`).join(' ');
  return `${partHelp(key)}${required ? ` Must keep ${required}.` : ''}`;
}

const textareaClass = `${field} font-data min-h-36`;

function PromptPartField({ partKey, target, ctx }: { partKey: PartKey; target: EditableRef; ctx: RenderCtx }) {
  const state = editableState(target, ctx);
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
          placeholders={placeholdersForKey(partKey)}
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
