import type { ReactNode } from 'react';

/**
 * Pill switch (DESIGN.md § Components): the accent means "on", the knob
 * slides. Pass children for an inline label; pass `label` alone when a
 * field label already names the switch.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2 text-left text-ink disabled:opacity-50"
    >
      <span
        aria-hidden="true"
        className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-150 ${
          checked ? 'bg-accent' : 'bg-edge'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 size-3.5 rounded-full bg-white shadow-sm transition-transform duration-150 motion-reduce:transition-none ${
            checked ? 'translate-x-3.5' : ''
          }`}
        />
      </span>
      {children}
    </button>
  );
}
