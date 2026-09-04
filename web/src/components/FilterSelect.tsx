import { useEffect, useRef, useState } from 'react';
import { selectField } from '../ui';
import { Icon } from './Icon';

/**
 * A compact multi-select filter for the Tasks toolbar: a `selectField`-styled
 * trigger opens a checkbox popover, so an operator can narrow the list to any
 * combination of values (empty ⇒ "all"). The popover closes on an outside
 * click or Escape. `capitalize` renders lowercase stored values (states,
 * priorities) with a leading capital without mutating the underlying value.
 */
export function FilterSelect({
  label,
  allLabel,
  options,
  selected,
  onChange,
  capitalize,
}: {
  /** Singular filter name for the multi-count summary, e.g. `State`. */
  label: string;
  /** The "nothing selected" summary, e.g. `All states`. */
  allLabel: string;
  options: readonly string[];
  selected: string[];
  onChange: (next: string[]) => void;
  capitalize?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);

  const summary =
    selected.length === 0 ? allLabel : selected.length === 1 ? selected[0]! : `${label} · ${selected.length}`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`${selectField} inline-flex items-center gap-1.5 ${capitalize && selected.length <= 1 ? 'capitalize' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        {summary}
        <Icon name="chevron-down" className="size-3.5 text-muted" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={`Filter by ${label.toLowerCase()}`}
          className="absolute right-0 z-20 mt-1 min-w-full whitespace-nowrap rounded-md border border-edge bg-surface p-1 shadow-card"
        >
          {options.map((o) => {
            const on = selected.includes(o);
            return (
              <button
                key={o}
                type="button"
                role="option"
                aria-selected={on}
                className={`flex min-h-11 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-ink hover:bg-raised ${capitalize ? 'capitalize' : ''}`}
                onClick={() => toggle(o)}
              >
                <Icon name="check" className={`size-3.5 text-accent ${on ? '' : 'opacity-0'}`} />
                {o}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
