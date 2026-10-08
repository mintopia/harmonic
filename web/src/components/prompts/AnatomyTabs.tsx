import type { KeyboardEvent } from 'react';
import type { AnatomyId, PromptAnatomy } from '../../../../src/domain/prompt-anatomy.js';
import { ANATOMY_PANEL_ID, anatomyTabId } from './AnatomyStack';
import type { AnatomyCounts } from './prompts-tab-model';

export const ANATOMY_TABS_LABEL = 'Prompts the agent receives';

export function AnatomyTabs({
  items,
  active,
  orientation,
  onSelect,
}: {
  items: readonly { anatomy: PromptAnatomy; counts: AnatomyCounts }[];
  active: AnatomyId;
  orientation: 'vertical' | 'horizontal';
  onSelect: (id: AnatomyId) => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const ids = items.map((i) => i.anatomy.id);
    const at = ids.indexOf(active);
    let next = at;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (at + 1) % ids.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (at - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    else return;
    e.preventDefault();
    const id = ids[next];
    if (id === undefined) return;
    onSelect(id);
    e.currentTarget.querySelector<HTMLElement>(`#${anatomyTabId(id)}`)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ANATOMY_TABS_LABEL}
      aria-orientation={orientation}
      onKeyDown={onKeyDown}
      className={
        orientation === 'vertical'
          ? 'flex flex-col gap-1'
          : 'flex gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]'
      }
    >
      {items.map(({ anatomy: a, counts: c }) => {
        const selected = a.id === active;
        return (
          <button
            key={a.id}
            type="button"
            role="tab"
            id={anatomyTabId(a.id)}
            aria-selected={selected}
            aria-controls={ANATOMY_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(a.id)}
            className={`min-h-11 rounded-lg px-2.5 py-2 text-left transition-colors ${
              orientation === 'horizontal' ? 'shrink-0' : 'w-full'
            } ${selected ? 'bg-accent-tint' : 'hover:bg-raised'}`}
          >
            <span className={`block font-semibold ${selected ? 'text-accent' : 'text-ink'}`}>{a.title}</span>
            <span className="block text-small text-faint">
              {c.parts} {c.parts === 1 ? 'part' : 'parts'} · {c.modified} modified
              {c.errors > 0 && <span className="text-fail"> · {c.errors} {c.errors === 1 ? 'error' : 'errors'}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
