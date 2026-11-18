import { useEffect, useMemo, useRef, useState } from 'react';
import { railSections, unsavedChanges } from '../../prompt-library-model';
import type { Prompt } from '../../types';
import { btnGhost, btnPrimary, labelType, quietTag, searchField } from '../../ui';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { LoadError } from '../LoadError';
import { PromptEditStep } from './PromptEdit';
import { usePromptsFlow } from './PromptsFlow';
import { SourceBadge, Tag } from './SourceBadge';

const PANEL_BELOW_RAIL = '(max-width: 767px)';

export function PromptLibrary() {
  return (
    <div className="flex min-w-0 flex-col gap-4 md:flex-row md:items-start">
      <PromptRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <PromptPanel />
      </div>
    </div>
  );
}

const SECTION_HEAD = `${labelType} m-0 flex items-baseline justify-between px-4 pb-1.5 pt-4 text-muted`;

function PromptRail() {
  const flow = usePromptsFlow();
  const [query, setQuery] = useState('');
  const sections = useMemo(() => railSections(flow.prompts, flow.includeFragments, query), [flow.prompts, flow.includeFragments, query]);
  const hiddenFragments = flow.prompts.filter((p) => p.category === 'fragment').length;

  return (
    <nav aria-label="Prompts" className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-surface shadow-card md:sticky md:top-4 md:w-[300px] md:shrink-0">
      <div className="flex flex-col gap-3 border-b border-hairline p-3">
        <button type="button" className={btnPrimary} onClick={flow.startNew}>
          + New prompt
        </button>
        <label className="relative">
          <span className="sr-only">Search prompts</span>
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search prompts…" className={`${searchField} w-full pl-8`} />
        </label>
        <label className="flex min-h-7 items-center gap-2 text-small text-ink">
          <input type="checkbox" checked={flow.includeFragments} onChange={(e) => flow.setIncludeFragments(e.target.checked)} className="accent-accent" />
          Include engine fragments
        </label>
      </div>

      {flow.error && <div className="p-3"><LoadError message={flow.error} onRetry={flow.reload} /></div>}
      {!flow.loaded && !flow.error && <p className="p-3 text-muted">Loading prompts…</p>}

      <div className="flex max-h-[30rem] flex-col overflow-y-auto pb-3 md:max-h-[calc(100vh-14rem)]">
        {sections.map((section) => (
          <div key={section.category} data-rail-section={section.category} role="group" aria-labelledby={`rail-${section.category}`}>
            <h3 id={`rail-${section.category}`} className={SECTION_HEAD}>
              <span>{section.label}</span>
              <span className="font-normal">{section.prompts.length}</span>
            </h3>
            <ul className="m-0 flex list-none flex-col p-0">
              {section.prompts.map((p) => (
                <RailRow key={p.code} prompt={p} />
              ))}
            </ul>
          </div>
        ))}
        {flow.loaded && !flow.includeFragments && hiddenFragments > 0 && query.trim() === '' && (
          <div data-testid="fragment-hint" role="group" aria-labelledby="rail-fragment-hint">
            <h3 id="rail-fragment-hint" className={SECTION_HEAD}>
              <span>Engine fragments</span>
              <span className="font-normal">{hiddenFragments}</span>
            </h3>
            <p className="m-0 px-4 py-2 text-body text-muted">
              Internal building blocks the engine assembles for you. Hidden from search by default — tick “Include engine fragments” to edit them.
            </p>
          </div>
        )}
      </div>

      {flow.loaded && sections.length === 0 && query.trim() !== '' && (
        <div className="m-3 rounded-md border border-dashed border-edge bg-sunken">
          <EmptyState
            title={`No prompts match “${query.trim()}”`}
            action={
              <button type="button" className={btnGhost} onClick={() => setQuery('')}>
                Clear search
              </button>
            }
            className="py-6"
          >
            Search looks at codes and descriptions.
          </EmptyState>
        </div>
      )}
    </nav>
  );
}

function RailRow({ prompt: p }: { prompt: Prompt }) {
  const flow = usePromptsFlow();
  const active = flow.selected === p.code;
  const edited = unsavedChanges(p, flow.draftOf(p)) > 0;
  const uses = p.usedBySteps.length + p.usedBy.length;
  return (
    <li data-prompt={p.code}>
      <button
        type="button"
        onClick={() => flow.pick(p.code)}
        aria-current={active ? 'true' : undefined}
        className={`flex w-full flex-col gap-1 border-l-[3px] px-3 py-2.5 text-left transition-colors duration-150 ${active ? 'border-accent bg-accent-tint' : 'border-transparent hover:bg-raised'}`}
      >
        <span className={`truncate font-data text-[14.5px] text-ink ${active ? 'font-bold' : 'font-semibold'}`}>{p.code}</span>
        {p.description && <span className={`line-clamp-1 text-small ${active ? 'text-ink' : 'text-muted'}`}>{p.description}</span>}
        <span className="flex flex-wrap items-center gap-1.5">
          {p.category === 'fragment' ? (
            <Tag tone="fragment">fragment</Tag>
          ) : (
            <>
              <SourceBadge bundled={p.bundled} />
              <Tag tone={uses > 0 ? 'used' : 'bundled'}>{uses > 0 ? `used ×${uses}` : 'unused'}</Tag>
            </>
          )}
          {edited && <span className={quietTag}>Edited</span>}
        </span>
      </button>
    </li>
  );
}

function PromptPanel() {
  const flow = usePromptsFlow();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (flow.selected !== null && window.matchMedia?.(PANEL_BELOW_RAIL).matches) ref.current?.scrollIntoView({ block: 'start' });
  }, [flow.selected]);
  if (flow.selected !== null)
    return (
      <div ref={ref} className="scroll-mt-4">
        <PromptEditStep />
      </div>
    );
  return (
    <div className="rounded-lg border border-dashed border-edge bg-sunken">
      <EmptyState title="Pick a prompt from the list" className="py-12">
        Workflow steps name a prompt by code. Bundled prompts ship with Harmonic; edit one to save your own copy.
      </EmptyState>
    </div>
  );
}
