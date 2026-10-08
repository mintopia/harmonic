import { Fragment, type KeyboardEvent, type ReactNode } from 'react';
import { partLabel, type PartKey, type PromptAnatomy } from '../../../../src/domain/prompt-anatomy.js';
import { labelType } from '../../ui';
import { Icon } from '../Icon';
import { anatomyLayout, anatomySelectors, isConditionalKey, stepOfKey, type SelectorChoice } from './prompts-tab-model';
import type { PreviewSegment, SampleConditions } from '../../prompt-preview-model';

function renderChildren(children: readonly (string | PreviewSegment)[], expandedKey: PartKey | null): ReactNode {
  return children.map((child, i) =>
    typeof child === 'string' ? (
      <Fragment key={i}>{child}</Fragment>
    ) : (
      <mark
        key={i}
        className={child.key !== null && child.key === expandedKey ? 'rounded-sm bg-accent-tint text-accent' : 'bg-transparent text-ink'}
      >
        {renderChildren(child.children, expandedKey)}
      </mark>
    ),
  );
}

function FlagToggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-small transition-colors ${
        on ? 'border-transparent bg-accent-tint text-accent' : 'border-edge text-muted hover:border-edge-strong hover:text-ink'
      }`}
    >
      {on && <Icon name="check" />}
      {label}
    </button>
  );
}

function Segmented({ selector, value, onChange }: { selector: SelectorChoice; value: string; onChange: (value: string) => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const values = selector.options.map((o) => o.value);
    const at = values.indexOf(value);
    let next = at;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % values.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + values.length) % values.length;
    else return;
    e.preventDefault();
    const target = values[next];
    if (target === undefined) return;
    onChange(target);
    e.currentTarget.querySelectorAll<HTMLElement>('[role=radio]')[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={selector.label} onKeyDown={onKeyDown} className="flex flex-wrap gap-1">
      {selector.options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            title={option.when}
            onClick={() => onChange(option.value)}
            className={`min-h-11 rounded-lg border px-3 text-small transition-colors ${
              checked ? 'border-accent bg-accent-tint text-accent' : 'border-edge text-muted hover:border-edge-strong hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function sampleCaption(anatomy: PromptAnatomy, selectors: readonly SelectorChoice[], c: SampleConditions): string {
  const chosen = selectors.map((s) => {
    const value = c.choices[s.by] ?? anatomy.selectorDefaults[s.by];
    return s.options.find((o) => o.value === value)?.label;
  });
  const on = anatomy.flags.filter((f) => c.flags[f.id]).map((f) => f.toggle);
  const parts = [...chosen, ...on].filter((p): p is string => p !== undefined);
  return `Sample: ${parts.length > 0 ? parts.join(' · ') : 'no conditions'}`;
}

export function CompiledPreviewPane({
  anatomy,
  segments,
  expandedKey,
  conditions,
  onFlag,
  onChoice,
}: {
  anatomy: PromptAnatomy;
  segments: readonly PreviewSegment[];
  expandedKey: PartKey | null;
  conditions: SampleConditions;
  onFlag: (id: string, on: boolean) => void;
  onChoice: (by: string, value: string) => void;
}) {
  const layout = anatomyLayout(anatomy);
  const selectors = anatomySelectors(anatomy);
  return (
    <section aria-label="Compiled preview" className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className={`${labelType} text-faint`}>Compiled preview</h3>
        <span className="text-small text-faint">{sampleCaption(anatomy, selectors, conditions)}</span>
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {segments.length === 0 && <p className="text-small text-muted">Nothing is sent under these conditions.</p>}
        {segments.map((segment, i) => {
          const key = segment.key;
          const step = key === null ? null : stepOfKey(layout, key);
          const conditional = key !== null && isConditionalKey(layout, key);
          const highlighted = key !== null && key === expandedKey;
          return (
            <div
              key={`${key ?? 'built-in'}:${i}`}
              className={`border-l-2 pl-2.5 ${conditional ? 'border-dashed' : ''} ${highlighted ? 'border-accent' : 'border-edge'}`}
            >
              <span className={`block ${labelType} text-faint`}>
                {step !== null && `${step} · `}
                {key === null ? 'Built in' : partLabel(key)}
              </span>
              <pre className="m-0 mt-1 whitespace-pre-wrap break-words font-data text-small text-muted">
                {renderChildren(segment.children, expandedKey)}
              </pre>
            </div>
          );
        })}
      </div>
      {(selectors.length > 0 || anatomy.flags.length > 0) && (
        <div className="mt-5">
          <h4 className={`mb-2 ${labelType} text-faint`}>Sample conditions</h4>
          <div className="flex flex-col gap-3">
            {selectors.map((s) => (
              <Segmented key={s.by} selector={s} value={conditions.choices[s.by] ?? anatomy.selectorDefaults[s.by] ?? ''} onChange={(v) => onChoice(s.by, v)} />
            ))}
            {anatomy.flags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {anatomy.flags.map((f) => (
                  <FlagToggle key={f.id} label={f.toggle} on={conditions.flags[f.id] ?? false} onChange={(on) => onFlag(f.id, on)} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
