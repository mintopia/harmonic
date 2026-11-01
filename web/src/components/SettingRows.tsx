import type { ReactNode } from 'react';
import { card } from '../ui';

export function SettingGroup({ id, title, children, footer }: { id?: string; title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section id={id} className={`${card} px-5 pb-1.5 pt-4`}>
      <h3 className="mb-2.5 text-title font-semibold text-ink">{title}</h3>
      {children}
      {footer && <p className="border-t border-hairline py-3 text-small text-muted">{footer}</p>}
    </section>
  );
}

export function SettingRow({ title, description, children, wideControl = false }: { title: string; description: string; children: ReactNode; wideControl?: boolean }) {
  return (
    <div className={`grid grid-cols-1 items-center gap-x-6 gap-y-2 border-t border-hairline py-3.5 ${wideControl ? 'sm:grid-cols-[minmax(0,1fr)_420px]' : 'sm:grid-cols-[minmax(0,1fr)_220px]'}`}>
      <div>
        <div className="font-semibold text-ink">{title}</div>
        <p className="mt-0.5 text-small text-muted">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  description: string;
}

export function ChoiceCards<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="m-0 flex flex-wrap gap-3 border-0 p-0">
      <legend className="mb-2.5 text-label font-semibold uppercase text-muted">{legend}</legend>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <label
            key={option.value}
            className={`flex min-w-64 flex-1 cursor-pointer items-start gap-3 rounded-md p-3.5 ${
              selected ? 'border-2 border-accent bg-accent-tint p-[13px]' : 'border border-edge'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => onChange(option.value)}
              className="mt-1 accent-accent"
            />
            <span className="flex flex-col gap-1">
              <span className="font-semibold text-ink">{option.title}</span>
              <span className={`text-small ${selected ? 'text-ink' : 'text-muted'}`}>{option.description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
