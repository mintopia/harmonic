export interface ResolutionRule {
  caption: string;
  name: string;
  note: string;
  href?: string;
  always?: boolean;
  step?: string;
  tone?: 'fail';
}

export function ResolutionStrip({ rules, label, onStep }: { rules: readonly ResolutionRule[]; label: string; onStep?: (step: string) => void }) {
  return (
    <ol
      aria-label={label}
      className="m-0 grid list-none gap-2 p-0 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]"
    >
      {rules.map((rule) => {
        const external = !rule.always && !rule.href && !rule.step;
        const tone = rule.always
          ? 'border-2 border-accent bg-surface p-[11px]'
          : external
            ? 'border border-dashed border-edge-strong bg-sunken p-3'
            : 'border border-edge bg-surface p-3';
        return (
          <li key={rule.caption} className={`flex min-w-0 flex-col gap-1.5 rounded-md ${tone}`}>
            <span className={`text-micro font-bold uppercase tracking-wider ${rule.always ? 'text-accent' : 'text-muted'}`}>
              {rule.caption}
            </span>
            {rule.step ? (
              <button type="button" onClick={() => onStep?.(rule.step ?? '')} className="text-left font-bold text-ink hover:text-accent hover:underline">
                {rule.name}
              </button>
            ) : rule.href ? (
              <a
                href={rule.href}
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById(rule.href?.slice(1) ?? '')?.scrollIntoView({ block: 'start' });
                }}
                className="font-semibold text-ink hover:underline"
              >
                {rule.name}
              </a>
            ) : (
              <span className="font-bold text-ink">{rule.name}</span>
            )}
            <span className={`text-small ${rule.tone === 'fail' ? 'font-semibold text-fail' : rule.href || rule.step || rule.always ? 'font-semibold text-accent' : 'text-muted'}`}>{rule.note}</span>
          </li>
        );
      })}
    </ol>
  );
}
