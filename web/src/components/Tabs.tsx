import { useEffect, useRef } from 'react';

export interface TabDef {
  id: string;
  label: string;
  count?: number;
}

export function Tabs({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: readonly TabDef[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    strip.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  return (
    <div ref={strip} role="tablist" aria-label={label} className="flex gap-x-5 overflow-x-auto border-b border-hairline">
      {tabs.map((tab, index) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`settings-tab-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            aria-selected={selected}
            aria-controls={`settings-panel-${tab.id}`}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
              else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = tabs.length - 1;
              else return;
              event.preventDefault();
              const target = tabs[next];
              if (!target) return;
              onChange(target.id);
              strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}
            className={`inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 focus-visible:outline-offset-[-2px] px-1 font-medium transition-colors duration-150 ${
              selected ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="rounded-full bg-raised px-[7px] text-[11px] font-bold text-muted">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
