import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { field } from '../ui';
import { Icon } from './Icon';
import { filterModels } from './modelFilter';

export function ModelCombobox({
  id,
  value,
  onChange,
  options,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();

  const shown = filterModels(options, value);
  const custom = value.trim() !== '' && shown.length === 0;
  const panelOpen = open && (shown.length > 0 || custom);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => {
    if (highlight >= 0) {
      document.getElementById(`${listId}-opt-${highlight}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight, listId]);

  const openList = () => {
    setOpen(true);
    setHighlight(-1);
  };

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
    setHighlight(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      setHighlight((h) => Math.min(h + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (panelOpen) {
        e.preventDefault();
        if (highlight >= 0 && highlight < shown.length) commit(shown[highlight]!);
        else setOpen(false);
      }
    } else if (e.key === 'Escape') {
      // Swallow Escape so the surrounding <dialog> stays open.
      if (panelOpen) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    }
  };

  return (
    <div ref={wrap} className="relative">
      <input
        id={id}
        role="combobox"
        aria-expanded={panelOpen}
        aria-controls={panelOpen ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={highlight >= 0 ? `${listId}-opt-${highlight}` : undefined}
        className={`${field} pr-8`}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onFocus={openList}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!wrap.current?.contains(e.relatedTarget as Node)) setOpen(false);
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? 'Hide models' : 'Show models'}
        className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted transition-colors duration-150 hover:text-ink"
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <Icon
          name="chevron-down"
          className={`transition-transform duration-150 ${open ? 'rotate-0' : '-rotate-90'}`}
        />
      </button>

      {panelOpen && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md bg-surface py-1 shadow-bar"
        >
          {shown.map((m, i) => (
            <li
              key={m}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={m === value}
              className={`flex cursor-pointer items-center justify-between px-2.5 py-1.5 text-data ${
                i === highlight ? 'bg-raised' : ''
              }`}
              onPointerDown={(e) => {
                e.preventDefault();
                commit(m);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              <span>{m}</span>
              {m === value && <Icon name="check" className="text-accent" />}
            </li>
          ))}
          {custom && (
            <li role="presentation" className="px-2.5 py-1.5 text-data text-muted">
              Use custom ID: <span className="font-medium text-ink">{value}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
