import { useEffect, useMemo, useRef, useState } from 'react';
import { filterPrompts, unsavedChanges, usedByLabel, visiblePrompts } from '../../prompt-library-model';
import { btnGhost, btnPrimary, labelType, quietTag, searchField } from '../../ui';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { LoadError } from '../LoadError';
import { PromptEditStep } from './PromptEdit';
import { usePromptsFlow } from './PromptsFlow';
import { SourceBadge } from './SourceBadge';

const PANEL_BELOW_RAIL = '(max-width: 767px)';

export function PromptLibrary() {
  return (
    <div className="flex min-w-0 flex-col gap-5 md:flex-row md:items-start">
      <PromptRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <PromptPanel />
      </div>
    </div>
  );
}

function PromptRail() {
  const flow = usePromptsFlow();
  const [query, setQuery] = useState('');
  const all = useMemo(() => visiblePrompts(flow.prompts, flow.includeFragments), [flow.prompts, flow.includeFragments]);
  const shown = useMemo(() => filterPrompts(all, query), [all, query]);

  return (
    <nav aria-label="Prompts" className="flex min-w-0 flex-col gap-3 rounded-lg bg-surface p-3 shadow-card md:sticky md:top-4 md:w-80 md:shrink-0">
      <div className="flex items-center justify-between gap-2">
        <span className={`${labelType} text-muted`}>Prompts{flow.loaded ? ` · ${all.length}` : ''}</span>
        <button type="button" className={btnPrimary} onClick={flow.startNew}>
          + New prompt
        </button>
      </div>
      <label className="relative">
        <span className="sr-only">Search prompts</span>
        <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by code or description" className={`${searchField} w-full pl-8`} />
      </label>
      <label className="flex min-h-9 items-center gap-2 text-body text-muted">
        <input type="checkbox" checked={flow.includeFragments} onChange={(e) => flow.setIncludeFragments(e.target.checked)} className="accent-accent" />
        Include engine fragments
      </label>

      {flow.error && <LoadError message={flow.error} onRetry={flow.reload} />}
      {!flow.loaded && !flow.error && <p className="text-muted">Loading prompts…</p>}

      {shown.length > 0 && (
        <ul className="-mx-1 m-0 flex max-h-80 list-none flex-col gap-0.5 overflow-y-auto p-0 md:max-h-[70vh]">
          {shown.map((p) => {
            const active = flow.selected === p.code;
            const edited = unsavedChanges(p, flow.draftOf(p)) > 0;
            return (
              <li key={p.code} data-prompt={p.code}>
                <button
                  type="button"
                  onClick={() => flow.pick(p.code)}
                  aria-current={active ? 'true' : undefined}
                  className={`flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors duration-150 ${active ? 'bg-accent-tint' : 'hover:bg-raised'}`}
                >
                  <span className={`truncate font-data text-data text-ink ${active ? 'font-bold' : 'font-semibold'}`}>{p.code}</span>
                  {p.description && <span className={`line-clamp-2 text-small ${active ? 'text-ink' : 'text-muted'}`}>{p.description}</span>}
                  <span className="flex flex-wrap items-center gap-1.5">
                    <SourceBadge bundled={p.bundled} />
                    <span className={quietTag}>{usedByLabel(p)}</span>
                    {edited && <span className={quietTag}>Edited</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {flow.loaded && shown.length === 0 && query.trim() !== '' && (
        <div className="rounded-md border border-dashed border-edge bg-sunken">
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
