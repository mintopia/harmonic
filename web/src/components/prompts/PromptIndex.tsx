import { useRef, type KeyboardEvent } from 'react';
import type { AnatomyId, PartKey, PromptAnatomy } from '../../../../src/domain/prompt-anatomy.js';
import { labelType, searchField } from '../../ui';
import { MessageList } from './MessageList';
import { Tag } from './PartCard';
import type { AnatomyCounts, SearchHit } from './prompts-tab-model';
import type { LayoutMode } from './use-layout-mode';

const WHERE_COPY: Record<SearchHit['where'], string> = { label: 'name', help: 'description', text: 'prompt text' };

export function PromptIndex({
  mode,
  items,
  totals,
  active,
  query,
  hits,
  onQuery,
  onSelect,
  onJump,
}: {
  mode: LayoutMode;
  items: readonly { anatomy: PromptAnatomy; counts: AnatomyCounts }[];
  totals: { modified: number; total: number };
  active: AnatomyId;
  query: string;
  hits: readonly SearchHit[];
  onQuery: (query: string) => void;
  onSelect: (id: AnatomyId) => void;
  onJump: (anatomy: AnatomyId, key: PartKey) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);
  const searching = query.trim() !== '';

  const clear = () => {
    onQuery('');
    inputRef.current?.focus();
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && query !== '') {
      e.preventDefault();
      clear();
    } else if (e.key === 'ArrowDown') {
      const first = resultsRef.current?.querySelector<HTMLElement>('button');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const onResultsKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      clear();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>('button')];
    const at = buttons.findIndex((b) => b === document.activeElement);
    e.preventDefault();
    if (e.key === 'ArrowUp' && at <= 0) inputRef.current?.focus();
    else buttons[Math.min(buttons.length - 1, e.key === 'ArrowDown' ? at + 1 : at - 1)]?.focus();
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className={mode === 'wide' ? 'flex flex-col gap-2' : 'flex flex-wrap items-center gap-2'}>
        <input
          ref={inputRef}
          type="search"
          aria-label="Search prompts and fragments"
          placeholder="Search prompts and fragments…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          className={`${searchField} min-w-0 ${mode === 'wide' ? 'w-full' : 'flex-1 basis-56'}`}
        />
        <div className="flex gap-1.5">
          <Tag tone="modified">{totals.modified} modified</Tag>
          <Tag tone="fragment">{totals.total} total</Tag>
        </div>
      </div>
      {searching && (
        <div>
          <p role="status" className="mb-1.5 px-1 text-small text-muted">
            {hits.length === 0 ? `Nothing matches “${query.trim()}”.` : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`}
          </p>
          <ul ref={resultsRef} aria-label="Search results" onKeyDown={onResultsKeyDown} className="m-0 flex list-none flex-col gap-0.5 p-0">
            {hits.map((hit) => (
              <li key={`${hit.anatomy}:${hit.key}`}>
                <button
                  type="button"
                  onClick={() => onJump(hit.anatomy, hit.key)}
                  className="block min-h-11 w-full rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-raised"
                >
                  <span className="block font-medium text-ink">
                    {hit.label} <span className="font-normal text-faint">· {hit.anatomyTitle}</span>
                  </span>
                  <span className="block text-small text-faint">matches {WHERE_COPY[hit.where]}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div hidden={searching}>
        {mode === 'wide' && <p className={`mb-1.5 px-2.5 ${labelType} text-faint`}>Prompts the agent receives</p>}
        <MessageList
          items={items}
          active={active}
          orientation={mode === 'wide' ? 'vertical' : 'horizontal'}
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}
