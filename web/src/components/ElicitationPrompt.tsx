import { useEffect, useMemo, useRef, useState } from 'react';
import type { ElicitationAnswer, ElicitationField } from '../types';
import type { PendingElicitation } from '../conversation-elicitations-model';
import { Markdown } from './Markdown';
import { btnPrimary, btnQuiet, field as fieldClass } from '../ui';

type FieldValue = string | string[] | boolean;

const optionBase =
  'flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left text-[13px] transition-colors duration-150';
const optionOn = 'border-accent bg-accent-tint text-ink';
const optionOff = 'border-hairline bg-surface text-ink hover:border-faint';

function OptionButton({
  selected,
  disabled,
  onClick,
  option,
}: {
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  option: NonNullable<ElicitationField['options']>[number];
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={onClick}
      className={`${optionBase} ${selected ? optionOn : optionOff} disabled:opacity-50`}
    >
      <span className="font-semibold">{option.label}</span>
      {option.description && <span className="text-[12px] text-muted">{option.description}</span>}
      {option.preview && (
        <pre className="mt-1 max-h-40 w-full overflow-auto rounded bg-sunken px-2 py-1.5 font-data text-[11px] leading-[1.5] text-muted">
          {option.preview}
        </pre>
      )}
    </button>
  );
}

function Field({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ElicitationField;
  value: FieldValue | undefined;
  disabled: boolean;
  onChange: (value: FieldValue) => void;
}) {
  const options = field.options ?? [];
  return (
    <div>
      {field.title && <p className="mb-0.5 text-[13px] font-semibold text-ink">{field.title}</p>}
      {field.description && <p className="mb-1.5 text-[13px] text-muted">{field.description}</p>}
      {field.kind === 'select' && (
        <div role="listbox" className="flex flex-col gap-1.5">
          {options.map((option) => (
            <OptionButton
              key={option.value}
              option={option}
              disabled={disabled}
              selected={value === option.value}
              onClick={() => onChange(option.value)}
            />
          ))}
        </div>
      )}
      {field.kind === 'multiselect' && (
        <div role="listbox" aria-multiselectable className="flex flex-col gap-1.5">
          {options.map((option) => {
            const list = Array.isArray(value) ? value : [];
            const on = list.includes(option.value);
            return (
              <OptionButton
                key={option.value}
                option={option}
                disabled={disabled}
                selected={on}
                onClick={() => onChange(on ? list.filter((v) => v !== option.value) : [...list, option.value])}
              />
            );
          })}
        </div>
      )}
      {field.kind === 'text' && (
        <textarea
          aria-label={field.title ?? field.description ?? 'Answer'}
          className={`${fieldClass} min-h-11 w-full resize-none`}
          rows={2}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.kind === 'boolean' && (
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.title ?? 'Yes'}
        </label>
      )}
    </div>
  );
}

function buildContent(fields: ElicitationField[], values: Record<string, FieldValue>): Record<string, FieldValue> {
  const content: Record<string, FieldValue> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.kind === 'multiselect') {
      if (Array.isArray(v) && v.length > 0) content[f.key] = v;
    } else if (f.kind === 'boolean') {
      if (v === true) content[f.key] = true;
    } else if (typeof v === 'string' && v.trim() !== '') {
      content[f.key] = v;
    }
  }
  return content;
}

/**
 * The form for a structured question a Harness is blocked on (ACP form
 * elicitation — AskUserQuestion, a refusal-fallback consent prompt, or an MCP
 * server's own elicitation). Renders each field by kind (single/multi select,
 * free text, boolean), and answers with `accept` (the chosen values), `decline`
 * (Skip — the harness is told nothing was chosen), or `cancel` (Dismiss —
 * aborts the asking tool call).
 */
export function ElicitationPrompt({
  pending,
  onAnswer,
}: {
  pending: PendingElicitation;
  onAnswer: (pending: PendingElicitation, answer: ElicitationAnswer) => Promise<void>;
}) {
  const { message, fields } = pending.request;
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [busy, setBusy] = useState(false);

  const firstRef = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    firstRef.current?.querySelector<HTMLElement>('button, textarea, input')?.focus();
    setAnnouncement('The agent is asking a question. This turn is paused until you answer.');
  }, [pending.reqId]);

  const canSubmit = useMemo(() => Object.keys(buildContent(fields, values)).length > 0, [fields, values]);

  const answer = async (a: ElicitationAnswer) => {
    if (busy) return;
    setBusy(true);
    try {
      await onAnswer(pending, a);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="group"
      aria-label="Question from the agent"
      className="flex max-h-[55vh] flex-col border-t border-hairline bg-running-tint"
    >
      <div role="alert" className="sr-only">
        {announcement}
      </div>
      {/* The form can be taller than the panel, so its body scrolls while the
          action row below stays pinned — Submit/Skip are always reachable. */}
      <div ref={firstRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className="text-title font-semibold text-ink">The agent is asking a question</p>
        <Markdown source={message} className="mb-3 mt-1 text-[13.5px] leading-relaxed text-ink" />
        <div className="flex flex-col gap-3">
          {fields.map((f) => (
            <Field
              key={f.key}
              field={f}
              value={values[f.key]}
              disabled={busy}
              onChange={(v) => setValues((current) => ({ ...current, [f.key]: v }))}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-hairline px-4 py-2.5">
        <button
          type="button"
          className={btnPrimary}
          disabled={busy || !canSubmit}
          onClick={() => answer({ action: 'accept', content: buildContent(fields, values) })}
        >
          Submit
        </button>
        <button type="button" className={`${btnQuiet} disabled:opacity-50`} disabled={busy} onClick={() => answer({ action: 'decline' })}>
          Skip
        </button>
      </div>
    </div>
  );
}
