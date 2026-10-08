import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { partAnatomies, partLabel, type AnatomyFlag, type AnatomyPart, type PartKey } from '../../../../src/domain/prompt-anatomy.js';
import { fragmentPlaceholders, type Placeholder } from '../../prompt-preview-model';
import { Icon } from '../Icon';
import type { RenderCtx } from '../settings-schema';
import { renderPromptPart } from './prompt-part-fields';
import { partRef, partState } from './prompts-tab-model';
import { TEMPLATE_PLACEHOLDERS } from '../../prompt-preview-model';

type TagTone = 'template' | 'fragment' | 'conditional' | 'modified' | 'fail' | 'accent';

const TAG_TONE: Record<TagTone, string> = {
  template: 'bg-accent-tint text-accent',
  fragment: 'bg-raised text-muted',
  conditional: 'border border-dashed border-edge-strong text-faint',
  modified: 'bg-running-tint text-running',
  fail: 'bg-fail-tint text-fail',
  accent: 'bg-accent-tint text-accent',
};

export function Tag({ tone, title, children }: { tone: TagTone; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={`min-w-0 max-w-full rounded-xl px-2 py-0.5 text-small ${TAG_TONE[tone]}`}>
      {children}
    </span>
  );
}

const SUMMARY_CHIPS = 4;

export const excerptOf = (text: string): string => text.trim().replace(/\s*\n\s*/g, ' ⏎ ');

function placeholdersFor(key: PartKey): Placeholder[] {
  const ref = partRef(key);
  if (ref.kind === 'template') return TEMPLATE_PLACEHOLDERS[ref.id];
  if (ref.kind === 'fragment') return fragmentPlaceholders(ref.name);
  return [];
}

function ChipSummary({ placeholders }: { placeholders: Placeholder[] }) {
  if (placeholders.length === 0) return null;
  const shown = placeholders.slice(0, SUMMARY_CHIPS);
  const more = placeholders.length - shown.length;
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {shown.map((p) => (
        <span
          key={p.token}
          className={`rounded-md border px-1.5 py-0.5 font-data text-small leading-none ${
            p.core ? 'border-transparent bg-accent-tint text-accent' : 'border-edge text-muted'
          }`}
        >
          {p.token}
        </span>
      ))}
      {more > 0 && <span className="text-small text-faint">+{more}</span>}
    </span>
  );
}

export function nestedCaption(parentKey: PartKey | null, key: PartKey, via: AnatomyPart['via']): string | null {
  if (parentKey === null) return null;
  const ref = partRef(key);
  if (via === 'reference' && ref.kind === 'fragment') return `Shared · {fragment.${ref.name}}`;
  return `inside ${partLabel(parentKey)}`;
}

export function PartCard({
  part,
  ctx,
  flag,
  parentKey,
  open,
  onToggle,
  onCollapse,
  children,
}: {
  part: AnatomyPart;
  ctx: RenderCtx;
  flag: AnatomyFlag | undefined;
  parentKey: PartKey | null;
  open: boolean;
  onToggle: () => void;
  onCollapse: () => void;
  children?: ReactNode;
}) {
  const { key } = part;
  const ref = partRef(key);
  const state = partState(key, ctx);
  const headerRef = useRef<HTMLButtonElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) regionRef.current?.querySelector('textarea')?.focus();
    wasOpen.current = open;
  }, [open]);

  const label = partLabel(key);
  const caption = nestedCaption(parentKey, key, part.via);
  const sharedWith = partAnatomies(key);
  const tags = (
    <>
      {ref.kind === 'template' && <Tag tone="template">Template</Tag>}
      {ref.kind === 'fragment' && <Tag tone="fragment">Fragment</Tag>}
      {caption && <Tag tone="fragment">{caption}</Tag>}
      {sharedWith.length > 1 && (
        <Tag tone="fragment" title={`Used in ${sharedWith.length} prompts`}>
          Shared
        </Tag>
      )}
      {flag && <Tag tone="conditional">{flag.label}</Tag>}
    </>
  );

  if (ref.kind === 'critic' || !state) {
    return (
      <div className="rounded-lg border border-hairline bg-shell p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold text-ink">{label}</span>
          <Tag tone="fragment">Per critic</Tag>
          {flag && <Tag tone="conditional">{flag.label}</Tag>}
        </div>
        <p className="mt-1 text-small text-muted">Each critic&apos;s own prompt — set per critic on the Verification tab.</p>
        <button
          type="button"
          className="mt-1 inline-flex min-h-11 items-center text-small font-medium text-accent hover:text-accent-hot"
          onClick={() => ctx.onTab?.('verification')}
        >
          Open Verification settings
        </button>
        {children}
      </div>
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onCollapse();
    headerRef.current?.focus();
  };

  const editorId = `prompt-part-editor-${key}`;
  const placeholders = placeholdersFor(key);
  return (
    <div
      className={`rounded-lg border bg-shell p-3 transition-colors ${
        open ? 'border-accent' : state.error ? 'border-fail' : 'border-hairline hover:border-edge-strong'
      }`}
    >
      <button
        ref={headerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? editorId : undefined}
        onClick={onToggle}
        className="block min-h-11 w-full text-left"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold text-ink">{label}</span>
          {tags}
          <span className="ml-auto flex items-center gap-1.5">
            {state.error !== undefined && <Tag tone="fail">Fix</Tag>}
            {state.modified && <Tag tone="modified">Modified</Tag>}
            <Icon name="chevron-down" className={`text-muted transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
          </span>
        </span>
        {!open && (
          <>
            {part.note && <span className="mt-1 block text-small text-muted">{part.note}</span>}
            <ChipSummary placeholders={placeholders} />
            <span data-excerpt className="mt-1.5 line-clamp-2 break-words font-data text-small text-muted">{excerptOf(state.value)}</span>
          </>
        )}
      </button>
      {open && (
        <div ref={regionRef} id={editorId} role="region" aria-label={label} onKeyDown={onKeyDown} className="mt-2">
          {part.note && <p className="mb-2 text-small text-muted">{part.note}</p>}
          {renderPromptPart(key, ctx)}
        </div>
      )}
      {children}
    </div>
  );
}
