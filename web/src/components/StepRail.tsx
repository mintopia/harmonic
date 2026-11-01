import type { StepDef } from '../settings-steps-model';

export const stepPanelId = (id: string): string => `settings-step-${id}`;

export function StepRail({
  steps,
  current,
  onSelect,
  label,
  values,
}: {
  steps: readonly StepDef[];
  current: string;
  onSelect: (id: string) => void;
  label: string;
  values?: Readonly<Record<string, string | undefined>>;
}) {
  const currentIndex = steps.findIndex((step) => step.id === current);
  return (
    <nav aria-label={label} className="flex min-w-0 flex-col gap-1 md:sticky md:top-4 md:w-60 md:shrink-0 md:self-start">
      <div className="px-3 pb-2 text-micro font-bold uppercase tracking-wider text-muted">{label}</div>
      {steps.map((step, index) => {
        const active = step.id === current;
        const done = index < currentIndex;
        const value = done ? values?.[step.id] : undefined;
        return (
          <button
            key={step.id}
            type="button"
            aria-current={active ? 'step' : undefined}
            onClick={() => onSelect(step.id)}
            className={`flex min-h-11 items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors duration-150 ${
              active ? 'bg-surface shadow-card' : 'hover:bg-raised'
            }`}
          >
            <span
              aria-hidden="true"
              className={`grid size-6 shrink-0 place-items-center rounded-full text-small font-semibold ${
                active
                  ? 'bg-accent text-on-accent'
                  : done
                    ? 'bg-done text-on-done'
                    : 'border border-edge-strong text-muted'
              }`}
            >
              {done ? '✓' : index + 1}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-ink">{step.title}</span>
              <span className={`text-small ${done && value ? 'font-semibold text-done' : 'font-medium text-muted'}`}>
                {value ?? step.summary}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
